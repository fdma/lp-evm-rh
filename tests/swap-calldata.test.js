// СБОРКА СВАПА ДЛЯ UNIVERSALROUTER.
//
// Вход и выход позиции сверены в этом репозитории байт в байт с настоящими
// транзакциями. Для свапа такой эталонной транзакции пока нет, поэтому здесь
// проверка другого рода: собранное РАЗБИРАЕТСЯ ОБРАТНО — строго по смещениям,
// как это делает контракт, а не по памяти о раскладке. Ошибка в смещении
// перестаёт быть невидимой: разбор либо приведёт не туда, либо даст не то
// число.
//
// Почему это важнее обычного «сравнить строки»: в ABI половина ошибок — это
// смещения, и собранное с неверным смещением выглядит правдоподобно.
//
// Запуск: node --test tests/swap-calldata.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');
C.useChain('robinhood');

// Настоящий пул из этой сети.
const KEY = {
  currency0: '0x022c90ed10c2172bb9b2d54838bbe5d0827c4af1',
  currency1: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  fee: 40000, tickSpacing: 800,
  hooks: '0x0000000000000000000000000000000000000000',
};
const AMOUNT_IN  = 113000n * 10n ** 18n;
const MIN_OUT    = 13_500000n;
const DEADLINE   = 1789000000;

// ── независимый разбор ──────────────────────────────────────────────────────
const W = (h, i) => h.slice(i * 64, i * 64 + 64);            // слово по номеру
const num = (x) => BigInt('0x' + x);
const addr = (x) => '0x' + x.slice(24);

// bytes по смещению: длина, затем данные.
function readBytes(body, byteOff) {
  const i = byteOff * 2;
  const len = Number(num(body.slice(i, i + 64)));
  return body.slice(i + 64, i + 64 + len * 2);
}
// bytes[] по смещению: длина, затем смещения элементов ОТ НАЧАЛА массива.
function readBytesArray(body, byteOff) {
  const i = byteOff * 2;
  const n = Number(num(body.slice(i, i + 64)));
  const out = [];
  for (let k = 0; k < n; k++) {
    const rel = Number(num(body.slice(i + 64 + k * 64, i + 128 + k * 64)));
    out.push(readBytes(body, byteOff + 32 + rel));
  }
  return out;
}

test('свап собирается и разбирается обратно по смещениям', () => {
  const data = C.buildSwapCalldata({
    key: KEY, zeroForOne: true,
    amountIn: AMOUNT_IN, amountOutMin: MIN_OUT, deadline: DEADLINE,
  });

  assert.ok(data.startsWith('0x3593564c'), 'селектор execute(bytes,bytes[],uint256)');
  const body = data.slice(10);

  // Голова execute: смещение commands, смещение inputs, deadline.
  const offCmds = Number(num(W(body, 0)));
  const offInputs = Number(num(W(body, 1)));
  assert.strictEqual(Number(num(W(body, 2))), DEADLINE, 'срок годности на месте');

  const cmds = readBytes(body, offCmds);
  assert.strictEqual(cmds, '10', 'единственная команда — V4_SWAP (0x10)');

  const inputs = readBytesArray(body, offInputs);
  assert.strictEqual(inputs.length, 1, 'ровно один вход');

  // Внутри входа: abi.encode(bytes actions, bytes[] params).
  const inner = inputs[0];
  const actions = readBytes(inner, Number(num(W(inner, 0))));
  const params = readBytesArray(inner, Number(num(W(inner, 1))));

  assert.strictEqual(actions, '060c0f',
    'порядок действий: свап, заплатить, забрать');
  assert.strictEqual(params.length, 3, 'по параметру на действие');

  // Параметр свапа — структура динамическая, начинается со смещения.
  const sp = params[0];
  const s = sp.slice(Number(num(W(sp, 0))) * 2);
  assert.strictEqual(addr(W(s, 0)), KEY.currency0, 'currency0');
  assert.strictEqual(addr(W(s, 1)), KEY.currency1, 'currency1');
  assert.strictEqual(Number(num(W(s, 2))), KEY.fee, 'комиссия пула');
  assert.strictEqual(Number(num(W(s, 3))), KEY.tickSpacing, 'шаг тика');
  assert.strictEqual(addr(W(s, 4)), KEY.hooks, 'хук');
  assert.strictEqual(num(W(s, 5)), 1n, 'zeroForOne');
  assert.strictEqual(num(W(s, 6)), AMOUNT_IN, 'сколько отдаём');
  assert.strictEqual(num(W(s, 7)), MIN_OUT, 'сколько минимум получим');
  // hookData: смещение указывает за девять слов головы, длина ноль.
  assert.strictEqual(Number(num(W(s, 8))), 0x120, 'смещение hookData');
  assert.strictEqual(Number(num(W(s, 9))), 0, 'hookData пуст');

  // Платим той монетой, что отдаём; забираем ту, что получаем.
  assert.strictEqual(addr(W(params[1], 0)), KEY.currency0, 'платим currency0');
  assert.strictEqual(num(W(params[1], 1)), AMOUNT_IN, 'платим ровно столько');
  assert.strictEqual(addr(W(params[2], 0)), KEY.currency1, 'забираем currency1');
  assert.strictEqual(num(W(params[2], 1)), MIN_OUT, 'забираем не меньше минимума');
});

