// tooltip.js - Hover tooltips for any element with data-tip="...".
//
// One floating element on <body>, position: fixed. A CSS ::after tooltip
// lives inside its element, so any ancestor with overflow (cards, wizard
// tabs, modals) cut it off no matter the z-index.

'use strict';

(function () {
  let tip = null;
  let owner = null;

  function el() {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'kc-tooltip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }
    return tip;
  }

  function show(target) {
    const text = target.getAttribute('data-tip');
    if (!text) return;
    owner = target;
    const t = el();
    t.textContent = text;
    t.classList.add('visible');
    const r = target.getBoundingClientRect();
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const gap = 8;
    // Above by default; below when there is no room at the top.
    let top = r.top - h - gap;
    if (top < 4) top = r.bottom + gap;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
    t.style.top = `${Math.round(top)}px`;
    t.style.left = `${Math.round(left)}px`;
  }

  function hide() {
    owner = null;
    if (tip) tip.classList.remove('visible');
  }

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest && e.target.closest('[data-tip]');
    if (target === owner) return;
    if (target) show(target); else hide();
  });
  // Re-rendered pages replace the hovered node; never leave a tip stranded.
  document.addEventListener('scroll', hide, true);
  document.addEventListener('mousedown', hide, true);
  window.addEventListener('blur', hide);
})();
