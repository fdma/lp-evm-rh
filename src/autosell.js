// Автопродажа монеты сразу после выхода из позиции.
//
// ЗДЕСЬ ТОЛЬКО РЕШЕНИЯ. Продавать ли, что именно, и не слишком ли дорого.
// Маршрут ищет ядро (pickBestSwap/planSwap), сделку подписывает кошелёк.
// Разделение не для красоты: всё, что ниже, — чистые функции без сети, их
// видно целиком и они проверяются тестом. Это единственное место терминала,
// где деньги уходят без нажатия «продать», и цена ошибки здесь выше обычной.
//
// ЧЕМ ИСПОЛНЯЕТСЯ ПРОДАЖА И ПОЧЕМУ ИМЕННО ТАК.
//
// Исполняет агрегатор KyberSwap: он ищет маршрут и отдаёт готовую к подписи
// сделку вместе с адресом своего роутера. Его роутер берёт монету обычным
// approve, без Permit2 — значит одно разрешение один раз, а не два.
//
// Свой путь — перебор пулов, котировка через V4Quoter, сборка для
// UniversalRouter — собран, лежит в ядре и покрыт тестами. Считает он верно:
// на монете с 27 прямыми пулами дал 14.3334 USDG против 14.3336 у агрегатора,
// а на CHUMP нашёл путь через нативную монету в шестнадцать раз выгоднее
// прямого. Но в бою он НЕ РАБОТАЕТ на парах ERC-20: свап откатывается без
// данных об ошибке.
//
// Что проверено и исключено (замеры на живой сети, блок 60261034):
//   кодирование верно — тем же кодировщиком свап НАТИВНОЙ монеты проходит;
//   ключи пулов верны — пересчёт из ключа совпал с PoolId из событий;
//   пул живой — sqrtPrice ненулевой, ликвидность есть;
//   монета на кошельке была, разрешения были, Permit2.transferFrom проходит;
//   роутер тот самый — poolManager() совпадает с нашим;
//   не проскальзывание, не сумма, не газ, не направление.
// Если оставить одно действие «только свап», нативный пул отвечает внятным
// CurrencyNotSettled (то есть свап ИСПОЛНИЛСЯ), а ERC-20 — пустым откатом.
// Причина не найдена; трассировка на доступном тарифе узла закрыта.
//
// Урок на будущее: структурные тесты этого не поймали, потому что разбирают
// собранное той же логикой, какой собирают, — общее заблуждение проходит
// насквозь. Сверяться надо с НАСТОЯЩЕЙ успешной транзакцией, как сделано для
// входа и выхода. Как только такая найдётся — свой путь можно включать и
// внешняя служба уйдёт совсем.
//
// ПРО КОМИССИИ. Отдельно они не продаются никогда. Пул отдаёт накопленное
// вместе с телом позиции одним движением, и уходит оно тем же одним свапом.
// Это правило в decide(), а не настройка.

'use strict';

