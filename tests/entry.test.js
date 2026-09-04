// Вход, время и цена входа — С ЦЕПОЧКИ.
//
// Тест закрывает ошибку, из-за которой позиция с живыми деньгами показывала
// «вход не записан»: вход хранился в памяти браузера и не пережил смену
// версии. Теперь всё читается из сети, и это проверяется здесь.
//
// Две части. Первая работает всегда и ни от кого не зависит: цена из
// последнего события обмена обязана совпасть с ценой из слота пула — это
// доказывает, что событие читается правильно. Вторая часть проверяет разбор
// НАСТОЯЩЕЙ позиции, и для неё нужна ваша собственная:
//
//   RH_TEST_TOKEN_ID=1234567 RH_TEST_OWNER=0xВашАдрес node tests/entry.test.js
//
// Без этих переменных вторая часть пропускается. Своих позиций в репозитории
// нет намеренно: по номеру позиции в обозревателе находится её автор.
'use strict';
global.window = {};
require('../src/keccak.js');
global.keccak256 = global.window.keccak256;
const C = require('../src/core.js');

const RPC = process.env.RH_TEST_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const rpc = async (m, p) => {
  const r = await fetch(RPC, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const poolIdOf = (k) => keccak256('0x' + C.addrWord(k.currency0) + C.addrWord(k.currency1) +
  BigInt(k.fee).toString(16).padStart(64, '0') +
  BigInt.asUintN(256, BigInt(k.tickSpacing)).toString(16).padStart(64, '0') +
  C.addrWord(k.hooks));

// Живой пул со стейблом. Нужен только для первой части.
const POOL = process.env.RH_TEST_POOL ||
  '0xd80658c99853f6543c6e3e0a3456a5bedf47ff5a3e9c85b95fe561d4f7798eae';
const ID = process.env.RH_TEST_TOKEN_ID || null;
const OWNER = process.env.RH_TEST_OWNER || null;

let bad = 0;
const ok = (name, cond, got) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${cond ? '' : '  → ' + got}`);
  if (!cond) bad++;
};

(async () => {
  // ── часть 1: событие обмена читается правильно ─────────────────────────
  const latest = Number(BigInt(await rpc('eth_blockNumber', [])));
  const now = await C.priceAtBlock(rpc, POOL, latest);
  const s0 = await C.readSlot0(rpc, POOL);
  if (!now) {
    console.log('  пропуск: в этом пуле давно не было обменов, сравнивать нечего');
  } else {
    ok('цена из события = цена из слота пула',
       now.sqrtPriceX96 === s0.sqrtPriceX96,
       `${now.sqrtPriceX96} vs ${s0.sqrtPriceX96} (мог пройти обмен между чтениями)`);
  }

  // ── часть 2: разбор настоящей позиции ──────────────────────────────────
  if (!ID || !OWNER) {
    console.log('\n  вторая часть пропущена: задайте RH_TEST_TOKEN_ID и RH_TEST_OWNER,');
    console.log('  чтобы проверить разбор входа на своей позиции.');
    process.exit(bad ? 1 : 0);
  }

  const m = await C.findMint(rpc, ID);
  ok('выпуск NFT найден', m && m.block > 0, m && m.block);
  if (!m) process.exit(1);

  const f = await C.txFlows(rpc, m.hash, OWNER);
  const inflow = f.flows.filter(x => x.dir < 0);
  ok('внесение найдено', inflow.length >= 1, inflow.length);
  if (inflow.length === 1) {
    console.log(`  внесено: ${inflow[0].amount} (в единицах токена ${inflow[0].token})`);
  }

  const info = await C.readPositionPool(rpc, ID);
  const pid = poolIdOf(info.key);
  const pe = await C.priceAtBlock(rpc, pid, m.block);
  ok('цена входа прочитана', !!pe, pe);
  ok('цена взята НЕ ПОЗЖЕ блока входа', pe && pe.block <= m.block, pe && pe.block);

  const t = await C.blockTime(rpc, m.block);
  ok('время входа получено', t > 1.7e12 && t < Date.now() + 6e4, t);

  console.log(bad ? `\nПРОВАЛЕНО: ${bad}` : '\nвсё сошлось');
  process.exit(bad ? 1 : 0);
})();
