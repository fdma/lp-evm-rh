// СВОЙ МАРШРУТ НА ЖИВОЙ СЕТИ.
//
// Сборку свапа проверяет swap-calldata.test.js — разбором по смещениям, без
// сети. Здесь другое: отвечает ли цепочка так, как мы предполагаем.
//
// Проверяется ровно то, от чего зависит отправка денег:
//   1. Quoter развёрнут и указывает на ТОТ ЖЕ PoolManager, что и остальные
//      контракты терминала — та же сверка, которой ядро проверяет
//      PositionManager и StateView;
//   2. UniversalRouter развёрнут — без него свап не отправить;
//   3. перебор пулов находит живой и даёт ненулевую котировку;
//   4. пул без ликвидности отвечает отказом, а не нулём и не молчанием.
//
// Публичный узел Robinhood режет частые запросы и после двух десятков
// котировок закрывается Cloudflare. Поэтому свой узел в RH_RPC — тогда
// проверяется всё; без него берём публичный и мягко пропускаем то, до чего он
// не дал дозвониться.
//
//   RH_RPC=https://…  node --test tests/swap-live.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');

const CHAINS = [
  { name: 'robinhood', env: 'RH_RPC',
    token: '0x022c90ed10c2172bb9b2d54838bbe5d0827c4af1',
    quote: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    amount: 113000n * 10n ** 18n },
  { name: 'bsc', env: 'BSC_RPC' },
];

for (const c of CHAINS) {
  test(`${c.name}: Quoter и роутер на месте и от того же PoolManager`, async (t) => {
    C.useChain(c.name);
    const rpc = C.makeRpc(process.env[c.env] || C.RH.publicRpc);

    assert.match(C.RH.quoter, /^0x[0-9a-fA-F]{40}$/, 'адрес Quoter задан');
    assert.match(C.RH.universalRouter, /^0x[0-9a-fA-F]{40}$/, 'адрес роутера задан');

    let qCode, rCode;
    try {
      qCode = await rpc('eth_getCode', [C.RH.quoter, 'latest']);
      rCode = await rpc('eth_getCode', [C.RH.universalRouter, 'latest']);
    } catch (e) { t.skip('узел недоступен: ' + e.message.slice(0, 60)); return; }

    assert.ok(qCode && qCode.length > 4, 'у Quoter должен быть код');
    assert.ok(rCode && rCode.length > 4, 'у роутера должен быть код');

    // Самая важная строчка теста. Quoter, указывающий на ЧУЖОЙ PoolManager,
    // считал бы по чужим пулам — и цифры выглядели бы правдоподобно.
    const pm = '0x' + C.stripHex(await C.ethCall(rpc, C.RH.quoter, C.SEL.poolManager)).slice(-40);
    assert.strictEqual(pm.toLowerCase(), C.RH.poolManager.toLowerCase(),
      'Quoter обязан смотреть в тот же PoolManager, что и весь терминал');
    console.log(`  ${C.RH.label}: Quoter ${(qCode.length - 2) / 2} байт, ` +
                `роутер ${(rCode.length - 2) / 2} байт, PoolManager сходится`);
  });
}

test('robinhood: перебор пулов находит живой и котирует его', async (t) => {
  C.useChain('robinhood');
  const c = CHAINS[0];
  // ТА ЖЕ РАЗВИЛКА, ЧТО В САМОМ ТЕРМИНАЛЕ, И ПО ТОЙ ЖЕ ПРИЧИНЕ.
  //
  // Журнал читаем ПУБЛИЧНЫМ узлом: Alchemy на бесплатном тарифе eth_getLogs
  // не отдаёт вовсе, и свой быстрый узел здесь бесполезен. А котировки —
  // наоборот своим: их два десятка подряд, и публичный на таком закрывается
  // Cloudflare. Ровно так и устроен logsRpc() в ui.js.
  const own = process.env[c.env];
  const calls = C.makeRpc(own || C.RH.publicRpc);
  const logs = C.makeRpc(C.RH.publicRpc);

  let pools = [];
  try {
    const latest = Number(BigInt(await calls('eth_blockNumber', [])));
    pools = await C.poolsOfToken(logs, c.token, latest);
    if (!pools.length && own) pools = await C.poolsOfToken(calls, c.token, latest);
  } catch (e) { t.skip('журнал недоступен: ' + e.message.slice(0, 60)); return; }
  if (!pools.length) { t.skip('ни один узел не отдал пулы'); return; }
  const rpc = calls;

  const pair = pools.filter(p => {
    const a = p.currency0.toLowerCase(), b = p.currency1.toLowerCase();
    return a === c.quote.toLowerCase() || b === c.quote.toLowerCase();
  });
  assert.ok(pair.length, 'хотя бы один прямой пул должен найтись');

  let r;
  try { r = await C.pickBestSwap(rpc, pair, c.token, c.amount); }
  catch (e) { t.skip('котировки не прошли: ' + e.message.slice(0, 60)); return; }

  if (!r.live) {
    // Без своего узла это обычное дело: публичный закрывается на полпути.
    t.skip(`ни один из ${r.tried} пулов не откотировался` +
           (own ? '' : ' — попробуй со своим узлом в RH_RPC'));
    return;
  }
  assert.ok(r.best.out > 0n, 'у лучшего пула выход обязан быть больше нуля');
  console.log(`  прямых пулов ${pair.length}, откотировалось ${r.live}, ` +
              `лучший даёт ${(Number(r.best.out) / 1e6).toFixed(4)} USDG ` +
              `(комиссия ${(r.best.pool.fee / 10000).toFixed(3)}%)`);

  // Сборка от настоящей котировки обязана собраться и быть выровненной.
  const plan = await C.planSwap(rpc, {
    pools: pair, coin: c.token, amountIn: c.amount,
    slippageBps: 500, deadline: Math.floor(Date.now() / 1000) + 300,
  });
  assert.strictEqual(plan.to.toLowerCase(), C.RH.universalRouter.toLowerCase());
  assert.ok(plan.minOut < plan.amountOut, 'минимум обязан быть ниже котировки');
  assert.ok(plan.minOut > plan.amountOut * 90n / 100n, 'но не вдвое ниже — это 5%');
  assert.strictEqual((plan.data.length - 10) % 64, 0, 'calldata выровнена по словам');
});

