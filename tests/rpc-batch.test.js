// ПАЧКА ВЫЗОВОВ К УЗЛУ.
//
// makeRpc складывает вызовы, случившиеся в одном тике, в один запрос. Замер на
// живом узле: восемь вызовов пачкой 715 мс против 1555 мс по очереди.
//
// Проверяется здесь не скорость, а то, что от пачки не пострадала
// правильность: ответы должны приходить СВОИМ вызовам, ошибка одного не должна
// ронять соседей, а узел без поддержки пачек не должен ломать терминал.
//
// Узел подменяется заглушкой: живая сеть тут не нужна и только мешала бы.
//
// Запуск: node --test tests/rpc-batch.test.js
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');

// Заглушка узла. Считает обращения и умеет притворяться как поддерживающей
// пачки, так и не поддерживающей.
function fakeNode({ batches = true, failIds = [] } = {}) {
  const calls = [];                       // по одному на HTTP-обращение
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(Array.isArray(body) ? body.length : 1);
    const answer = (r) => failIds.includes(r.params && r.params[0])
      ? { jsonrpc: '2.0', id: r.id, error: { message: 'нарочная ошибка' } }
      : { jsonrpc: '2.0', id: r.id, result: '0x' + String(r.params[0]) };
    if (Array.isArray(body)) {
      if (!batches) return { json: async () => ({ error: { message: 'пачки не умею' } }) };
      // Порядок ответов намеренно перемешан: узел вправе отвечать как угодно,
      // и разбирать их надо ПО НОМЕРУ, а не по позиции.
      return { json: async () => body.map(answer).reverse() };
    }
    return { json: async () => answer(body) };
  };
  return { f, calls };
}

test('вызовы одного тика уходят одним обращением', async () => {
  const n = fakeNode();
  const rpc = C.makeRpc('http://x', n.f);
  const r = await Promise.all([1, 2, 3, 4, 5].map(i => rpc('eth_call', [i])));
  assert.deepStrictEqual(r, ['0x1', '0x2', '0x3', '0x4', '0x5'],
    'каждый вызов обязан получить СВОЙ ответ');
  assert.strictEqual(n.calls.length, 1, 'должно быть одно обращение');
  assert.strictEqual(n.calls[0], 5, 'в нём пять вызовов');
});

test('ответы разбираются по номеру, а не по порядку', async () => {
  // Заглушка отдаёт ответы задом наперёд. Если разбирать по позиции, каждый
  // вызов получит чужой результат — и это самая тихая из возможных поломок:
  // числа на экране будут правдоподобными, но не теми.
  const n = fakeNode();
  const rpc = C.makeRpc('http://x', n.f);
  const r = await Promise.all([10, 20, 30].map(i => rpc('eth_call', [i])));
  assert.deepStrictEqual(r, ['0x10', '0x20', '0x30']);
});

test('последовательные вызовы в пачку не попадают', async () => {
  const n = fakeNode();
  const rpc = C.makeRpc('http://x', n.f);
  await rpc('eth_call', [1]);
  await rpc('eth_call', [2]);
  assert.strictEqual(n.calls.length, 2, 'они и не параллельны — складывать нечего');
});

test('одинокий вызов идёт как обычный, а не пачкой из одного', async () => {
  const n = fakeNode();
  const rpc = C.makeRpc('http://x', n.f);
  await rpc('eth_call', [1]);
  assert.strictEqual(n.calls[0], 1, 'накладные пачки тут лишние');
});

test('отправка транзакции пачкой не идёт НИКОГДА', async () => {
  // Повторять и складывать можно только чтение. Отправку нельзя ни повторять,
  // ни задерживать на тик ради компании.
  const n = fakeNode();
  const rpc = C.makeRpc('http://x', n.f);
  await Promise.all([
    rpc('eth_sendRawTransaction', [1]),
    rpc('eth_sendRawTransaction', [2]),
  ]);
  assert.strictEqual(n.calls.length, 2);
  assert.ok(n.calls.every(c => c === 1), 'каждая ушла отдельно');
});

test('ошибка на одном вызове не роняет соседей', async () => {
  const n = fakeNode({ failIds: [2] });
  const rpc = C.makeRpc('http://x', n.f);
  const r = await Promise.allSettled([1, 2, 3].map(i => rpc('eth_call', [i])));
  assert.strictEqual(r[0].status, 'fulfilled');
  assert.strictEqual(r[2].status, 'fulfilled');
  assert.strictEqual(r[0].value, '0x1');
  assert.strictEqual(r[2].value, '0x3');
  // Повторы у чтения есть, поэтому упавший придёт с отказом только после них.
  assert.strictEqual(r[1].status, 'rejected');
});

test('узел без поддержки пачек — работаем по одному и больше не пробуем', async () => {
  const n = fakeNode({ batches: false });
  const rpc = C.makeRpc('http://x', n.f);
  const r = await Promise.all([1, 2, 3].map(i => rpc('eth_call', [i])));
  assert.deepStrictEqual(r, ['0x1', '0x2', '0x3'], 'ответы всё равно верные');
  // Первая попытка пачкой + три одиночных.
  assert.ok(n.calls.length >= 4, `ожидал откат на одиночные, обращений ${n.calls.length}`);

  const было = n.calls.length;
  await Promise.all([4, 5].map(i => rpc('eth_call', [i])));
  const стало = n.calls.length - было;
  assert.strictEqual(стало, 2, 'второй раз пачкой уже не пробуем');
});
