// calendar.js - Everything scheduled, on one timeline.
//
// Tasks, backups and service-managed jobs each lived on their own screen, so
// there was no way to see the night as a whole: what runs at 02:00, what piles
// up on the 1st, whether Sunday is empty. This draws them together.
//
// Four views, because they answer different questions:
//   month    - which days are busy
//   week     - how a week is laid out, hour by hour
//   agenda   - what is coming next, as a list
//   load     - which hours are crowded, for spreading work out
//
// The past shows what actually ran; the future shows what is projected from
// the cron expressions. Clicking anything goes to its screen with the item
// highlighted.

(function (global) {
  'use strict';

  const T = (k, p) => (typeof i18n !== 'undefined' && i18n.t ? i18n.t(k, p) : k);

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  const KIND_CLASS = { task: 'k-task', backup: 'k-backup', service: 'k-service' };

  // Dates must follow the app's language setting, not the machine's locale:
  // otherwise a pt-BR interface prints "September".
  const locale = () => (typeof i18n !== 'undefined' && i18n.currentLang) ? i18n.currentLang : undefined;

  let view = 'month';
  let anchor = new Date();      // the month/week being looked at
  let cache = null;

  // ─── Range for the current view ───
  function range() {
    const from = new Date(anchor);
    const to = new Date(anchor);

    if (view === 'month') {
      from.setDate(1);
      from.setDate(from.getDate() - from.getDay());       // pad to the Sunday
      to.setMonth(to.getMonth() + 1, 0);
      to.setDate(to.getDate() + (6 - to.getDay()));
    } else if (view === 'week') {
      from.setDate(from.getDate() - from.getDay());
      to.setTime(from.getTime());
      to.setDate(to.getDate() + 6);
    } else {
      // Agenda and load look forward a fortnight.
      to.setDate(to.getDate() + 14);
    }
    return { from, to };
  }

  function dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const time = (iso) => new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });

  async function load() {
    const { from, to } = range();
    try {
      cache = await window.api.getCalendar(from.toISOString(), to.toISOString());
    } catch (e) {
      cache = { success: false, days: {}, totals: {}, hours: [] };
    }
    return cache;
  }

  // ─── Views ───
  function renderMonth() {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = new Date(first);
    start.setDate(start.getDate() - start.getDay());

    const today = dayKey(new Date());
    const weekdays = [0, 1, 2, 3, 4, 5, 6].map(i => {
      const d = new Date(2024, 0, 7 + i); // a known Sunday
      return d.toLocaleDateString(locale(), { weekday: 'short' });
    });

    let html = '<div class="cal-grid"><div class="cal-weekdays">'
      + weekdays.map(w => `<div>${esc(w)}</div>`).join('') + '</div><div class="cal-days">';

    const cursor = new Date(start);
    for (let i = 0; i < 42; i++) {
      const key = dayKey(cursor);
      const items = (cache.days || {})[key] || [];
      const outside = cursor.getMonth() !== anchor.getMonth();

      const classes = ['cal-day'];
      if (outside) classes.push('outside');
      if (key === today) classes.push('today');
      if (items.length) classes.push('has-items');

      html += `<div class="${classes.join(' ')}" data-day="${key}">
        <div class="cal-day-num">${cursor.getDate()}</div>
        <div class="cal-day-items">
          ${items.slice(0, 3).map(o => `
            <div class="cal-chip ${KIND_CLASS[o.kind] || ''} s-${o.state}"
                 data-goto="${esc(o.page)}" data-id="${esc(o.id || '')}" title="${esc(o.name + ' · ' + time(o.at))}">
              <span class="cal-chip-time">${esc(time(o.at))}</span>${esc(o.name)}
            </div>`).join('')}
          ${items.length > 3 ? `<div class="cal-more" data-open-day="${key}">+${items.length - 3}</div>` : ''}
        </div>
      </div>`;
      cursor.setDate(cursor.getDate() + 1);
    }
    return html + '</div></div>';
  }

  function renderWeek() {
    const { from } = range();
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      days.push(d);
    }

    // Only draw hours that actually contain something, plus a working-day
    // spine, so the view is not 24 mostly-empty rows.
    const used = new Set();
    for (const d of days) {
      for (const o of (cache.days || {})[dayKey(d)] || []) used.add(new Date(o.at).getHours());
    }
    const hours = Array.from(new Set([...used, 0, 6, 12, 18])).sort((a, b) => a - b);

    let html = '<div class="cal-week"><div class="cal-week-head"><div class="cal-week-corner"></div>'
      + days.map(d => `<div class="cal-week-day${dayKey(d) === dayKey(new Date()) ? ' today' : ''}">
          <div>${esc(d.toLocaleDateString(locale(), { weekday: 'short' }))}</div>
          <strong>${d.getDate()}</strong></div>`).join('')
      + '</div><div class="cal-week-body">';

    for (const hour of hours) {
      html += `<div class="cal-week-row"><div class="cal-week-hour">${String(hour).padStart(2, '0')}h</div>`;
      for (const d of days) {
        const items = ((cache.days || {})[dayKey(d)] || []).filter(o => new Date(o.at).getHours() === hour);
        html += `<div class="cal-week-cell">${items.map(o => `
          <div class="cal-chip ${KIND_CLASS[o.kind] || ''} s-${o.state}"
               data-goto="${esc(o.page)}" data-id="${esc(o.id || '')}" title="${esc(o.name)}">
            <span class="cal-chip-time">${esc(time(o.at))}</span>${esc(o.name)}
          </div>`).join('')}</div>`;
      }
      html += '</div>';
    }
    return html + '</div></div>';
  }

  function renderAgenda() {
    const keys = Object.keys(cache.days || {}).sort();
    if (!keys.length) return `<div class="cal-empty">${esc(T('calendar.empty'))}</div>`;

    return '<div class="cal-agenda">' + keys.map(key => {
      const items = cache.days[key];
      const d = new Date(key + 'T00:00:00');
      return `<div class="cal-agenda-day">
        <div class="cal-agenda-date">
          <strong>${d.getDate()}</strong>
          <span>${esc(d.toLocaleDateString(locale(), { month: 'short', weekday: 'short' }))}</span>
        </div>
        <div class="cal-agenda-items">
          ${items.map(o => `
            <div class="cal-agenda-item" data-goto="${esc(o.page)}" data-id="${esc(o.id || '')}">
              <span class="cal-agenda-time">${esc(time(o.at))}</span>
              <span class="cal-dot ${KIND_CLASS[o.kind] || ''} s-${o.state}"></span>
              <span class="cal-agenda-name">${esc(o.name)}</span>
              <span class="cal-agenda-kind">${esc(T(o.kind === 'backup' ? 'dash.kindBackup' : o.kind === 'service' ? 'calendar.kindService' : 'dash.kindTask'))}</span>
              ${o.state !== 'scheduled' ? `<span class="badge badge-${o.state === 'success' ? 'active' : 'error'}">${esc(o.duration || '')}</span>` : ''}
            </div>`).join('')}
        </div>
      </div>`;
    }).join('') + '</div>';
  }

  function renderLoad() {
    const hours = cache.hours || new Array(24).fill(0);
    const peak = Math.max(1, ...hours);

    return `<div class="cal-load">
      <div class="cal-load-hint">${esc(T('calendar.loadHint'))}</div>
      <div class="cal-load-bars">
        ${hours.map((count, hour) => `
          <div class="cal-load-col" title="${hour}h · ${count}">
            <div class="cal-load-bar${count === peak && count > 0 ? ' peak' : ''}" style="height:${Math.round((count / peak) * 100)}%"></div>
            <div class="cal-load-hour">${hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}</div>
          </div>`).join('')}
      </div>
    </div>`;
  }

  function renderBody() {
    if (!cache || !cache.success) return `<div class="cal-empty">${esc(T('calendar.empty'))}</div>`;
    if (view === 'month') return renderMonth();
    if (view === 'week') return renderWeek();
    if (view === 'load') return renderLoad();
    return renderAgenda();
  }

  function periodLabel() {
    if (view === 'month') return anchor.toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
    if (view === 'week') {
      const { from, to } = range();
      return from.toLocaleDateString(locale(), { day: '2-digit', month: 'short' })
        + ' – ' + to.toLocaleDateString(locale(), { day: '2-digit', month: 'short' });
    }
    return T('calendar.next14');
  }

  async function paint() {
    const body = document.getElementById('cal-body');
    if (!body) return;
    body.innerHTML = `<div class="tbl-loading">${esc(T('svc.loading'))}</div>`;

    await load();
    body.innerHTML = renderBody();

    const label = document.getElementById('cal-period');
    if (label) label.textContent = periodLabel();

    const totals = document.getElementById('cal-totals');
    if (totals && cache.totals) {
      totals.innerHTML = `
        <span>${cache.totals.scheduled || 0} ${esc(T('calendar.scheduled'))}</span>
        <span class="ok">${cache.totals.executed || 0} ${esc(T('calendar.executed'))}</span>
        <span class="${cache.totals.failed ? 'bad' : ''}">${cache.totals.failed || 0} ${esc(T('calendar.failed'))}</span>`;
    }
    if (window.lucide) lucide.createIcons();
  }

  function shift(direction) {
    if (view === 'month') anchor.setMonth(anchor.getMonth() + direction);
    else if (view === 'week') anchor.setDate(anchor.getDate() + 7 * direction);
    else anchor.setDate(anchor.getDate() + 14 * direction);
    paint();
  }

  // ─── Navigation out of the calendar ───
  //
  // A calendar entry is only useful if it takes you to the thing it names.
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-goto]');
    if (target) {
      const page = target.getAttribute('data-goto');
      const id = target.getAttribute('data-id');
      if (typeof hideModal === 'function') hideModal();
      if (typeof switchPage === 'function') switchPage(page);
      if (id) setTimeout(() => highlight(id), 450);
      return;
    }

    const more = e.target.closest('[data-open-day]');
    if (more) {
      view = 'agenda';
      anchor = new Date(more.getAttribute('data-open-day') + 'T00:00:00');
      document.querySelectorAll('.cal-view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'agenda'));
      paint();
    }
  });

  /** Flash the row or card the calendar pointed at. */
  function highlight(id) {
    const selectors = [
      `[data-task-id="${CSS.escape(id)}"]`,
      `[onclick*="${CSS.escape(id)}"]`,
    ];
    let el = null;
    for (const selector of selectors) {
      try { el = document.querySelector(selector); } catch (e) { el = null; }
      if (el) break;
    }
    if (!el) return;

    const card = el.closest('.task-card, .backup-profile-card, tr') || el;
    card.classList.add('kyrios-highlight');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => card.classList.remove('kyrios-highlight'), 2600);
  }

  // ─── The full calendar modal ───
  function open(initialView) {
    if (initialView) view = initialView;
    anchor = new Date();

    showModal(`
      <h2><i data-lucide="calendar"></i> ${esc(T('calendar.title'))}</h2>

      <div class="cal-toolbar">
        <div class="cal-nav">
          <button class="btn-secondary-sm" id="cal-prev" type="button"><i data-lucide="chevron-left"></i></button>
          <button class="btn-secondary-sm" id="cal-today" type="button">${esc(T('calendar.today'))}</button>
          <button class="btn-secondary-sm" id="cal-next" type="button"><i data-lucide="chevron-right"></i></button>
          <span class="cal-period" id="cal-period"></span>
        </div>
        <div class="cal-views">
          ${[['month', 'calendar.viewMonth'], ['week', 'calendar.viewWeek'], ['agenda', 'calendar.viewAgenda'], ['load', 'calendar.viewLoad']]
            .map(([id, key]) => `<button type="button" class="cal-view-btn${view === id ? ' active' : ''}" data-view="${id}">${esc(T(key))}</button>`).join('')}
        </div>
      </div>

      <div class="cal-totals" id="cal-totals"></div>
      <div class="cal-body" id="cal-body"></div>

      <div class="modal-actions">
        <span class="cal-legend">
          <span><i class="cal-dot k-task"></i>${esc(T('dash.kindTask'))}</span>
          <span><i class="cal-dot k-backup"></i>${esc(T('dash.kindBackup'))}</span>
          <span><i class="cal-dot k-service"></i>${esc(T('calendar.kindService'))}</span>
        </span>
        <button class="btn-ghost" onclick="hideModal()">${esc(T('runs.close'))}</button>
      </div>
    `, true);

    document.getElementById('cal-prev').addEventListener('click', () => shift(-1));
    document.getElementById('cal-next').addEventListener('click', () => shift(1));
    document.getElementById('cal-today').addEventListener('click', () => { anchor = new Date(); paint(); });
    document.querySelectorAll('.cal-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        view = btn.dataset.view;
        document.querySelectorAll('.cal-view-btn').forEach(b => b.classList.toggle('active', b === btn));
        paint();
      });
    });

    paint();
    if (window.lucide) lucide.createIcons();
  }

  // ─── The dashboard preview ───
  async function renderMini() {
    const host = document.getElementById('dash-calendar');
    if (!host) return;

    const today = new Date();
    const from = new Date(today);
    const to = new Date(today);
    to.setDate(to.getDate() + 6);

    let data;
    try { data = await window.api.getCalendar(from.toISOString(), to.toISOString()); }
    catch (e) { return; }

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const items = (data.days || {})[dayKey(d)] || [];
      days.push({ d, items });
    }
    const peak = Math.max(1, ...days.map(x => x.items.length));

    host.innerHTML = days.map(({ d, items }, i) => `
      <div class="mini-day${i === 0 ? ' today' : ''}" title="${items.length} ${esc(T('calendar.scheduled'))}">
        <div class="mini-day-name">${esc(d.toLocaleDateString(locale(), { weekday: 'short' }))}</div>
        <div class="mini-day-num">${d.getDate()}</div>
        <div class="mini-day-bar"><div class="mini-day-fill" style="height:${Math.round((items.length / peak) * 100)}%"></div></div>
        <div class="mini-day-count">${items.length || ''}</div>
      </div>`).join('');
  }

  global.KyriosCalendar = { open, renderMini, highlight };
})(window);