const RHAutoSell = (() => {

  // Память браузера. В node её нет, а решения ниже проверяются тестами именно
  // в node — поэтому через заглушку, а не напрямую.
  const LS = (typeof localStorage !== 'undefined') ? localStorage : null;

  // ── настройки ─────────────────────────────────────────────────────────────
  //
  // Ключ ОДИН на все сети, в отличие от прочей памяти терминала. Это
  // сознательно: «включено для BSC, выключено для Robinhood» означало бы, что
  // человек не знает наверняка, продаются его деньги сами или нет.
  const KEY = 'lp-autosell';

  const S = {
    on: false,          // выключено по умолчанию: это трата денег, включать осознанно
    slippage: 5,        // проценты; у монеты сразу после выхода разброс широкий
    // Только выход. Снятие комиссий отдельной кнопкой автопродажу не
    // запускает НИКОГДА — правило ниже в decide(), это не настройка.
    modes: { all: true, half: true },
  };

  function load() {
    try {
      const s = JSON.parse((LS && LS.getItem(KEY)) || '{}');
      if (typeof s.on === 'boolean') S.on = s.on;
      if (Number.isFinite(s.slippage)) S.slippage = s.slippage;
      if (s.modes && typeof s.modes === 'object') Object.assign(S.modes, s.modes);
    } catch (e) { /* первая загрузка */ }
    return S;
  }

  function save() {
    try { if (LS) LS.setItem(KEY, JSON.stringify(S)); } catch (e) { }
  }

  // ── что считать монетой ───────────────────────────────────────────────────
  //
  // Продаём ТОЛЬКО волатильную сторону пары. Вторая сторона — это уже
  // результат, и гонять её через обмен значит платить за превращение доллара
  // в доллар. Список тот же, что в остальном терминале: два разных
  // представления о том, что такое стейбл, — верный способ однажды продать не
  // ту сторону.
  const STABLE = /^(usdt|usdc|busd|fdusd|usd1|dai|usde|frax|tusd|usdg|bnb|wbnb)$/i;

  // Подмножество: те стейблы, что действительно стоят доллар. В STABLE
  // намеренно входит и BNB — это сторона, в которую выходят, продавать её не
  // надо, — но доллар она не стоит. Разница нужна там, где число идёт в журнал
  // со знаком доллара: писать «$5» про пять BNB нельзя.
  const USD_STABLE = /^(usdt|usdc|busd|fdusd|usd1|dai|usde|frax|tusd|usdg)$/i;
  const isUsdStable = (sym) => USD_STABLE.test(sym || '');

  // 0 или 1 — какая сторона пары монета. null значит «не берусь судить», и это
  // НЕ повод продать наугад.
  function coinSide(sym0, sym1) {
    const s0 = STABLE.test(sym0 || ''), s1 = STABLE.test(sym1 || '');
    if (s0 && !s1) return 1;
    if (s1 && !s0) return 0;
    return null;
  }

  // ── решение ───────────────────────────────────────────────────────────────
  //
  // Всё, что может остановить продажу, останавливает её ЗДЕСЬ и с внятной
  // причиной. Молчаливый отказ в таком месте хуже ошибки: человек будет ждать
  // продажи, которой не было.
  //
  // ctx: { mode, sym0, sym1, raw0, raw1, dec0, dec1, addr0, addr1 }
  // dec может быть null — узел не всегда отдаёт decimals.
  function decide(ctx) {
    const no = (why) => ({ sell: false, why });

    if (!S.on) return no('автопродажа выключена');

    // ЖЁСТКОЕ ПРАВИЛО, А НЕ НАСТРОЙКА.
    //
    // Комиссии продаются только вместе с выходом и одним свапом. Отдельная
    // кнопка «Комиссии» снимает накопленное, не трогая позицию, и продавать
    // это нельзя: приходит оно крохами и часто, а выход даже на приличной
    // монете стоит денег — на плохом пуле замерено от 7% до 25%. От снятой
    // комиссии не осталось бы ничего. Сделано правилом, чтобы этого нельзя
    // было включить по ошибке.
    if (ctx.mode === 'fees') {
      return no('снятие комиссий автопродажу не запускает — ' +
                'комиссии продаются только вместе с выходом');
    }
    if (!S.modes[ctx.mode]) return no(`для «${ctx.mode}» автопродажа не включена`);

    const side = coinSide(ctx.sym0, ctx.sym1);
    if (side === null) {
      return no(STABLE.test(ctx.sym0 || '') && STABLE.test(ctx.sym1 || '')
        ? 'обе стороны пары — стейблы, продавать нечего'
        : 'в паре нет стейбла, не берусь решать какую сторону продавать');
    }

    const raw = side === 0 ? ctx.raw0 : ctx.raw1;
    const dec = side === 0 ? ctx.dec0 : ctx.dec1;
    const sym = side === 0 ? ctx.sym0 : ctx.sym1;
    const addr = side === 0 ? ctx.addr0 : ctx.addr1;
    const into = side === 0 ? ctx.addr1 : ctx.addr0;
    const intoSym = side === 0 ? ctx.sym1 : ctx.sym0;
    const intoDec = side === 0 ? ctx.dec1 : ctx.dec0;

    if (!raw || raw <= 0n) return no(`${sym} из закрытия не вернулся`);

    // Сколько это в штуках монеты — ТОЛЬКО ДЛЯ ПОКАЗА. Продаётся всегда raw,
    // точное целое из квитанции.
    //
    // dec может прийти пустым: узел иногда не отдаёт decimals(). Раньше на его
    // месте молча вставала восемнадцать, и это попадало в денежную математику —
    // у монеты с шестью знаками цена уезжала в 10^12 раз. Теперь неизвестное
    // остаётся неизвестным: сумму продажи это не трогает, а выдуманное число
    // человеку не показывается.
    const amount = (dec == null) ? null : Number(raw) / Math.pow(10, dec);

    return {
      sell: true, side, addr, sym, dec, raw, amount, into, intoSym, intoDec,
      usdQuote: isUsdStable(intoSym),
      why: amount == null
        ? `продаю ${raw} ${sym} (в базовых единицах: узел не отдал decimals)`
        : `продаю ${amount} ${sym}`,
    };
  }

  // Проскальзывание человек задаёт в процентах, контракты считают в сотых
  // долях процента. Пересчёт живёт ЗДЕСЬ, в одном месте: цена ошибки —
  // защита в сто раз слабее или в сто раз строже заказанной, и по журналу
  // этого не увидеть.
  //
  // Ниже единицы — ноль защиты, «исполни по любой цене». Выше половины —
  // почти наверняка опечатка в поле «своё», и такую заявку лучше не
  // отправлять вовсе, чем отдать монету за бесценок.
  function slippageBps() {
    return Math.min(5000, Math.max(1, Math.round(Number(S.slippage) * 100)));
  }

  // ── АГРЕГАТОР ─────────────────────────────────────────────────────────────
  //
  // Два обращения, и оба обязательны. Первое ищет маршрут, второе превращает
  // найденный маршрут в готовую сделку. Разделено это не нами: маршрут живёт
  // недолго, и собирать от несвежего нельзя — ровно на этом живая продажа уже
  // отваливалась, когда между расчётом и подписью проходило двадцать секунд.
  //
  // Ходит прямо из браузера: агрегатор отвечает `access-control-allow-origin`
  // с нашим адресом, посредник на своей машине не нужен.
  const API = 'https://aggregator-api.kyberswap.com';

  // Нативная монета у агрегатора обозначается псевдоадресом, а не нулями,
  // которыми её пишет Uniswap V4. Перепутать — получить маршрут в
  // несуществующий токен.
  const NATIVE_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const forApi = (a) => (/^0x0{40}$/i.test(a || '') ? NATIVE_PSEUDO : a);

  async function ask(url, init) {
    const r = await fetch(url, init);
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* Cloudflare отвечает html */ }
    if (!r.ok || !j) {
      throw new Error(`агрегатор ответил ${r.status}: ` +
                      ((j && j.message) || text.slice(0, 120)));
    }
    // Свой код поверх HTTP: 200 с code!=0 это отказ.
    if (j.code !== 0) throw new Error(`агрегатор: ${j.message || 'код ' + j.code}`);
    return j.data;
  }

  async function route(chain, tokenIn, tokenOut, amountIn) {
    const q = new URLSearchParams({
      tokenIn: forApi(tokenIn), tokenOut: forApi(tokenOut), amountIn: String(amountIn),
    });
    return ask(`${API}/${chain}/api/v1/routes?${q}`, { headers: { 'x-client-id': 'lp-evm-rh' } });
  }

  async function build(chain, routeSummary, sender, slippageBpsValue) {
    return ask(`${API}/${chain}/api/v1/route/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-client-id': 'lp-evm-rh' },
      body: JSON.stringify({
        routeSummary,
        sender, recipient: sender,      // продаём себе же, посредников нет
        slippageTolerance: slippageBpsValue,
        source: 'lp-evm-rh',
      }),
    });
  }

  // Всё вместе: от «сколько монеты» до готовой к подписи сделки.
  // Роутер отдаётся отдельно — ему нужно разрешение до отправки.
  async function plan({ chain, tokenIn, tokenOut, amountIn, sender, slippageBps: bps,
                        expectRouter }) {
    const r = await route(chain, tokenIn, tokenOut, amountIn);
    const b = await build(chain, r.routeSummary, sender, bps);
    const router = b.routerAddress || r.routerAddress;

    // СВЕРКА АДРЕСА. Транзакция уходит на router, и ему же выдано разрешение
    // на монету. Принять сюда что угодно из ответа — значит позволить чужому
    // серверу назначить получателя наших денег.
    if (expectRouter && (router || '').toLowerCase() !== expectRouter.toLowerCase()) {
      throw new Error(`агрегатор назвал чужой роутер ${router} вместо ` +
                      `${expectRouter} — сделку не отправляю`);
    }
    return {
      to: router, router, data: b.data,
      amountOut: BigInt(b.amountOut || r.routeSummary.amountOut || 0),
      amountInUsd: Number(r.routeSummary.amountInUsd || 0),
      amountOutUsd: Number(r.routeSummary.amountOutUsd || 0),
      gasUsd: Number(r.routeSummary.gasUsd || 0),
      // Сколько площадок в маршруте: одна означает, что дробить было не по
      // чему, и проскальзывание будет как в том пуле.
      hops: (r.routeSummary.route || []).reduce((n, leg) => n + leg.length, 0),
    };
  }

  return { load, save, settings: S, decide, slippageBps,
           route, build, plan, forApi, NATIVE_PSEUDO, API,
           coinSide, isUsdStable, STABLE, USD_STABLE };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RHAutoSell;
if (typeof window !== 'undefined') window.RHAutoSell = RHAutoSell;
