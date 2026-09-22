// МИНИМУМЫ ПРИ ВЫХОДЕ ИЗ ПОЗИЦИИ.
//
// Раньше выход уходил с минимумами 0/0 — без защиты от сэндвича. Настоящая
// транзакция Krystal, с которой сверена сборка выхода байт в байт, минимум
// ставила. Здесь проверяется, что новые минимумы делают ровно две вещи:
//
//   * НЕ МЕШАЮТ выйти, пока цена в пределах окна: пропущенный выход — это
//     тоже потеря, и её автор уже видел на автопродаже;
//   * ОТКАЗЫВАЮТ, если цену за время выхода увели дальше окна.
//
// Проверяем честно: считаем, что пул реально отдаст при сдвинутой цене, и
// сравниваем с минимумом так же, как это делает PositionManager.
//
// Запуск: node --test tests/close-mins.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');
C.useChain('robinhood');

const TOL = 0.05;
const L = 7670294495763860n;                 // ликвидность настоящей позиции автора

// Что отдаст пул, если к моменту выхода цена сдвинулась в factor раз.
function payoutAt(sqrtP, lo, hi, factor) {
  const k = BigInt(Math.round(Math.sqrt(factor) * 1e9));
  const moved = sqrtP * k / 1000000000n;
  return C.amountsForLiquidity(moved, C.getSqrtRatioAtTick(lo), C.getSqrtRatioAtTick(hi), L);
}
const passes = (got, m) => got.amount0 >= m.amount0Min && got.amount1 >= m.amount1Min;

// Позиция В РАБОТЕ: цена внутри диапазона. Самый трудный случай — состав
// меняется с каждым движением цены.
const LO = 315000, HI = 318000, MID = 316500;
const sqrtMid = C.getSqrtRatioAtTick(MID);

test('в работе: выход проходит при любом движении внутри окна', () => {
  const m = C.closeMinAmounts(sqrtMid, LO, HI, L, TOL);
  for (const f of [1, 0.96, 0.951, 1.04, 1.049]) {
    assert.ok(passes(payoutAt(sqrtMid, LO, HI, f), m),
      `сдвиг цены ×${f} внутри окна ±5% не должен ронять выход`);
  }
});

test('в работе: сэндвич дальше окна получает отказ, а не деньги', () => {
  const m = C.closeMinAmounts(sqrtMid, LO, HI, L, TOL);
  for (const f of [0.85, 0.9, 1.1, 1.2]) {
    assert.ok(!passes(payoutAt(sqrtMid, LO, HI, f), m),
      `сдвиг ×${f} — это уже за окном, выход обязан откатиться`);
  }
});

test('ниже диапазона: вся позиция в одной монете, минимум почти равен ей', () => {
  // Цена ниже диапазона — позиция целиком в currency0 и от цены не зависит.
  const below = C.getSqrtRatioAtTick(LO - 5000);
  const m = C.closeMinAmounts(below, LO, HI, L, TOL);
  const all = C.amountsForLiquidity(below, C.getSqrtRatioAtTick(LO), C.getSqrtRatioAtTick(HI), L);
  assert.strictEqual(m.amount1Min, 0n, 'второй монеты тут нет');
  assert.ok(m.amount0Min > 0n && m.amount0Min <= all.amount0, 'минимум не выше того, что есть');
  assert.ok(m.amount0Min * 1000n >= all.amount0 * 998n, 'и не ниже 99.8% — защита настоящая');
});

test('снятие одних комиссий — минимумов нет: тела ноль', () => {
  const m = C.closeMinAmounts(sqrtMid, LO, HI, 0n, TOL);
  assert.deepStrictEqual(m, { amount0Min: 0n, amount1Min: 0n });
});

test('цена не прочиталась — минимумов нет, но и не падаем', () => {
  // Отказывать в выходе из-за сбоя чтения нельзя: человеку надо выйти.
  // Уходим без минимумов, а интерфейс говорит об этом вслух.
  const m = C.closeMinAmounts(null, LO, HI, L, TOL);
  assert.deepStrictEqual(m, { amount0Min: 0n, amount1Min: 0n });
});

test('половина: минимумы пропорциональны снимаемому, а не всей позиции', () => {
  const full = C.closeMinAmounts(sqrtMid, LO, HI, L, TOL);
  const half = C.closeMinAmounts(sqrtMid, LO, HI, L / 2n, TOL);
  // С точностью до округления — вдвое меньше.
  const near = (a, b) => (a > b ? a - b : b - a) <= 2n;
  assert.ok(near(half.amount0Min * 2n, full.amount0Min));
  assert.ok(near(half.amount1Min * 2n, full.amount1Min));
});
