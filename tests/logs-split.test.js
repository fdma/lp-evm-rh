'use strict';
// Неполное чтение журнала обязано быть видно. Узел без архива отказывает
// на старых блоках; брать новую половину правильно, но молчать об этом —
// значит показать неполный список позиций как полный.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/core.js');

test('отказ архива помечает результат partialFrom', async () => {
  const OLDEST = 60000;                        // узел помнит только отсюда
  const rpc = async (method, [q]) => {
    const from = Number(BigInt(q.fromBlock)), to = Number(BigInt(q.toBlock));
    if (from < OLDEST) throw new Error('eth_getLogs: archive requests require a personal token');
    return [{ blockNumber: '0x' + to.toString(16) }];
  };
  const logs = await C.getLogsSplit(rpc, {}, 0, 100000);
  assert.ok(logs.length >= 1);
  assert.ok(logs.partialFrom >= OLDEST, `partialFrom ${logs.partialFrom} должен быть ≥ ${OLDEST}`);
});

test('полное чтение partialFrom не ставит', async () => {
  const rpc = async () => [{ blockNumber: '0x1' }];
  const logs = await C.getLogsSplit(rpc, {}, 0, 100);
  assert.strictEqual(logs.partialFrom, undefined);
});
