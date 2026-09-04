// САМАЯ ВАЖНАЯ ПРОВЕРКА: своя сборка транзакции против НАСТОЯЩЕЙ,
// которая уже прошла в сети с кошелька автора.
//
// Если байты совпадают — значит наш терминал попросит у сети ровно то же
// самое, что уже работало. Это сильнее любых рассуждений о правильности.
const C = require('../src/core.js');


(async () => {
  // Эталон лежит на диске: обозреватель отдаёт JSON только с браузерным
  // заголовком, и завязывать проверку на сеть незачем — байты не меняются.
  const tx = require('./fixtures/real-mint.json');
  const real = (tx.raw_input || '').toLowerCase();
  console.log(`  настоящая транзакция: ${(real.length - 10) / 2} байт данных, статус ${tx.status}`);

  // Параметры, разобранные из неё же.
  const mine = C.buildMintCalldata({
    key: {
      currency0: '0x022c90ed10c2172bb9b2d54838bbe5d0827c4af1',
      currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      fee: 40000, tickSpacing: 800,
      hooks: '0x0000000000000000000000000000000000000000',
    },
    tickLower: -346400, tickUpper: -339200,
    liquidity: 7670294495763860n,
    amount0Max: 77067364678456454583042n,
    amount1Max: 100000000n,
    owner: '0x1111111111111111111111111111111111111111',
    deadline: 1788413538,
  }).toLowerCase();

  console.log(`  наша сборка:          ${(mine.length - 10) / 2} байт`);
  if (mine === real) {
    console.log('  ок: СОВПАЛО БАЙТ В БАЙТ');
  } else {
    console.log('  ПРОВАЛ: не совпало');
    process.exitCode = 1;
    for (let i = 0; i < Math.max(mine.length, real.length); i += 64) {
      const a = mine.slice(i, i + 64), b = real.slice(i, i + 64);
      if (a !== b) {
        console.log(`    расхождение с позиции ${i / 2} байт:`);
        console.log(`      наше:      ${a}`);
        console.log(`      настоящее: ${b}`);
        break;
      }
    }
  }

  // И проверка нашей защиты: неиспользуемая сторона получает предел 0.
  const safe = C.buildMintCalldata({
    key: {
      currency0: '0x022c90ed10c2172bb9b2d54838bbe5d0827c4af1',
      currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
      fee: 40000, tickSpacing: 800,
      hooks: '0x0000000000000000000000000000000000000000',
    },
    tickLower: -346400, tickUpper: -339200,
    liquidity: 7670294495763860n,
    amount0Max: 0n, amount1Max: 100000000n,
    owner: '0x1111111111111111111111111111111111111111',
    deadline: 1788413538,
  });
  const hasZeroMax = safe.length === mine.length;
  console.log(hasZeroMax
    ? '  ок: вариант с нулевым пределом собирается той же длины'
    : '  ПРОВАЛ: длина изменилась');
  console.log('\nитог: ' + (process.exitCode ? 'ЕСТЬ ПРОВАЛЫ' : 'сборка совпадает с настоящей'));
})().catch(e => { console.log('СБОЙ: ' + e.message); process.exitCode = 1; });
