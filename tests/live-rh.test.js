// То же самое, но на сети Robinhood. Терминал двухсетевой, и обе стороны
// обязаны проверяться: правка ради BSC не должна ломать сеть, где у автора
// лежат живые деньги.
// Запуск: node tests/live-rh.test.js
const C = require('../src/core.js');
C.useChain('robinhood');
const { execFileSync } = require('child_process');

let independent = true;
function keccak256(hexInput) {
  if (independent) {
    try {
      return execFileSync('python3', ['-c', `
import sys
from Crypto.Hash import keccak
h=keccak.new(digest_bits=256); h.update(bytes.fromhex(sys.argv[1]))
print('0x'+h.hexdigest())`, C.stripHex(hexInput)], { encoding: 'utf8' }).trim();
    } catch (e) {
      independent = false;
      console.log('  замечание: независимой реализации keccak нет — считаю своей');
    }
  }
  return require('../src/keccak.js').keccak256(hexInput);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function retrying(rpc) {
  return async (m, p) => {
    let last = null;
    for (let i = 0; i < 4; i++) {
      try { return await rpc(m, p); }
      catch (e) {
        last = e;
        if (!/too many|rate|429|limit|timeout|fetch failed|internal server err/i.test(e.message || '')) throw e;
        await sleep(1500 * (i + 1));
      }
    }
    throw last;
  };
}

// Публичный пул MEME/USDG — самый крупный по обороту. Ничей конкретно,
// к позициям автора отношения не имеет.
const POOL = '0x4b7c86491df95f366b31217b2950d2c5136a2f19b6879613eac73d0e69092a1a';

(async () => {
  const rpc = retrying(C.makeRpc(C.RH.publicRpc));
  let bad = 0;
  const fail = (m) => { console.log('  ПРОВАЛ: ' + m); bad++; process.exitCode = 1; };
  const ok = (m) => console.log('  ок: ' + m);
  const skip = (m) => console.log('  пропуск: ' + m);

  const chain = await C.assertChain(rpc);
  chain === 4663 ? ok(`сеть ${chain}`) : fail(`сеть ${chain}, а нужна 4663`);

  const sizes = await C.assertContracts(rpc);
  ok(`контракты на месте: ${Object.entries(sizes).map(([k, v]) => k + ' ' + v).join(', ')}`);

  for (const [name, addr] of [['positionManager', C.RH.positionManager],
                              ['stateView', C.RH.stateView]]) {
    const r = await rpc('eth_call', [{ to: addr, data: C.SEL.poolManager }, 'latest']);
    const got = '0x' + r.slice(26).toLowerCase();
    got === C.RH.poolManager ? ok(`${name} смотрит на наш PoolManager`)
                             : fail(`${name} смотрит на ${got}`);
  }

  const key = await C.loadPool(rpc, POOL, keccak256);
  key.poolIdOk ? ok('PoolId пересчитан из ключа и совпал') : fail('PoolId НЕ совпал');
  ok(`комиссия ${key.fee / 10000}%, шаг ${key.tickSpacing}`);

  const s0 = await C.readSlot0(rpc, POOL);
  if (!s0.sqrtPriceX96) fail('цена пула нулевая');
  else ok(`тик ${s0.tick}`);

  const mine = C.getSqrtRatioAtTick(s0.tick);
  const diff = mine > s0.sqrtPriceX96 ? mine - s0.sqrtPriceX96 : s0.sqrtPriceX96 - mine;
  const rel = Number(diff * 1000000n / s0.sqrtPriceX96) / 1000000;
  rel < 0.0002 ? ok(`TickMath сходится с сетью (расхождение ${(rel * 100).toFixed(5)}%)`)
               : fail(`TickMath разошёлся на ${(rel * 100).toFixed(4)}%`);

  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const f = await C.poolFeeReality(rpc, POOL, latest);
  if (f.pays === null) skip(`комиссию замерить не вышло: ${f.why}`);
  else if (!f.pays) fail(`пул НЕ платит: ${f.why}`);
  else ok(`замер по ${f.swaps} обменам: ${(f.median / 10000).toFixed(3)}%`);

  // Ключи памяти обязаны остаться прежними: в журнале входов лежат суммы,
  // по которым считается итог позиции.
  C.RH.storeKey === 'lp-evm-rh' && C.RH.ledgerKey === 'lp-evm-rh-ledger'
    ? ok('ключи памяти этой сети не менялись — история на месте')
    : fail(`ключи памяти сменились: ${C.RH.storeKey} / ${C.RH.ledgerKey}`);

  console.log(bad ? `\nитог: ${bad} провал(ов)` : '\nитог: ядро читает Robinhood верно');
})().catch(e => { console.log('  ОШИБКА: ' + e.message); process.exitCode = 1; });
