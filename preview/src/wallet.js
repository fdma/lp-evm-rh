// Работа с кошельком. Всё, что связано с подписью, живёт здесь и сводится
// к одному: попросить Rabby показать транзакцию автору.
//
// Терминал НЕ хранит и НЕ запрашивает приватный ключ, seed или пароль.
// Единственное, что он делает, — передаёт готовую транзакцию кошельку.
// Подтверждает всегда человек.

'use strict';

window.RHWallet = (() => {
  const C = window.RHCore;

  function provider() {
    const p = window.ethereum;
    if (!p) throw new Error('кошелёк не найден — установи Rabby или MetaMask');
    // Если стоят несколько кошельков, выбираем Rabby явно.
    if (p.providers && p.providers.length) {
      return p.providers.find(x => x.isRabby) || p.providers[0];
    }
    return p;
  }

  async function connect() {
    const p = provider();
    const accounts = await p.request({ method: 'eth_requestAccounts' });
    if (!accounts || !accounts.length) throw new Error('кошелёк не дал адрес');
    const chainId = Number(BigInt(await p.request({ method: 'eth_chainId' })));
    return { address: accounts[0], chainId, provider: p };
  }

  // Сеть кошелька обязана совпадать с сетью, для которой мы всё посчитали.
  // Иначе транзакция уйдёт не туда — это тот случай, когда лучше отказать.
  async function ensureChain(p) {
    const id = Number(BigInt(await p.request({ method: 'eth_chainId' })));
    if (id === C.RH.chainId) return true;
    try {
      await p.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: '0x' + C.RH.chainId.toString(16) }],
      });
      return true;
    } catch (e) {
      throw new Error(`кошелёк в сети ${id}, нужна ${C.RH.chainId} — переключи сам`);
    }
  }

  async function send({ from, to, data, value = '0x0' }) {
    const p = provider();
    await ensureChain(p);
    return p.request({
      method: 'eth_sendTransaction',
      params: [{ from, to, data, value }],
    });
  }

  function onAccountsChanged(cb) {
    try { provider().on('accountsChanged', cb); } catch (e) { /* нет кошелька */ }
  }

  function onChainChanged(cb) {
    try { provider().on('chainChanged', cb); } catch (e) { /* нет кошелька */ }
  }

  return { connect, send, ensureChain, onAccountsChanged, onChainChanged };
})();