test('пул без ликвидности отвечает отказом, а не выдуманным числом', async (t) => {
  C.useChain('robinhood');
  const rpc = C.makeRpc(process.env.RH_RPC || C.RH.publicRpc);
  // Пул, которого нет: ключ собран из настоящих монет, но с шагом и
  // комиссией, под которые пул не создавали.
  const fake = {
    currency0: '0x022c90ed10c2172bb9b2d54838bbe5d0827c4af1',
    currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    fee: 1234, tickSpacing: 7, hooks: '0x' + '0'.repeat(40),
  };
  try {
    const q = await C.quoteSwapSingle(rpc, fake, true, 10n ** 18n);
    // Если вдруг ответил — то обязан ответить нулём, а не числом.
    assert.strictEqual(q.amountOut, 0n, 'несуществующий пул не может дать выход');
  } catch (e) {
    if (/DOCTYPE|fetch failed/i.test(e.message)) { t.skip('узел недоступен'); return; }
    assert.match(e.message, /revert|Quoter/i, 'отказ должен быть внятным');
    console.log('  несуществующий пул отказал, как и должен');
  }
});

// ── УЗЛОВЫЕ ПУЛЫ И ПУТЬ ЧЕРЕЗ НАТИВНУЮ МОНЕТУ ──────────────────────────────
//
// Ради этого пути всё и делалось. Замер на живой CHUMP: тринадцать прямых
// пулов с USDG, все дешёвые пустые, деньги только в пулах с комиссией 20–95%.
// Прямая продажа отдавала 0.83 доллара вместо пятнадцати, путь через нативную
// монету — больше тринадцати. Разница в шестнадцать раз.
test('узловые пулы нативная/стейбл находятся вычислением ключа', async (t) => {
  C.useChain('robinhood');
  const rpc = C.makeRpc(process.env.RH_RPC || C.RH.publicRpc);
  const K = require('../src/keccak.js');
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const NATIVE = '0x' + '0'.repeat(40);

  let hub;
  try { hub = await C.findPoolsByKey(rpc, NATIVE, USDG, K.keccak256); }
  catch (e) { t.skip('узел недоступен: ' + e.message.slice(0, 60)); return; }

  // Журналом их не найти вовсе — у стейбла пулов слишком много, узел отдаёт
  // пустой ответ. Если вычисление ключа перестанет работать, здесь будет ноль,
  // и двухшаговый маршрут молча исчезнет.
  if (!hub.length) { t.skip('узел не ответил на пробы ключей'); return; }
  assert.ok(hub.every(h => h.liquidity > 0n), 'пустые пулы не должны попадать в узловые');
  assert.ok(hub.every(h => /^0x[0-9a-f]{64}$/.test(h.poolId)), 'ключ — 32 байта');
  console.log(`  узловых ETH/USDG: ${hub.length}, дешевейший ` +
              `${(Math.min(...hub.map(h => h.fee)) / 10000).toFixed(3)}%`);
});

test('CHUMP: путь через нативную монету выбирается вместо прямого', async (t) => {
  C.useChain('robinhood');
  const own = process.env.RH_RPC;
  const calls = C.makeRpc(own || C.RH.publicRpc);
  const logs = C.makeRpc(C.RH.publicRpc);
  const K = require('../src/keccak.js');
  const CHUMP = '0x0e0d2c89a5a019fe1cf762e5e33187631dacc21b';
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

  let pools = [], dec = 18;
  try {
    const latest = Number(BigInt(await calls('eth_blockNumber', [])));
    pools = await C.poolsOfToken(logs, CHUMP, latest);
    if (!pools.length && own) pools = await C.poolsOfToken(calls, CHUMP, latest);
    dec = Number(BigInt(await C.ethCall(calls, CHUMP, C.SEL.decimals)));
  } catch (e) { t.skip('узел недоступен: ' + e.message.slice(0, 60)); return; }
  if (!pools.length) { t.skip('ни один узел не отдал пулы'); return; }

  const amountIn = BigInt(Math.floor(15 / 0.0474 * Math.pow(10, dec)));   // ~$15
  let plan;
  try {
    plan = await C.planSwap(calls, {
      pools, coin: CHUMP, stable: USDG, amountIn,
      slippageBps: 500, deadline: Math.floor(Date.now() / 1000) + 300,
      keccak256: K.keccak256,
    });
  } catch (e) { t.skip('маршрут не сложился: ' + e.message.slice(0, 70)); return; }

  assert.strictEqual(plan.hops, 2, 'у CHUMP прямой пул мусорный — путь обязан быть через нативную');
  assert.ok(plan.betterThanDirect > 5,
    `путь через нативную обязан быть кратно выгоднее прямого, вышло ${plan.betterThanDirect}`);
  assert.ok(plan.minOut < plan.amountOut && plan.minOut > plan.amountOut * 90n / 100n);
  assert.strictEqual((plan.data.length - 10) % 64, 0, 'calldata выровнена');
  console.log(`  CHUMP: ${plan.route}, дадут ${(Number(plan.amountOut) / 1e6).toFixed(4)} USDG ` +
              `— в ${plan.betterThanDirect.toFixed(1)} раза больше прямого`);
});
