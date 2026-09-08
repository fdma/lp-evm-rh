// ПЛАТИТ ЛИ ПУЛ — проверка на живой сети.
//
// Появилась после реального убытка: автор простоял в USDG/PIXELCAT и
// получил ноль комиссий, потеряв на движении цены сто долларов. Терминал
// показывал «комиссия 0.00%» и вердикт «годен».
//
// Запуск: node --test tests/fees.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');
C.useChain('robinhood');   // ядро стало двухсетевым — выбираем явно

// Общий узел иногда отвечает «Too Many Requests» на ровном месте — чаще всего
// потому, что в этот момент по нему работает что-то ещё моё. Тест, который
// краснеет от чужой нагрузки, ничего не проверяет и приучает не смотреть на
// красное. Поэтому чтения повторяем.
const _raw = C.makeRpc(C.RH.publicRpc);
const _sleep = ms => new Promise(r => setTimeout(r, ms));
const rpc = async (m, p) => {
  let last = null;
  for (let i = 0; i < 4; i++) {
    try { return await _raw(m, p); }
    catch (e) {
      last = e;
      if (!/too many|rate|429|internal server err|timeout|fetch failed/i.test(e.message || '')) throw e;
      await _sleep(1200 * (i + 1));
    }
  }
  throw last;
};

// Пул, который стоил денег: статическая комиссия 0, хук с правом забирать
// часть обмена. Замерено: 63 обмена подряд с нулевой комиссией.
const POOL_PAYS_NOTHING =
  '0x602e9cbdf8a444675d72165b217db5e90098fea387af8df806f02c6416ac39a9';

test('пул с нулевой комиссией распознаётся как «не платит»', async () => {
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const r = await C.poolFeeReality(rpc, POOL_PAYS_NOTHING, latest, 20000);
  console.log(`  обменов ${r.swaps}, максимальная применённая комиссия ${r.maxFee}`);
  // Если обменов вдруг не было — судить не о чем, и это НЕ «платит».
  assert.notStrictEqual(r.pays, true, 'пул не должен считаться платящим');
  if (r.swaps > 0) {
    assert.strictEqual(r.pays, false);
    assert.strictEqual(r.maxFee, 0, 'все обмены обязаны быть с нулевой комиссией');
  }
});

test('хук этого пула помечен как забирающий часть обмена', async () => {
  const key = await C.loadPool(rpc, POOL_PAYS_NOTHING, require('../src/keccak.js').keccak256);
  assert.strictEqual(key.fee, 0, 'в ключе должна стоять нулевая комиссия');
  assert.strictEqual(key.hook.takesSwapCut, true);
  // При этом хук БЕЗ прав на ликвидность: старая проверка его пропускала,
  // и она была права по своему предмету — деньги он удержать не может.
  assert.strictEqual(key.hook.allowed, true);
});

// Предел ответа проверяем на ПОДДЕЛЬНОМ узле, а не на живом.
//
// Первая версия этой проверки ходила в сеть, и она развалилась не потому, что
// код неверен, а потому что настоящий узел к тому моменту начал отвечать
// «Too Many Requests» на всё подряд. Проверка, зависящая от настроения общего
// узла, не проверяет мой код — она меряет чужую нагрузку.
test('запрос журнала делится, когда узел упирается в предел ответа', async () => {
  const CAP = 10000, PER_BLOCK = 3;         // 3333 блока — уже предел
  let calls = 0;
  const fake = async (method, [q]) => {
    calls++;
    const from = Number(BigInt(q.fromBlock)), to = Number(BigInt(q.toBlock));
    const n = (to - from + 1) * PER_BLOCK;
    if (n > CAP) throw new Error('eth_getLogs: logs matched by query exceeds limit of 10000');
    const out = [];
    for (let b = from; b <= to; b++) {
      for (let i = 0; i < PER_BLOCK; i++) out.push({ blockNumber: '0x' + b.toString(16) });
    }
    return out;
  };
  const logs = await C.getLogsSplit(fake, {}, 0, 19999);
  console.log(`  собрано ${logs.length} событий за ${calls} запрос(ов)`);
  assert.strictEqual(logs.length, 20000 * PER_BLOCK, 'ни одно событие не потеряно');

  // Порядок обязан остаться возрастающим: на нём стоит выбор ПОСЛЕДНЕГО
  // события в priceAtBlock, а значит и цена входа.
  let prev = -1;
  for (const l of logs) {
    const b = Number(BigInt(l.blockNumber));
    assert.ok(b >= prev, 'события должны идти по возрастанию блока');
    prev = b;
  }
});

