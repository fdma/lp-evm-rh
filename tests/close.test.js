// Сборка закрытия против НАСТОЯЩЕЙ транзакции закрытия автора.
const C = require('../src/core.js');
C.useChain('robinhood');   // ядро стало двухсетевым — выбираем явно
const tx = require('./fixtures/real-close.json');
const real = tx.raw_input.toLowerCase();
const data = Buffer.from(real.slice(10), 'hex');
const deadline = Number(BigInt('0x' + data.slice(32, 64).toString('hex')));

const mine = C.buildCloseCalldata({
  tokenId: 1594792,
  liquidity: 7670294495763860n,
  currency0: '0x022c90ed10c2172bb9b2d54838bbe5d0827c4af1',
  currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  amount0Min: 0n, amount1Min: 99999999n,
  deadline,
}).toLowerCase();

console.log(`  настоящая: ${(real.length - 10) / 2} байт, статус ${tx.status}`);
console.log(`  наша:      ${(mine.length - 10) / 2} байт`);
if (mine === real) console.log('  ок: СОВПАЛО БАЙТ В БАЙТ');
else {
  process.exitCode = 1;
  const A = mine.slice(10).match(/.{1,64}/g), B = real.slice(10).match(/.{1,64}/g);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) {
      console.log(`  ПРОВАЛ: слово ${i}`);
      console.log(`    наше:      ${A[i]}`);
      console.log(`    настоящее: ${B[i]}`);
      break;
    }
  }
}
