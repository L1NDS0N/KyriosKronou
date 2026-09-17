// pathInput.js - Path autocomplete for any text field that holds a Windows path.
//
// Typing a full path by hand is the slowest and most error-prone part of
// creating a task, service or backup profile, and a typo only surfaces later as
// a failed run. Attach this to an input and it completes against the real
// filesystem as the user types, and tells them straight away when a path does
// not exist.
//
// Usage:
//   PathInput.attach(inputElement, { kind: 'file', extensions: ['.ps1'] });
//   PathInput.attachAll();            // every [data-path-input] on the page

(function (global) {
  'use strict';

  const OPEN_CLASS = 'path-ac-open';

  // The component is loaded before i18n in some paths, so fall back rather
  // than showing a raw key.
  const tr = (key, fallback) =>
    (global.i18n && typeof global.i18n.t === 'function' && global.i18n.t(key) !== key)
      ? global.i18n.t(key) : fallback;
  const DEBOUNCE_MS = 120;

  let activeBox = null;

  function closeActive() {
    if (!activeBox) return;
    activeBox.list.remove();
    activeBox.input.classList.remove(OPEN_CLASS);
    activeBox = null;
  }

  document.addEventListener('click', (e) => {
    if (activeBox && !activeBox.list.contains(e.target) && e.target !== activeBox.input) closeActive();
  });
  window.addEventListener('resize', closeActive);
  // A dropdown anchored to the viewport has to follow its input when the modal
  // behind it scrolls, or it detaches and floats over unrelated content.
  window.addEventListener('scroll', () => { if (activeBox) position(activeBox); }, true);

  function position(box) {
    const r = box.input.getBoundingClientRect();
    box.list.style.left = r.left + 'px';
    box.list.style.top = (r.bottom + 2) + 'px';
    box.list.style.width = r.width + 'px';
  }

  function render(box, result) {
    const items = (result && result.suggestions) || [];
    box.items = items;
    box.index = -1;

    if (!items.length) {
      const noneMsg = result && result.error === 'not-found'
        ? tr('path.folderNotFound', 'That folder does not exist')
        : tr('path.nothingFound', 'Nothing found');
      box.list.innerHTML = '<div class="path-ac-empty">' + noneMsg + '</div>';
      return;
    }

    box.list.innerHTML = items.map((s, i) =>
      '<div class="path-ac-item" data-i="' + i + '">'
      + '<span class="path-ac-icon">' + (s.directory ? '📁' : '📄') + '</span>'
      + '<span class="path-ac-name">' + escapeHtml(s.name) + '</span>'
      + (s.hint ? '<span class="path-ac-hint">' + escapeHtml(s.hint) + '</span>' : '')
      + '</div>').join('');

    box.list.querySelectorAll('.path-ac-item').forEach((el) => {
      el.addEventListener('mousedown', (ev) => {
        // mousedown, not click: the input's blur would close the list first.
        ev.preventDefault();
        choose(box, parseInt(el.getAttribute('data-i'), 10));
      });
    });
  }

  function highlight(box, next) {
    const els = box.list.querySelectorAll('.path-ac-item');
    if (!els.length) return;
    if (box.index >= 0 && els[box.index]) els[box.index].classList.remove('active');
    box.index = (next + els.length) % els.length;
    els[box.index].classList.add('active');
    els[box.index].scrollIntoView({ block: 'nearest' });
  }

  function choose(box, i) {
    const item = box.items[i];
    if (!item) return;
    box.input.value = item.full;
    box.input.dispatchEvent(new Event('input', { bubbles: true }));
    box.input.dispatchEvent(new Event('change', { bubbles: true }));
    // A directory is probably not the destination - keep completing into it.
    if (item.directory) query(box);
    else { closeActive(); validate(box); }  // a chosen file is a final answer
    box.input.focus();
  }

  async function query(box) {
    let result;
    try { result = await window.api.suggestPath(box.input.value, box.options); }
    catch (e) { return; }
    if (activeBox !== box) return;
    render(box, result);
    position(box);
  }

  function open(box) {
    if (activeBox === box) return;
    closeActive();
    const list = document.createElement('div');
    list.className = 'path-ac-list';
    document.body.appendChild(list);
    box.list = list;
    box.input.classList.add(OPEN_CLASS);
    activeBox = box;
    position(box);
    query(box);
  }

  /** Mark the field when the path does not exist, so a typo is caught now. */
  async function validate(box) {
    if (!box.input.value.trim()) {
      box.input.classList.remove('path-invalid', 'path-valid');
      if (box.status) box.status.textContent = '';
      return;
    }
    let result;
    try { result = await window.api.validatePath(box.input.value, box.options); }
    catch (e) { return; }

    const ok = result.exists && result.valid !== false;
    box.input.classList.toggle('path-invalid', !ok);
    box.input.classList.toggle('path-valid', ok);
    if (box.status) {
      box.status.textContent = ok ? '' : (result.messageKey ? tr(result.messageKey, result.messageKey) : '');
      box.status.className = 'path-status' + (ok ? '' : ' bad');
    }
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function attach(input, options) {
    if (!input || input.__pathInput) return;
    input.__pathInput = true;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    const box = { input, options: options || {}, items: [], index: -1, list: null, status: null };

    // A place to explain a bad path without shifting the layout.
    const status = document.createElement('div');
    status.className = 'path-status';
    if (input.parentNode) input.parentNode.insertBefore(status, input.nextSibling);
    box.status = status;

    let timer = null;
    input.addEventListener('input', () => {
      // Clear a previous verdict as soon as the text changes: a half-typed path
      // is not "wrong", and flagging it mid-word is just noise.
      input.classList.remove('path-invalid', 'path-valid');
      if (box.status) box.status.textContent = '';
      clearTimeout(timer);
      timer = setTimeout(() => { open(box); query(box); }, DEBOUNCE_MS);
    });
    input.addEventListener('focus', () => open(box));
    // Validate once the user has moved on, not while they are still typing.
    input.addEventListener('blur', () => { setTimeout(() => validate(box), 120); });

    input.addEventListener('keydown', (e) => {
      if (activeBox !== box) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); highlight(box, box.index + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(box, box.index - 1); }
      else if (e.key === 'Enter' || e.key === 'Tab') {
        if (box.index >= 0) { e.preventDefault(); choose(box, box.index); }
      } else if (e.key === 'Escape') { closeActive(); }
    });

    if (input.value) validate(box);
  }

  /**
   * Attach to every [data-path-input] element that is not wired yet.
   * Called after a modal renders, since those inputs do not exist until then.
   */
  function attachAll(root) {
    (root || document).querySelectorAll('[data-path-input]').forEach((input) => {
      attach(input, {
        kind: input.getAttribute('data-path-kind') || 'any',
        extensions: (input.getAttribute('data-path-ext') || '').split(',').map(s => s.trim()).filter(Boolean),
      });
    });
  }

  global.PathInput = { attach, attachAll, close: closeActive };
})(window);
