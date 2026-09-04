// Проверка состава позиции на НАСТОЯЩЕЙ позиции автора.
// Сверяем с тем, что реально ушло и вернулось по транзакциям.
const C = require('../src/core.js');
(async () => {
  const rpc = C.makeRpc(C.RH.publicRpc);
  // Позиция 1599292: вошёл 2.0 USDG, границы -344800…-341600
  const tl = -344800, tu = -341600;
  const liq = 353662761825729n;
  const sA = C.getSqrtRatioAtTick(tl), sB = C.getSqrtRatioAtTick(tu);

  // 1. Цена ВЫШЕ диапазона (как было при входе) — всё должно быть в USDG
  const above = C.getSqrtRatioAtTick(tu + 100);
  const a1 = C.amountsForLiquidity(above, sA, sB, liq);
  const usdg = Number(a1.amount1) / 1e6;
  console.log(`  цена выше диапазона: ${Number(a1.amount0)/1e18} UNICORN, ${usdg.toFixed(4)} USDG`);
  const ok1 = a1.amount0 === 0n && Math.abs(usdg - 2.0) < 0.02;
  console.log(ok1 ? '  ок: всё в USDG и это ~2.0 — совпало с внесённой суммой'
                  : '  ПРОВАЛ: не сошлось с внесёнными 2.0');
  if (!ok1) process.exitCode = 1;

  // 2. Цена НИЖЕ диапазона — всё должно перелиться в монету
  const below = C.getSqrtRatioAtTick(tl - 100);
  const a2 = C.amountsForLiquidity(below, sA, sB, liq);
  const ok2 = a2.amount1 === 0n && a2.amount0 > 0n;
  console.log(`  цена ниже диапазона: ${(Number(a2.amount0)/1e18).toFixed(2)} UNICORN, ${Number(a2.amount1)/1e6} USDG`);
  console.log(ok2 ? '  ок: всё перелилось в монету' : '  ПРОВАЛ');
  if (!ok2) process.exitCode = 1;

  // 3. Внутри — смесь, и обе части больше нуля
  const mid = C.getSqrtRatioAtTick(Math.round((tl + tu) / 2));
  const a3 = C.amountsForLiquidity(mid, sA, sB, liq);
  const ok3 = a3.amount0 > 0n && a3.amount1 > 0n;
  console.log(`  внутри: ${(Number(a3.amount0)/1e18).toFixed(2)} UNICORN + ${(Number(a3.amount1)/1e6).toFixed(4)} USDG`);
  console.log(ok3 ? '  ок: смесь двух токенов' : '  ПРОВАЛ');
  if (!ok3) process.exitCode = 1;
  console.log('\nитог: ' + (process.exitCode ? 'ЕСТЬ ПРОВАЛЫ' : 'состав позиции считается верно'));
})();
