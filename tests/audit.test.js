// ПРОВЕРКИ, РОДИВШИЕСЯ ИЗ АУДИТА 09.09.2026.
//
// Обе ошибки, которые они закрывают, были найдены не тестом, а разбором: одна
// про доли баланса, вторая про флаг плавающей комиссии. Тест нужен, чтобы они
// не вернулись тихо.
const test = require('node:test');
const assert = require('node:assert');

// 1. ДОЛЯ БАЛАНСА НЕ ДОЛЖНА ПРЕВЫШАТЬ БАЛАНС.
//
// Старый путь «баланс -> дробное число -> обратно в минимальные единицы» у
// токена с 18 знаками в половине случаев давал на несколько наноединиц больше,
// чем есть на кошельке. Для кнопки «100%» это отказ транзакции на ровном месте.
const oldWay = (human, d) =>
  BigInt(Math.round(human * Math.pow(10, Math.min(d, 15)))) *
  (10n ** BigInt(Math.max(0, d - 15)));
const newWay = (raw, pct) => raw * BigInt(pct) / 100n;

test('доля баланса берётся в целых и никогда не больше баланса', () => {
  let overOld = 0, overNew = 0;
  for (let i = 0; i < 20000; i++) {
    const raw = BigInt(Math.floor(Math.random() * 1e7) + 1) * 10n ** 18n +
                BigInt(Math.floor(Math.random() * 1e18));
    if (oldWay(Number(raw) / 1e18, 18) > raw) overOld++;
    if (newWay(raw, 100) > raw) overNew++;
  }
  assert.strictEqual(overNew, 0, 'новый путь не должен превышать баланс никогда');
  assert.ok(overOld > 0, 'старый путь действительно превышал — иначе тест бессмыслен');
});

// 2. ФЛАГ ПЛАВАЮЩЕЙ КОМИССИИ — НЕ ВЕЛИЧИНА КОМИССИИ.
//
// В ключе пула 0x800000 означает «комиссия плавающая». Делить это на миллион
// нельзя: получается доля 8.39 и множитель (1 − 8.39) = −7.39, то есть выход
// в плюсе показывается как уверенный минус.
const DYNAMIC = 0x800000;
function sellShare(feeRaw, measuredMedian) {
  let share = feeRaw === DYNAMIC
    ? (measuredMedian != null ? measuredMedian / 1000000 : null)
    : feeRaw / 1000000;
  if (share == null || !(share >= 0) || share > 0.5) return null;
  return share;
}

test('у пула с плавающей комиссией доля не берётся из флага', () => {
  assert.strictEqual(sellShare(DYNAMIC, null), null, 'без замера считать нечем');
  assert.strictEqual(sellShare(DYNAMIC, 50000), 0.05, 'с замером берём замер');
  assert.strictEqual(sellShare(50000, null), 0.05, 'обычная комиссия как была');
  assert.strictEqual(sellShare(900000, null), null, '90% — неправдоподобно, отказ');
});

test('выход в плюсе не превращается в минус', () => {
  const stableQty = 50, coinQty = 1000000, coinPrice = 0.00005;
  const bad = stableQty + coinQty * coinPrice * (1 - DYNAMIC / 1000000);
  assert.ok(bad < 0, 'старая формула действительно давала минус');
  const share = sellShare(DYNAMIC, 50000);
  const good = stableQty + coinQty * coinPrice * (1 - share);
  assert.ok(good > 90 && good < 100, 'честный расчёт даёт около 97.5');
});

// 3. ВХОД В ПАРУ С НАТИВНОЙ МОНЕТОЙ.
//
// Собран 09.09.2026. Нативная монета уходит значением транзакции, а сдачу
// возвращает SWEEP. Проверяем ровно то, что можно проверить без сети: в
// сборке появляется третье действие, и только когда одна из сторон нативная.
const C = require('../src/core.js');

test('в паре с нативной монетой в сборку добавляется SWEEP', () => {
  const base = {
    tickLower: 100, tickUpper: 200, liquidity: 1000n,
    amount0Max: 5n * 10n ** 15n, amount1Max: 0n,
    owner: '0x00000000000000000000000000000000000000ff',   // адрес для теста, ничей
    deadline: 1788900000,
  };
  const usual = C.buildMintCalldata({
    ...base,
    key: { currency0: '0x55d398326f99059ff775485246999027b3197955',
           currency1: '0xc8fb80fcc03f699c70ff0cc08c09106288888888',
           fee: 10000, tickSpacing: 200,
           hooks: '0x0000000000000000000000000000000000000000' },
  });
  const native = C.buildMintCalldata({
    ...base,
    key: { currency0: '0x0000000000000000000000000000000000000000',
           currency1: '0xc8fb80fcc03f699c70ff0cc08c09106288888888',
           fee: 10000, tickSpacing: 200,
           hooks: '0x0000000000000000000000000000000000000000' },
  });
  assert.ok(native.length > usual.length,
            'сборка с нативной стороной обязана быть длиннее на действие SWEEP');
  // Два действия против трёх: 0x020d против 0x020d14.
  assert.ok(usual.includes('020d'), 'обычный вход: MINT_POSITION + SETTLE_PAIR');
  assert.ok(native.includes('020d14'), 'нативный вход: те же плюс SWEEP');
});

test('нативной монетой считается только нулевой адрес', () => {
  assert.strictEqual(C.isNativeCurrency('0x0000000000000000000000000000000000000000'), true);
  assert.strictEqual(C.isNativeCurrency('0x55d398326f99059ff775485246999027b3197955'), false);
  assert.strictEqual(C.isNativeCurrency(''), false);
});
