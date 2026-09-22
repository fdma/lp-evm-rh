// АНИМАЦИИ ИНТЕРФЕЙСА — ОТДЕЛЬНО ОТ ЛОГИКИ.
//
// Здесь только то, чего не сделать одним CSS: подложка сегментного
// переключателя, которая переезжает к выбранной кнопке, вспышка цены при
// изменении и мерцание надписей «читаю…». Файл ничего не знает о деньгах,
// узлах и кошельке и ничего в них не трогает: он смотрит на DOM, который
// рисует ui.js, и только добавляет классы. Упадёт он — терминал работает как
// работал, просто без анимаций.
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  // ── подложка сегментов ────────────────────────────────────────────────
  //
  // Кнопки в .seg перерисовываются целиком (ui.js чистит строку и собирает
  // заново), поэтому подложка восстанавливается при каждом таком проходе.
  // Двигаем её transform'ом — это композитится и не перекладывает страницу.
  //
  // ui.js при каждом выборе собирает строку кнопок заново, и подложка
  // пропадает вместе с ними. Поэтому новая подложка ставится туда, где стояла
  // прежняя (last), и уже оттуда едет к выбранной — со стороны это один
  // плавный проезд, а не мигание.
  const last = new WeakMap();
  const put = (ind, p) => {
    ind.style.width = p.w + 'px';
    ind.style.height = p.h + 'px';
    ind.style.transform = `translate(${p.x}px, ${p.y}px)`;
  };
  function place(seg, animate) {
    let ind = seg.querySelector(':scope > .seg-ind');
    const on = seg.querySelector(':scope > button.on, :scope > button.go');
    const target = on && on.offsetWidth
      ? { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight }
      : null;
    if (!ind) {
      ind = document.createElement('span');
      ind.className = 'seg-ind';
      seg.prepend(ind);
      seg.classList.add('has-ind');
      const prev = last.get(seg);
      if (prev && target && animate) {
        seg.classList.add('no-anim');
        put(ind, prev);
        void ind.offsetWidth;            // зафиксировать старое место
        seg.classList.remove('no-anim');
      } else {
        animate = false;                 // первое появление — без проезда
      }
    }
    if (!target) { ind.style.opacity = '0'; return; }
    if (!animate) seg.classList.add('no-anim');
    ind.style.opacity = '1';
    put(ind, target);
    last.set(seg, target);
    if (!animate) {
      // Снять запрет на следующем кадре, когда позиция уже применена.
      requestAnimationFrame(() => requestAnimationFrame(() => seg.classList.remove('no-anim')));
    }
  }

  const segs = new Set();
  function watchSeg(seg) {
    if (segs.has(seg)) return;
    segs.add(seg);
    let queued = false;
    const again = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; place(seg, true); });
    };
    new MutationObserver(again).observe(seg, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class'],
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => place(seg, false)).observe(seg);
    }
    place(seg, false);
  }

  // ── вспышка цены ──────────────────────────────────────────────────────
  //
  // Цена приходит подпиской в момент обмена. Короткая вспышка цвета
  // показывает, куда она двинулась, — глаз ловит направление раньше цифр.
  function watchPrice(el) {
    const num = (s) => {
      const m = String(s || '').replace(/[\s,]/g, '').match(/-?\d+(\.\d+)?(e-?\d+)?/i);
      if (!m) return null;
      let v = parseFloat(m[0]);
      // «$1.2M», «850K» — капитализация с приставкой.
      if (/b\b|млрд/i.test(s)) v *= 1e9;
      else if (/m\b|млн/i.test(s)) v *= 1e6;
      else if (/k\b|тыс/i.test(s)) v *= 1e3;
      return v;
    };
    let last = num(el.textContent);
    new MutationObserver(() => {
      const v = num(el.textContent);
      if (v == null || last == null || v === last) { last = v; return; }
      const cls = v > last ? 'tick-up' : 'tick-down';
      last = v;
      el.classList.remove('tick-up', 'tick-down');
      void el.offsetWidth;               // перезапустить анимацию
      el.classList.add(cls);
    }).observe(el, { childList: true, characterData: true, subtree: true });
  }

  // ── мерцание «идёт работа» ────────────────────────────────────────────
  const BUSY = /^\s*(читаю|ищу|проверяю|жду|загружаю)/i;
  function markBusy(root) {
    for (const el of root.querySelectorAll('.hint, .dim, #s-rpc')) {
      el.classList.toggle('shimmer', BUSY.test(el.textContent) && el.children.length === 0);
    }
  }
  function watchBusy(root) {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; markBusy(root); });
    }).observe(root, { childList: true, subtree: true, characterData: true });
    markBusy(root);
  }

  function start() {
    document.querySelectorAll('.seg').forEach(watchSeg);
    const price = document.getElementById('price');
    if (price) watchPrice(price);
    for (const id of ['pos', 'hist', 's-rpc']) {
      const el = document.getElementById(id);
      if (el) watchBusy(id === 's-rpc' ? el.parentNode : el);
    }
    // Шрифты и раскладка устаканиваются после загрузки — переставить подложки.
    window.addEventListener('load', () => segs.forEach(s => place(s, false)));
  }

  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  } catch (e) { /* анимации не обязательны */ }
})();