test('обратное направление меняет монеты местами, а не только флаг', () => {
  // Если бы направление меняло только zeroForOne, SETTLE и TAKE остались бы на
  // прежних монетах — роутер попытался бы взять не ту и отказать. Или, хуже,
  // взять ту, которую мы хотели оставить.
  const data = C.buildSwapCalldata({
    key: KEY, zeroForOne: false,
    amountIn: 1000000n, amountOutMin: 1n, deadline: DEADLINE,
  });
  const body = data.slice(10);
  const inner = readBytesArray(body, Number(num(W(body, 1))))[0];
  const params = readBytesArray(inner, Number(num(W(inner, 1))));
  const sp = params[0];
  const s = sp.slice(Number(num(W(sp, 0))) * 2);

  assert.strictEqual(num(W(s, 5)), 0n, 'zeroForOne выключен');
  assert.strictEqual(addr(W(params[1], 0)), KEY.currency1, 'платим теперь currency1');
  assert.strictEqual(addr(W(params[2], 0)), KEY.currency0, 'забираем currency0');
});

test('каждое слово calldata выровнено — длина кратна 32 байтам', () => {
  const data = C.buildSwapCalldata({
    key: KEY, zeroForOne: true, amountIn: 1n, amountOutMin: 0n, deadline: 1,
  });
  assert.strictEqual((data.length - 10) % 64, 0,
    'хвост не кратен слову — где-то потеряно выравнивание');
});

// ── ПУТЬ ИЗ ДВУХ ШАГОВ ──────────────────────────────────────────────────────
//
// Ради него всё и затевалось: на живой CHUMP прямой пул отдавал 0.83 доллара,
// а путь через нативную монету — 15.20. Кодирование здесь сложнее одношагового
// (массив динамических структур внутри динамической структуры), и ошибка в
// смещении дала бы правдоподобный на вид, но неверный путь. Поэтому разбираем
// обратно строго по смещениям.
const NATIVE = '0x' + '0'.repeat(40);
const PATH = [
  // первый шаг: монета -> нативная
  { currency: NATIVE, fee: 10020, tickSpacing: 200, hooks: NATIVE },
  // второй: нативная -> стейбл
  { currency: KEY.currency1, fee: 100, tickSpacing: 1, hooks: NATIVE },
];

test('двухшаговый путь собирается и разбирается обратно', () => {
  const data = C.buildSwapPathCalldata({
    currencyIn: KEY.currency0, path: PATH,
    amountIn: AMOUNT_IN, amountOutMin: MIN_OUT, deadline: DEADLINE,
  });
  assert.ok(data.startsWith('0x3593564c'), 'тот же execute, что у одношагового');
  const body = data.slice(10);

  const inputs = readBytesArray(body, Number(num(W(body, 1))));
  const inner = inputs[0];
  const actions = readBytes(inner, Number(num(W(inner, 0))));
  const params = readBytesArray(inner, Number(num(W(inner, 1))));

  // 07 вместо 06 — вот всё отличие в действиях.
  assert.strictEqual(actions, '070c0f', 'свап по пути, заплатить, забрать');

  const sp = params[0];
  const s = sp.slice(Number(num(W(sp, 0))) * 2);
  assert.strictEqual(addr(W(s, 0)), KEY.currency0, 'отдаём монету');
  const pathOff = Number(num(W(s, 1)));
  assert.strictEqual(pathOff, 0x80, 'путь лежит за четырьмя словами головы');
  assert.strictEqual(num(W(s, 2)), AMOUNT_IN, 'сколько отдаём');
  assert.strictEqual(num(W(s, 3)), MIN_OUT, 'сколько минимум получим');

  // Массив PathKey[]: длина, смещения, сами шаги по шесть слов.
  const arr = s.slice(pathOff * 2);
  assert.strictEqual(Number(num(W(arr, 0))), 2, 'в пути два шага');
  for (let i = 0; i < 2; i++) {
    const rel = Number(num(W(arr, 1 + i)));
    assert.strictEqual(rel, 2 * 32 + i * 6 * 32, `смещение шага ${i}`);
    const k = arr.slice((32 + rel) * 2);
    assert.strictEqual(addr(W(k, 0)), PATH[i].currency, `шаг ${i}: во что меняем`);
    assert.strictEqual(Number(num(W(k, 1))), PATH[i].fee, `шаг ${i}: комиссия`);
    assert.strictEqual(Number(num(W(k, 2))), PATH[i].tickSpacing, `шаг ${i}: шаг тика`);
    assert.strictEqual(addr(W(k, 3)), PATH[i].hooks, `шаг ${i}: хук`);
    assert.strictEqual(Number(num(W(k, 4))), 0xa0, `шаг ${i}: смещение hookData`);
    assert.strictEqual(Number(num(W(k, 5))), 0, `шаг ${i}: hookData пуст`);
  }

  // Платим первой монетой пути, забираем ПОСЛЕДНЕЙ. Промежуточную наружу не
  // выпускаем — если бы забирали её, монета осталась бы в нативной.
  assert.strictEqual(addr(W(params[1], 0)), KEY.currency0, 'платим монетой');
  assert.strictEqual(num(W(params[1], 1)), AMOUNT_IN);
  assert.strictEqual(addr(W(params[2], 0)), PATH[1].currency, 'забираем стейбл, а не нативную');
  assert.strictEqual(num(W(params[2], 1)), MIN_OUT);
});

test('PoolId считается от упорядоченной пары, а не от порядка аргументов', () => {
  // Ключ пула хранит монеты по возрастанию адреса. Если бы порядок зависел от
  // того, как их передали, вычисленный ключ не совпал бы с настоящим пулом, и
  // поиск узловых пулов молча находил бы пустоту.
  const K = require('../src/keccak.js');
  const a = C.computePoolId(KEY.currency0, KEY.currency1, 100, 1, null, K.keccak256);
  const b = C.computePoolId(KEY.currency1, KEY.currency0, 100, 1, null, K.keccak256);
  assert.strictEqual(a, b, 'порядок аргументов не должен менять ключ');
  assert.match(a, /^0x[0-9a-f]{64}$/, 'ключ — 32 байта');
});
