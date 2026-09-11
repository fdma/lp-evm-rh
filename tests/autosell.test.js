// РЕШЕНИЕ ОБ АВТОПРОДАЖЕ.
//
// Это единственное место терминала, где деньги уходят без окна кошелька.
// Значит цена ошибки здесь выше, чем везде: неверно определённая сторона пары
// продаст не монету, а стейбл, и человек узнает об этом постфактум.
//
// Поэтому решение вынесено в чистую функцию без сети и без моста, и проверяется
// целиком. Особое внимание — случаям, где продавать НЕЛЬЗЯ: молчаливая продажа
// не той стороны хуже, чем несработавшая автопродажа.
//
// Запуск: node --test tests/autosell.test.js
const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/autosell.js');

// Пара из настоящего пула автора: стейбл стоит ПЕРВЫМ, монета вторая.
// Ровно та расстановка, на которой в терминале уже ломались проценты.
const STABLE_FIRST = {
  mode: 'all',
  sym0: 'USDG', sym1: 'ROBINCAT',
  addr0: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  addr1: '0x022c90ed10c2172bb9b2d54838bbe5d0827c4af1',
  dec0: 6, dec1: 18,
  raw0: 1_000000n,                       // 1 USDG
  raw1: 5_000n * 10n ** 18n,             // 5000 монет
};

// Настройки — общий объект, и тесты его меняют. Возвращаем к исходному до
// каждого случая, иначе порядок тестов начинает влиять на результат.
function reset(over) {
  Object.assign(A.settings, {
    on: true, slippage: 5,
    modes: { all: true, half: true },
  }, over || {});
}

test('по умолчанию автопродажа выключена', () => {
  // Проверяем не настройку, а поведение: выключено должно ЗНАЧИТЬ «не продаёт».
  reset({ on: false });
  const d = A.decide(STABLE_FIRST);
  assert.strictEqual(d.sell, false);
  assert.match(d.why, /выключена/);
});

test('стейбл первый — продаётся вторая сторона', () => {
  reset();
  const d = A.decide(STABLE_FIRST);
  assert.strictEqual(d.sell, true);
  assert.strictEqual(d.side, 1);
  assert.strictEqual(d.sym, 'ROBINCAT');
  assert.strictEqual(d.addr, STABLE_FIRST.addr1);
  assert.strictEqual(d.raw, STABLE_FIRST.raw1);
  assert.strictEqual(d.amount, 5000);
  assert.strictEqual(d.into, STABLE_FIRST.addr0, 'выходим в стейбл, а не в себя');
  assert.strictEqual(d.intoSym, 'USDG');
});

test('стейбл второй — продаётся первая сторона', () => {
  reset();
  // Та же пара наоборот. Если бы сторона определялась по номеру, а не по
  // символу, здесь ушёл бы стейбл.
  const d = A.decide({
    ...STABLE_FIRST,
    sym0: 'ROBINCAT', sym1: 'USDT',
    dec0: 18, dec1: 18,
    raw0: 5_000n * 10n ** 18n, raw1: 1n * 10n ** 18n,
  });
  assert.strictEqual(d.sell, true);
  assert.strictEqual(d.side, 0);
  assert.strictEqual(d.sym, 'ROBINCAT');
});

test('обе стороны стейблы — не продаём и говорим почему', () => {
  reset();
  const d = A.decide({ ...STABLE_FIRST, sym0: 'USDG', sym1: 'USDT' });
  assert.strictEqual(d.sell, false);
  assert.match(d.why, /стейбл/);
});

test('стейбла в паре нет — отказываемся выбирать сторону', () => {
  reset();
  // Самый опасный случай: обе стороны волатильны, и «результатом» может быть
  // любая. Угадывать нельзя — уйдёт то, что человек хотел оставить.
  const d = A.decide({ ...STABLE_FIRST, sym0: 'ROBINCAT', sym1: 'CASHCAT' });
  assert.strictEqual(d.sell, false);
  assert.match(d.why, /не берусь/);
});

test('монета из закрытия не вернулась — продавать нечего', () => {
  reset();
  const d = A.decide({ ...STABLE_FIRST, raw1: 0n });
  assert.strictEqual(d.sell, false);
  assert.match(d.why, /не вернулся/);
});

test('снятие комиссий не запускает автопродажу НИ ПРИ КАКИХ настройках', () => {
  reset();
  // Это правило, а не настройка: комиссии уходят только вместе с выходом и
  // тем же свапом. Проверяем, что включить это нельзя даже нарочно.
  A.settings.modes.fees = true;
  const d = A.decide({ ...STABLE_FIRST, mode: 'fees' });
  assert.strictEqual(d.sell, false);
  assert.match(d.why, /только вместе с выходом/);
});