test('деление имеет потолок по числу запросов', async () => {
  // Узел, который отказывает всегда: без потолка деление ушло бы в сотни
  // запросов и превратилось бы в обстрел общего узла.
  let calls = 0;
  const always = async () => {
    calls++;
    throw new Error('eth_getLogs: logs matched by query exceeds limit of 10000');
  };
  await assert.rejects(() => C.getLogsSplit(always, {}, 0, 1e9), /слишком мелко|exceeds limit/);
  console.log(`  запросов сделано: ${calls}`);
  assert.ok(calls <= 48, `должно быть не больше 48 запросов, сделано ${calls}`);
});

test('предел частоты НЕ приводит к делению', async () => {
  // Раньше «Too Many Requests» попадало под шаблон «too many» и запускало
  // деление — то есть на «слишком часто» терминал отвечал «давай ещё чаще».
  let calls = 0;
  const fakeRpc = async () => { calls++; throw new Error('eth_getLogs: Too Many Requests'); };
  await assert.rejects(() => C.getLogsSplit(fakeRpc, {}, 0, 100000),
                       /Too Many Requests/);
  assert.strictEqual(calls, 1, 'должен быть ровно один запрос, без деления');
});

// ── снятие комиссий и частичный выход ────────────────────────────────────
//
// В Uniswap V4 отдельного «claim» нет: комиссии забираются тем же
// DECREASE_LIQUIDITY, что и закрытие, только с нулём вместо ликвидности.
// Значит форма вызова обязана отличаться от проверенного байт в байт
// закрытия РОВНО ОДНИМ словом — тем, где стоит ликвидность. Если отличий
// больше, я собрал что-то другое, и проверять это на живых деньгах нельзя.
test('снятие комиссий отличается от закрытия ровно одним словом', () => {
  const arg = {
    tokenId: 1594792,
    currency0: '0x022c90ed10c2172bb9b2d54838bbe5d0827c4af1',
    currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    amount0Min: 0n, amount1Min: 0n, deadline: 1750000000,
  };
  const full = C.buildCloseCalldata({ ...arg, liquidity: 7670294495763860n }).toLowerCase();
  const fees = C.buildCloseCalldata({ ...arg, liquidity: 0n }).toLowerCase();
  const half = C.buildCloseCalldata({ ...arg, liquidity: 3835147247881930n }).toLowerCase();

  assert.strictEqual(full.length, fees.length, 'длина не должна меняться');
  const A = full.slice(10).match(/.{1,64}/g);
  const B = fees.slice(10).match(/.{1,64}/g);
  const diff = A.map((w, i) => (w === B[i] ? -1 : i)).filter(i => i >= 0);
  console.log(`  различий: ${diff.length}, слово(а) ${diff.join(',')}`);
  assert.strictEqual(diff.length, 1, 'отличаться обязано ровно одно слово');
  assert.strictEqual(BigInt('0x' + B[diff[0]]), 0n, 'в нём обязан стоять ноль');
  assert.strictEqual(BigInt('0x' + A[diff[0]]), 7670294495763860n,
                     'а в закрытии — вся ликвидность');

  // Половина — то же слово и ровно половина значения.
  const Ch = half.slice(10).match(/.{1,64}/g);
  const dh = A.map((w, i) => (w === Ch[i] ? -1 : i)).filter(i => i >= 0);
  assert.deepStrictEqual(dh, diff, 'половина меняет то же самое слово');
  assert.strictEqual(BigInt('0x' + Ch[diff[0]]) * 2n, 7670294495763860n);
});
