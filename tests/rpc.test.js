// Проверка узла: как терминал будет вести себя с разными адресами.
const C = require('../src/core.js');
C.useChain('robinhood');   // ядро стало двухсетевым — выбираем явно
(async () => {
  const cases = [
    ['публичный Robinhood', C.RH.publicRpc],
    ['чужая сеть (Base)',   'https://mainnet.base.org'],
    ['несуществующий',      'https://rpc.this-host-does-not-exist.invalid'],
  ];
  for (const [name, url] of cases) {
    const r = await C.testRpc(url);
    if (r.ok) {
      console.log(`  ${name}: ГОДЕН, сеть ${r.chainId}, блок ${r.block}, ` +
                  `задержка ${await r.latency} мс`);
    } else {
      console.log(`  ${name}: ОТКАЗ — ${r.why}`);
    }
  }
})();
