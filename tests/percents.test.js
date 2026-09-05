// ПРОЦЕНТЫ В ПЕРЕВЁРНУТОЙ ЦЕНЕ.
//
// Автор поставил ширину 50% на USDG/ROBINCAT, померил результат по свечам
// и получил −32%. Он был прав. Тик считает currency1 за currency0, а стейбл
// в этом пуле стоит ПЕРВЫМ, поэтому показанная цена перевёрнута: «вниз» в ней
// означает «вверх» в тиках. Планировщик честно откладывал 50% в СЫРОЙ цене,
// и на графике это оказывалось 1/1.5 = −33%.
//
// Границы диапазона под переворот я правил раньше, проценты — нет.
//
// Запуск: node --test tests/percents.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');

// Настоящий пул автора: USDG/ROBINCAT, шаг 300 тиков, стейбл первый.
const TICK = 315976, SPACING = 300, INVERTED = true;

test('в перевёрнутой цене 50% вниз — это удвоение в тиках', () => {
  assert.strictEqual(Math.round(C.askedToRawPct(50, true, true)), 100);
  // А в обычной паре ничего не меняется.
  assert.strictEqual(Math.round(C.askedToRawPct(50, true, false)), 50);
});

test('обратный перевод возвращает то, что видит автор', () => {
  // Ровно тот случай со скриншота: терминал показывал 53.14%.
  assert.ok(Math.abs(C.rawToShownPct(53.14, true) + 34.70) < 0.01,
            'сырые +53.14% — это показанные −34.70%');
  assert.strictEqual(C.rawToShownPct(53.14, false).toFixed(2), '53.14');
  // Туда и обратно.
  for (const p of [1, 3, 15, 30, 50, 70]) {
    const raw = C.askedToRawPct(p, true, INVERTED);
    assert.ok(Math.abs(C.rawToShownPct(raw, INVERTED) + p) < 1e-9,
              `круг не сошёлся на ${p}%`);
  }
});

test('на настоящем пуле ширина 50% даёт около 50%, а не 34%', () => {
  const plan = (widthAsked, convert) => {
    const p = C.planRange({
      tick: TICK, tickSpacing: SPACING, side: 'up',
      gapPct: convert ? C.askedToRawPct(1, true, INVERTED) : 1,
      widthPct: convert ? C.askedToRawPct(widthAsked, true, INVERTED) : widthAsked,
    });
    return C.rawToShownPct(p.widthReal, INVERTED);
  };
  const fixed = plan(50, true);
  const broken = plan(50, false);
  console.log(`  как было: ${broken.toFixed(2)}%   как стало: ${fixed.toFixed(2)}%`);
  assert.ok(broken > -40, 'старое поведение обязано быть заметно уже 50%');
  assert.ok(fixed <= -50 && fixed > -56,
            `ширина должна быть около −50%, вышло ${fixed.toFixed(2)}%`);
});

test('процент больше 100 отвергается, а не молча ломает цену', () => {
  assert.throws(() => C.askedToRawPct(100, true, INVERTED), /слишком велик/);
  assert.throws(() => C.askedToRawPct(150, true, INVERTED), /слишком велик/);
});

// ── ЗНАК ТИКА В СОБЫТИИ ОБМЕНА ────────────────────────────────────────────
//
// В журнале int24 лежит РАСШИРЕННЫЙ ЗНАКОМ до 256 бит: у отрицательного тика
// слово выглядит как 0xffff…fb0d59. Разбор с шириной 24 превращал такое слово
// в 1.16e+77, и цена по нему не считалась вовсе.
//
// Коварство в том, что пулы с ПОЛОЖИТЕЛЬНЫМ тиком при этом работали. Ошибка
// была видна только там, где монета дешевле стейбла, — а это большинство пар.
// Из-за неё 30 позиций из 124 молча выпали из подсчёта итога.
test('отрицательный тик из журнала читается как отрицательный', () => {
  const word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
  for (const tick of [-323026, -1, 0, 1, 887272, -887272]) {
    const got = Number(C.toSigned(BigInt('0x' + word(tick)), 256));
    assert.strictEqual(got, tick, `тик ${tick} прочитан как ${got}`);
  }
  // Ровно тот случай, что был на живой позиции: ширина 24 даёт мусор.
  const bad = Number(C.toSigned(BigInt('0x' + word(-323026)), 24));
  assert.ok(bad > 1e70, 'старая ширина обязана давать заведомую чушь, а не почти верное число');
});
