// Разрешения Permit2 читаются с цепочки для КОНКРЕТНОГО адреса.
//
// Адреса в репозитории намеренно нет: по нему видна вся торговля автора.
// Задайте свой, если хотите увидеть настоящие числа:
//
//   RH_TEST_OWNER=0xВашАдрес node tests/approvals.test.js
//
// Без него тест проверяет только то, что не требует чужих данных: что план
// выдачи разрешений вообще строится и не содержит лишних шагов.
const C = require('../src/core.js');
const OWNER = process.env.RH_TEST_OWNER ||
  '0x0000000000000000000000000000000000000001';   // заведомо пустой адрес
const USDG  = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
(async () => {
  // Публичный узел этой сети легко упирается в «Too Many Requests» — тогда
  // тест падал не из-за кода, а из-за чужой нагрузки. Свой узел, если задан,
  // берём первым.
  const rpc = C.makeRpc(process.env.RH_RPC || C.RH.publicRpc);
  const a = await C.readAllowances(rpc, USDG, OWNER);
  const MAX = (1n << 256n) - 1n;
  console.log(`  ERC20 → Permit2: ${a.erc20ToPermit2 === MAX ? 'БЕССРОЧНО НА ВСЁ' : a.erc20ToPermit2}`);
  console.log(`  Permit2 → PositionManager: ${a.permit2Amount}`);
  const left = a.permit2Expiration - Math.floor(Date.now() / 1000);
  console.log(`  срок: ${a.permit2Expiration}` +
    (left > 0 ? ` (осталось ${(left/3600).toFixed(1)} ч)` : ' (истёк)'));
  console.log(`  счётчик подписей: ${a.permit2Nonce}`);

  const now = Math.floor(Date.now() / 1000);
  const need = 2n * 10n ** 6n;                    // 2 USDG
  const plan = await C.planApprovals(rpc, USDG, OWNER, need, 900, now);
  console.log(`\n  для входа на 2 USDG нужно шагов: ${plan.steps.length}`);
  for (const s of plan.steps) {
    console.log(`    — ${s.what}, на ${s.amount}` + (s.until ? `, до ${s.until}` : ''));
    console.log(`      данные: ${s.tx.data.slice(0, 10)}… (${(s.tx.data.length-2)/2} байт) на ${s.tx.to}`);
  }
  // Наши разрешения обязаны быть ОГРАНИЧЕННЫМИ
  const erc = C.buildErc20Approve(USDG, need);
  const big = BigInt('0x' + erc.data.slice(10 + 64));
  console.log(`\n  наш approve даёт ровно ${big} (не бесконечность): ` +
              (big === need ? 'ок' : 'ПРОВАЛ'));
  if (big !== need) process.exitCode = 1;
})().catch(e => { console.log('СБОЙ: ' + e.message); process.exitCode = 1; });
