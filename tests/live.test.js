// Проверка ядра на ЖИВОЙ сети и сверка с независимым расчётом.
// Запуск: node tests/live.test.js
const C = require('../src/core.js');
C.useChain('robinhood');   // ядро стало двухсетевым — выбираем явно
const { createHash } = require('crypto');

// keccak256 берём из внешней утилиты, чтобы не тащить зависимость в браузер:
// в тестах достаточно вызвать python с pycryptodome.
const { execFileSync } = require('child_process');
function keccak256(hexInput) {
  const out = execFileSync('/home/claude/venv/bin/python', ['-c', `
import sys
from Crypto.Hash import keccak
h=keccak.new(digest_bits=256); h.update(bytes.fromhex(sys.argv[1]))
print('0x'+h.hexdigest())`, C.stripHex(hexInput)], { encoding: 'utf8' });
  return out.trim();
}

(async () => {
  const rpc = C.makeRpc(C.RH.publicRpc);
  const fail = (m) => { console.log('  ПРОВАЛ: ' + m); process.exitCode = 1; };
  const ok = (m) => console.log('  ок: ' + m);

  const chain = await C.assertChain(rpc);
  ok(`сеть ${chain}`);
  const sizes = await C.assertContracts(rpc);
  ok(`контракты на месте: ${Object.entries(sizes).map(([k,v])=>k+' '+v).join(', ')}`);

  // пул из настоящей позиции автора
  const poolId = '0xa6ef908585525ed3df7eea8735744af0586a14d1f7dd0378adf84b5b076ea9ba';
  const key = await C.loadPool(rpc, poolId, keccak256);
  key.poolIdOk ? ok('PoolId пересчитан и совпал') : fail('PoolId НЕ совпал');
  key.hooksEmpty ? ok('hooks пустые') : fail('есть hooks');
  ok(`комиссия ${key.fee/10000}%, шаг ${key.tickSpacing}`);
  if (key.tickSpacing !== 500) fail(`шаг ${key.tickSpacing}, ожидался 500`);

  const s0 = await C.readSlot0(rpc, poolId);
  ok(`тик ${s0.tick}, sqrtPriceX96 ${s0.sqrtPriceX96}`);

  // ГЛАВНАЯ СВЕРКА: наша реализация TickMath против цены из сети.
  const mine = C.getSqrtRatioAtTick(s0.tick);
  const diff = Number(
    (mine > s0.sqrtPriceX96 ? mine - s0.sqrtPriceX96 : s0.sqrtPriceX96 - mine)
    * 1000000n / s0.sqrtPriceX96) / 10000;
  console.log(`  наш sqrt для тика ${s0.tick}: ${mine}`);
  diff < 0.02 ? ok(`расхождение с сетью ${diff.toFixed(4)}% — в пределах одного тика`)
              : fail(`расхождение ${diff}%`);

  // Монотонность и границы
  if (C.getSqrtRatioAtTick(0) !== 79228162514264337593543950336n) fail('тик 0 неверен');
  else ok('тик 0 даёт ровно 2^96');
  // t-1 должен оставаться в допустимых границах — иначе это ошибка теста,
  // а не ядра. На первом прогоне я на этом и споткнулся.
  for (const t of [-887271, -100000, -1, 1, 100000, 887272]) {
    if (C.getSqrtRatioAtTick(t) <= C.getSqrtRatioAtTick(t - 1)) fail(`не монотонно на ${t}`);
  }
  ok('монотонность на всём диапазоне');
  // и края обязаны приниматься
  C.getSqrtRatioAtTick(C.MIN_TICK); C.getSqrtRatioAtTick(C.MAX_TICK);
  ok('края диапазона принимаются');
  let refused = false;
  try { C.getSqrtRatioAtTick(C.MAX_TICK + 1); } catch (e) { refused = true; }
  refused ? ok('за краем — отказ') : fail('за краем НЕ отказал');

  // Диапазон в ступеньках
  for (const [w,g] of [[30,3],[30,5],[50,10],[15,1]]) {
    const q = C.planRange({ tick: s0.tick, tickSpacing: key.tickSpacing,
                            widthPct: w, gapPct: g, side: 'down' });
    console.log(`  вниз ${w}%/${g}% → отступ ${q.gapReal.toFixed(2)}%, ширина ${q.widthReal.toFixed(2)}%`);
    if (!(q.gapReal <= -g + 0.01)) fail(`отступ ${q.gapReal} меньше запрошенных ${g}%`);
    if (!q.oneSided) fail('не односторонняя');
    const u = C.planRange({ tick: s0.tick, tickSpacing: key.tickSpacing,
                            widthPct: w, gapPct: g, side: 'up' });
    if (!(u.gapReal >= g - 0.01)) fail(`вверх: отступ ${u.gapReal} меньше ${g}%`);
    if (!u.oneSided) fail('вверх: не односторонняя');
  }
  ok('обе стороны: отступ не меньше запрошенного, позиция односторонняя');
  const p = C.planRange({ tick: s0.tick, tickSpacing: key.tickSpacing,
                          widthPct: 30, gapPct: 3, side: 'down' });
  console.log(`  просили 30% и 3% → отступ ${p.gapReal.toFixed(2)}%, ` +
              `ширина ${p.widthReal.toFixed(2)}%, минимум ${p.minGap.toFixed(2)}%`);
  p.oneSided ? ok('позиция односторонняя') : fail('НЕ односторонняя');
  (p.tickUpper % key.tickSpacing === 0 && p.tickLower % key.tickSpacing === 0)
    ? ok('обе границы кратны шагу') : fail('границы не кратны шагу');
  // Здесь у меня было неверное утверждение: будто отступ обязан быть не
  // меньше целой ступеньки. Это не так. minGap — ступенька в ХУДШЕМ случае;
  // насколько близко к цене встанет ближайший кратный тик, зависит от того,
  // где внутри ступеньки стоит текущий тик. Отступ 3.02% при ступеньке 4.88%
  // не ошибка, а удача выравнивания.
  //
  // Важно на самом деле другое: отступ не меньше ЗАПРОШЕННОГО и верхняя
  // граница строго ниже цены — иначе позиция перестанет быть односторонней.
  (Math.abs(p.gapReal) >= 3 - 0.01)
    ? ok('отступ не меньше запрошенного') : fail(`отступ ${p.gapReal} меньше 3%`);
  (p.tickUpper < s0.tick)
    ? ok('верхняя граница строго ниже цены') : fail('граница не ниже цены');

  // Нулевой отступ должен быть невозможен
  const tiny = C.planRange({ tick: s0.tick, tickSpacing: key.tickSpacing,
                             widthPct: 30, gapPct: 0.01, side: 'down' });
  tiny.tickUpper < s0.tick ? ok('даже при отступе 0.01% верх ушёл под цену')
                           : fail('верх не ушёл под цену');
  console.log('\nитог: ' + (process.exitCode ? 'ЕСТЬ ПРОВАЛЫ' : 'все проверки пройдены'));
})().catch(e => { console.log('СБОЙ: ' + e.message); process.exitCode = 1; });