test('половина закрытия автопродажу запускает', () => {
  reset();
  const d = A.decide({ ...STABLE_FIRST, mode: 'half' });
  assert.strictEqual(d.sell, true);
});

test('узел не отдал decimals — продаём точное целое, но число не выдумываем', () => {
  reset();
  // Раньше на месте неизвестного молча вставала восемнадцать, и у монеты с
  // шестью знаками цена уезжала в 10^12 раз. Сумма продажи от этого не зависит
  // — она берётся из квитанции целым, — но показывать выдуманное нельзя.
  const d = A.decide({ ...STABLE_FIRST, dec1: null });
  assert.strictEqual(d.sell, true);
  assert.strictEqual(d.raw, STABLE_FIRST.raw1, 'продаётся ровно то, что вернулось');
  assert.strictEqual(d.amount, null, 'штук не знаем — и не придумываем');
  assert.match(d.why, /базовых единицах/);
});

test('нативная монета сети считается стейблом и не продаётся', () => {
  reset();
  // BNB в списке STABLE намеренно: это не стейбл, но это ТА сторона, в которую
  // выходят, а не та, от которой избавляются. Продавать её за стейбл терминал
  // не должен — человек её и хотел получить.
  const d = A.decide({
    ...STABLE_FIRST, sym0: 'CTM', sym1: 'BNB',
    raw0: 5_000n * 10n ** 6n, dec0: 6,      // 5000 CTM по $0.01 — это $50
  });
  assert.strictEqual(d.sell, true);
  assert.strictEqual(d.sym, 'CTM');
});

test('coinSide не путает регистр символов', () => {
  assert.strictEqual(A.coinSide('usdt', 'PEPE'), 1);
  assert.strictEqual(A.coinSide('PEPE', 'UsDc'), 0);
  assert.strictEqual(A.coinSide('USDT', 'usdc'), null);
});


// ── ПЕРЕСЧЁТ ПРОСКАЛЬЗЫВАНИЯ ────────────────────────────────────────────────
//
// Человек задаёт проценты, контракты считают в сотых долях процента. Ошибка
// здесь не видна ни в журнале, ни в окне кошелька: сделка просто уйдёт с
// защитой в сто раз слабее или в сто раз строже заказанной. Первое — подарок
// сэндвичу, второе — вечные отказы.
test('проценты превращаются в сотые доли процента, а не остаются процентами', () => {
  reset({ slippage: 5 });   assert.strictEqual(A.slippageBps(), 500, '5% — это 500');
  reset({ slippage: 0.5 }); assert.strictEqual(A.slippageBps(), 50,  '0.5% — это 50');
  // Ноль защиты означал бы «исполни по любой цене». Округление вниз не должно
  // уметь его породить.
  reset({ slippage: 0.0001 }); assert.strictEqual(A.slippageBps(), 1);
  // Опечатка в поле «своё» не должна отдать монету за бесценок.
  reset({ slippage: 200 }); assert.strictEqual(A.slippageBps(), 5000, '200% зажимается до половины');
});

// ── ДОЛЛАРЫ И НЕ-ДОЛЛАРЫ ────────────────────────────────────────────────────
//
// BNB намеренно лежит в STABLE — это сторона, в которую выходят, продавать её
// не надо. Но доллар она не стоит, и порог «не продавать мельче $5» к ней
// неприменим. На этом порог уже однажды ошибался в тысячи раз.
test('BNB — сторона выхода, но не доллар', () => {
  assert.strictEqual(A.STABLE.test('BNB'), true,  'BNB не продаём');
  assert.strictEqual(A.isUsdStable('BNB'), false, 'но и за доллар не считаем');
  assert.strictEqual(A.isUsdStable('WBNB'), false);
  for (const s of ['USDT', 'usdc', 'USDG', 'DAI']) {
    assert.strictEqual(A.isUsdStable(s), true, s + ' — доллар');
  }
});

test('решение помечает, можно ли мерить порог в долларах', () => {
  reset();
  assert.strictEqual(A.decide(STABLE_FIRST).usdQuote, true, 'выход в USDG — доллары');
  const bnb = A.decide({
    ...STABLE_FIRST, sym0: 'CTM', sym1: 'BNB',
    raw0: 5_000n * 10n ** 6n, dec0: 6,
  });
  assert.strictEqual(bnb.sell, true);
  assert.strictEqual(bnb.usdQuote, false, 'выход в BNB — порог в долларах не применим');
});
