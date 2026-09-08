// Проверка ядра на ЖИВОЙ сети BSC. Только чтение, ничего не подписывается.
// Запуск: node tests/live-bsc.test.js
const C = require('../src/core.js');
C.useChain('bsc');   // терминал теперь двухсетевой, тест выбирает сеть сам
const { execFileSync } = require('child_process');

function keccak256(hexInput) {
  const out = execFileSync('/home/claude/venv/bin/python', ['-c', `
import sys
from Crypto.Hash import keccak
h=keccak.new(digest_bits=256); h.update(bytes.fromhex(sys.argv[1]))
print('0x'+h.hexdigest())`, C.stripHex(hexInput)], { encoding: 'utf8' });
  return out.trim();
}

// Публичные узлы BSC живут под нагрузкой и отвечают отказом на ровном месте.
// Тест, который краснеет из-за чужого трафика, учит не смотреть на красное.
const sleep = ms => new Promise(r => setTimeout(r, ms));
function retrying(rpc) {
  return async (m, p) => {
    let last = null;
    for (let i = 0; i < 4; i++) {
      try { return await rpc(m, p); }
      catch (e) {
        last = e;
        if (!/too many|rate|429|limit|timeout|fetch failed/i.test(e.message || '')) throw e;
        await sleep(1500 * (i + 1));
      }
    }
    throw last;
  };
}

// Пул BREW/USDT с комиссией 1% — один из тех, ради которых всё и затевалось.
const POOL = '0x12cfff519363c36d6dfa1361decd1a5bcc851857530f507b92a5b75bdee4b549';

(async () => {
  const rpc = retrying(C.makeRpc(C.RH.publicRpc));
  let bad = 0;
  const fail = (m) => { console.log('  ПРОВАЛ: ' + m); bad++; process.exitCode = 1; };
  const ok = (m) => console.log('  ок: ' + m);
  const skip = (m) => console.log('  пропуск: ' + m);

  const chain = await C.assertChain(rpc);
  chain === 56 ? ok(`сеть ${chain}`) : fail(`сеть ${chain}, а нужна 56`);

  const sizes = await C.assertContracts(rpc);
  ok(`контракты на месте: ${Object.entries(sizes).map(([k, v]) => k + ' ' + v).join(', ')}`);

  // Оба вспомогательных контракта обязаны указывать на ТОТ ЖЕ singleton.
  // Иначе мы читаем состояние одного пула, а транзакцию шлём в другой.
  for (const [name, addr] of [['positionManager', C.RH.positionManager],
                              ['stateView', C.RH.stateView]]) {
    const r = await rpc('eth_call', [{ to: addr, data: C.SEL.poolManager }, 'latest']);
    const got = '0x' + r.slice(26).toLowerCase();
    got === C.RH.poolManager ? ok(`${name} смотрит на наш PoolManager`)
                             : fail(`${name} смотрит на ${got}`);
  }

  const key = await C.loadPool(rpc, POOL, keccak256);
  key.poolIdOk ? ok('PoolId пересчитан из ключа и совпал') : fail('PoolId НЕ совпал');

  // Символы ядро не читает — это дело интерфейса. Тесту они нужны, чтобы
  // проверить разрядность денежной стороны, поэтому читаем сами.
  const symbolOf = async (a) => {
    if (/^0x0{40}$/i.test(a)) return 'BNB';
    try {
      const r = await rpc('eth_call', [{ to: a, data: C.SEL.symbol }, 'latest']);
      const b = r.slice(2);
      const len = parseInt(b.slice(64, 128), 16);
      let out = '';
      for (let i = 0; i < len; i++) out += String.fromCharCode(parseInt(b.substr(128 + i * 2, 2), 16));
      return out || '?';
    } catch (e) { return '?'; }
  };
  const sym0 = await symbolOf(key.currency0), sym1 = await symbolOf(key.currency1);
  ok(`пара ${sym0}/${sym1}, комиссия ${key.fee / 10000}%, шаг ${key.tickSpacing}`);

  // Разрядность денежной стороны. На BSC у USDT их 18, а не 6, как у USDG,
  // и перепутать здесь значит ошибиться в цене в триллион раз.
  const dec = async a => Number(BigInt(await rpc('eth_call',
    [{ to: a, data: C.SEL.decimals }, 'latest'])));
  const usdt = /usdt/i.test(sym0) ? key.currency0
             : (/usdt/i.test(sym1) ? key.currency1 : null);
  if (usdt) {
    const d = await dec(usdt);
    d === 18 ? ok('у USDT на BSC 18 знаков — как и ожидали')
             : fail(`у USDT ${d} знаков, ядро считало бы цену мимо`);
  } else skip('USDT в этой паре нет');

  const s0 = await C.readSlot0(rpc, POOL);
  if (!s0.sqrtPriceX96 || s0.sqrtPriceX96 === 0n) fail('цена пула нулевая');
  else ok(`тик ${s0.tick}, sqrtPriceX96 ${s0.sqrtPriceX96}`);

  // Наша математика тиков против цены, которую отдала сеть.
  const mine = C.getSqrtRatioAtTick(s0.tick);
  const diff = mine > s0.sqrtPriceX96 ? mine - s0.sqrtPriceX96 : s0.sqrtPriceX96 - mine;
  const rel = Number(diff * 1000000n / s0.sqrtPriceX96) / 1000000;
  rel < 0.0002 ? ok(`TickMath сходится с сетью (расхождение ${(rel * 100).toFixed(5)}%)`)
               : fail(`TickMath разошёлся на ${(rel * 100).toFixed(4)}%`);

  // ГЛАВНОЕ: платит ли пул на самом деле. Молчание узла — это «не знаю»,
  // а не «не платит», и тест обязан различать эти два случая.
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const f = await C.poolFeeReality(rpc, POOL, latest);
  if (f.pays === null) skip(`комиссию замерить не вышло: ${f.why}`);
  else if (!f.pays) fail(`пул НЕ платит: ${f.why}`);
  else {
    ok(`замер по ${f.swaps} обменам: ${(f.median / 10000).toFixed(3)}%`);
    // Замер должен сойтись с тем, что объявлено в ключе пула.
    const declared = key.fee === 0x800000 ? null : key.fee;
    if (declared != null) {
      const off = Math.abs(f.median - declared) / declared;
      off < 0.35 ? ok(`совпало с объявленной комиссией ${(declared / 10000).toFixed(3)}%`)
                 : fail(`замер ${f.median} против объявленных ${declared}`);
    } else skip('комиссия пула плавающая, сверять не с чем');
  }

  console.log(bad ? `\nитог: ${bad} провал(ов)` : '\nитог: ядро читает BSC верно');
})().catch(e => { console.log('  ОШИБКА: ' + e.message); process.exitCode = 1; });
