// SmartCronInput.js - Intelligent cron expression input component

function escapeText(value) {
  const d = document.createElement('div');
  d.textContent = value == null ? '' : String(value);
  return d.innerHTML;
}

// Escaped translation helper, so a label can never inject markup.
function T(key, params) {
  // i18n is a top-level const in a classic script, so it lives in the global
  // scope but NOT on `window` - looking it up there silently fell back to
  // printing the raw key.
  const d = document.createElement('div');
  d.textContent = (typeof i18n !== 'undefined' && i18n.t) ? i18n.t(key, params) : key;
  return d.innerHTML;
}

class SmartCronInput {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.onChange = options.onChange || (() => {});
    this.value = options.value || '* * * * *';
    // Which item is being edited, so it is not reported as clashing with itself.
    this.excludeId = options.excludeId || null;
    this._conflictTimer = null;
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="smart-cron">
        <div class="cron-visual">
          <div class="cron-parts">
            <div class="cron-part" data-field="0">
              <label>${T('cron.minute')}</label>
              <input type="text" class="cron-field" data-idx="0" placeholder="0-59">
              <div class="cron-part-hint"></div>
            </div>
            <div class="cron-sep">:</div>
            <div class="cron-part" data-field="1">
              <label>${T('cron.hour')}</label>
              <input type="text" class="cron-field" data-idx="1" placeholder="0-23">
              <div class="cron-part-hint"></div>
            </div>
            <div class="cron-sep">&nbsp;</div>
            <div class="cron-part" data-field="2">
              <label>${T('cron.day')}</label>
              <input type="text" class="cron-field" data-idx="2" placeholder="1-31">
              <div class="cron-part-hint"></div>
            </div>
            <div class="cron-sep">&nbsp;</div>
            <div class="cron-part" data-field="3">
              <label>${T('cron.month')}</label>
              <input type="text" class="cron-field" data-idx="3" placeholder="1-12">
              <div class="cron-part-hint"></div>
            </div>
            <div class="cron-sep">&nbsp;</div>
            <div class="cron-part" data-field="4">
              <label>${T('cron.weekday')}</label>
              <input type="text" class="cron-field" data-idx="4" placeholder="0-7">
              <div class="cron-part-hint"></div>
            </div>
          </div>
        </div>

        <div class="cron-description" id="cron-desc"></div>
        <div class="cron-next-run" id="cron-next"></div>
        <div class="cron-validation" id="cron-valid"></div>

        <!-- What else already runs at this time, and a way out of the clash. -->
        <div class="cron-conflicts" id="cron-conflicts"></div>

        <div class="cron-templates">
          <span class="cron-templates-label">${T('cron.quick')}</span>
          <button class="cron-tpl" data-cron="* * * * *">${T('cron.everyMin')}</button>
          <button class="cron-tpl" data-cron="*/5 * * * *">${T('cron.every5')}</button>
          <button class="cron-tpl" data-cron="*/15 * * * *">${T('cron.every15')}</button>
          <button class="cron-tpl" data-cron="0 * * * *">${T('cron.everyHour')}</button>
          <button class="cron-tpl" data-cron="0 0 * * *">${T('cron.dailyMidnight')}</button>
          <button class="cron-tpl" data-cron="0 9 * * *">${T('cron.daily9')}</button>
          <button class="cron-tpl" data-cron="0 2 * * *">${T('cron.daily2')}</button>
          <button class="cron-tpl" data-cron="0 0 * * 0">${T('cron.weeklySunday')}</button>
          <button class="cron-tpl" data-cron="0 0 1 * *">${T('cron.monthly1st')}</button>
          <button class="cron-tpl" data-cron="0 9-17 * * 1-5">${T('cron.workHours')}</button>
        </div>

        <div class="cron-help-toggle" id="cron-help-toggle">${T('cron.syntaxHelp')} ▾</div>
        <div class="cron-help hidden" id="cron-help">
          <table class="cron-help-table">
            <tr><td><code>*</code></td><td>${T('cron.helpAny')}</td></tr>
            <tr><td><code>*/5</code></td><td>${T('cron.helpStep')}</td></tr>
            <tr><td><code>1-5</code></td><td>${T('cron.helpRange')}</td></tr>
            <tr><td><code>1,3,5</code></td><td>${T('cron.helpList')}</td></tr>
            <tr><td><code>0 9 * * 1-5</code></td><td>${T('cron.helpExample')}</td></tr>
          </table>
        </div>
      </div>
    `;

    // Bind events
    this.container.querySelectorAll('.cron-field').forEach(input => {
      input.addEventListener('input', () => this.syncFromFields());
      input.addEventListener('keydown', (e) => this.handleKeydown(e));
      input.addEventListener('focus', () => this.highlightField(input));
    });

    this.container.querySelectorAll('.cron-tpl').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this.setValue(btn.dataset.cron);
      });
    });

    document.getElementById('cron-help-toggle').addEventListener('click', () => {
      document.getElementById('cron-help').classList.toggle('hidden');
    });

    this.setValue(this.value);
  }

  /**
   * Show what else fires at the same minute.
   * Debounced, because it runs on every keystroke and each check walks a week
   * of fire times for every existing schedule.
   */
  checkConflicts() {
    clearTimeout(this._conflictTimer);
    this._conflictTimer = setTimeout(() => this._doCheckConflicts(), 350);
  }

  async _doCheckConflicts() {
    const host = this.container.querySelector('#cron-conflicts');
    if (!host || !window.api || !window.api.checkScheduleConflicts) return;

    let result;
    try { result = await window.api.checkScheduleConflicts(this.value, this.excludeId); }
    catch (e) { host.innerHTML = ''; return; }

    if (!result || !result.success) { host.innerHTML = ''; return; }

    if (!result.conflicts.length) {
      host.innerHTML = result.totalScheduled
        ? `<div class="cron-conflict-ok"><i data-lucide="check"></i> ${T('cron.conflictFree')}</div>`
        : '';
      if (window.lucide) lucide.createIcons();
      return;
    }

    const list = result.conflicts.slice(0, 6).map(c => {
      const when = new Date(c.at).toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const kind = T(c.kind === 'backup' ? 'dash.kindBackup' : 'dash.kindTask');
      return `<div class="cron-conflict-item">
        <span class="cron-conflict-kind">${kind}</span>
        <span class="cron-conflict-name">${escapeText(c.name)}</span>
        <code class="cron-conflict-cron">${escapeText(c.cron)}</code>
        <span class="cron-conflict-when">${escapeText(when)}</span>
      </div>`;
    }).join('');

    const title = result.conflicts.length === 1
      ? T('cron.conflictsOne')
      : T('cron.conflictsMany', { n: result.conflicts.length });

    host.innerHTML = `
      <div class="cron-conflict-box">
        <div class="cron-conflict-head">
          <i data-lucide="alert-triangle"></i>
          <span>${title}</span>
          ${result.suggestion ? `<button type="button" class="cron-suggest-btn" id="cron-suggest">${T('cron.suggestSlot')}</button>` : ''}
        </div>
        ${list}
      </div>`;

    const btn = host.querySelector('#cron-suggest');
    if (btn && result.suggestion) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        this.setValue(result.suggestion.expression);
        if (typeof showToast === 'function') showToast(i18n.t('cron.suggestApplied', { minute: result.suggestion.minute }), 'success');
      });
    }
    if (window.lucide) lucide.createIcons();
  }

  handleKeydown(e) {
    const idx = parseInt(e.target.dataset.idx);
    if (e.key === ':' || e.key === ' ' || e.key === 'Tab') {
      e.preventDefault();
      const next = this.container.querySelector(`.cron-field[data-idx="${idx + 1}"]`);
      if (next) next.focus();
    }
    if (e.key === 'Backspace' && e.target.value === '' && idx > 0) {
      const prev = this.container.querySelector(`.cron-field[data-idx="${idx - 1}"]`);
      if (prev) prev.focus();
    }
  }

  highlightField(input) {
    this.container.querySelectorAll('.cron-part').forEach(p => p.classList.remove('focused'));
    input.closest('.cron-part').classList.add('focused');
  }

  syncFromFields() {
    const fields = [];
    for (let i = 0; i < 5; i++) {
      const input = this.container.querySelector(`.cron-field[data-idx="${i}"]`);
      fields.push(input.value.trim() || '*');
    }
    this.value = fields.join(' ');
    this.updateDescription();
    this.onChange(this.value);
    this.checkConflicts();
  }

  setValue(cron) {
    this.value = cron;
    const parts = cron.split(/\s+/);
    for (let i = 0; i < 5; i++) {
      const input = this.container.querySelector(`.cron-field[data-idx="${i}"]`);
      if (input) input.value = parts[i] || '*';
    }
    this.updateDescription();
    this.checkConflicts();
    this.onChange(this.value);
  }

  getValue() {
    return this.value;
  }

  isValid() {
    const parts = this.value.trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const ranges = [
      { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 },
      { min: 1, max: 12 }, { min: 0, max: 7 }
    ];
    for (let i = 0; i < 5; i++) {
      if (!this.validateField(parts[i], ranges[i].min, ranges[i].max)) return false;
    }
    return true;
  }

  validateField(value, min, max) {
    if (!value || value === '*') return true;
    if (value.includes('/')) {
      const [base, step] = value.split('/');
      if (!this.isWholeNumber(step) || Number(step) < 1) return false;
      if (base === '*') return true;
      // A base volta pelo mesmo validador: assim "1-30/2" e "1,5,9/3" são
      // julgados pelos Operados que já existem, em vez de uma comparação
      // solta que aceitaria intervalo dentro de intervalo.
      return this.validateField(base, min, max);
    }
    if (value.includes('-')) {
      const [a, b] = value.split('-');
      if (!this.isWholeNumber(a) || !this.isWholeNumber(b)) return false;
      return Number(a) >= min && Number(b) <= max && Number(a) <= Number(b);
    }
    if (value.includes(',')) {
      const parts = value.split(',');
      // "1,,2" e ",5" não são cron: elemento vazio era aceito porque o
      // topo do método trata campo não preenchido como "ainda digitando".
      if (parts.some((p) => !p.trim())) return false;
      return parts.every(v => this.validateField(v.trim(), min, max));
    }
    if (!this.isWholeNumber(value)) return false;
    const num = Number(value);
    return num >= min && num <= max;
  }

  // parseInt truncava: "1.5" virava 1 e passava na faixa, a tela aceitava
  // "1.5" como minuto, salvava, e o parser do main recusava na hora de
  // executar. Tarefa que parece agendada e nunca roda.
  isWholeNumber(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return false;
    return /^[+-]?\d+$/.test(s);
  }

  updateDescription() {
    const descEl = document.getElementById('cron-desc');
    const validEl = document.getElementById('cron-valid');
    const nextEl = document.getElementById('cron-next');

    if (!this.isValid()) {
      descEl.textContent = '';
      validEl.innerHTML = `<span class="cron-invalid">${T('cron.invalidExpression')}</span>`;
      nextEl.textContent = '';
      return;
    }

    validEl.innerHTML = `<span class="cron-valid">${T('cron.valid')}</span>`;
    descEl.textContent = this.getDescription();

    const next = this.getNextRun();
    if (next) {
      const diff = next - new Date();
      const mins = Math.round(diff / 60000);
      if (mins < 60) nextEl.textContent = `Next run in ~${mins} min`;
      else if (mins < 1440) nextEl.textContent = `Next run in ~${Math.round(mins / 60)}h ${mins % 60}m`;
      else nextEl.textContent = `Next run: ${next.toLocaleDateString()} ${next.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      nextEl.textContent = '';
    }
  }

  getDescription() {
    const parts = this.value.split(/\s+/);
    if (parts.length !== 5) return '';
    const [min, hour, dom, month, dow] = parts;

    if (min === '*' && hour === '*') return i18n.t('cron.everyMinute');
    if (min.startsWith('*/')) return i18n.t('cron.everyNMinutes', { n: min.replace('*/', '') });
    if (hour.startsWith('*/')) return i18n.t('cron.everyNHours', { n: hour.replace('*/', '') });

    // As chaves existiam nos dois dicionários desde o começo e não eram
    // usadas: a descrição saía em inglês dentro de um app em português.
    let desc = i18n.t('cron.runsAt');
    desc += ` ${min === '*' ? 0 : min}`;
    desc += hour === '*'
      ? ` ${i18n.t('cron.daily').toLowerCase()}`
      : `:${hour.padStart(2, '0')}`;

    if (dom !== '*') desc += ` · ${i18n.t('cron.day')} ${dom}`;
    if (month !== '*') desc += ` · ${i18n.t('cron.month')} ${month}`;
    if (dow !== '*') {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      if (dow.includes('-')) {
        const [s, e] = dow.split('-');
        desc += ` · ${dayNames[s]}-${dayNames[e]}`;
      } else {
        desc += ` · ${dayNames[dow] || dow}`;
      }
    }

    return desc;
  }

  getNextRun() {
    if (!this.isValid()) return null;
    const now = new Date();
    let candidate = new Date(now);
    candidate.setSeconds(0);
    candidate.setMilliseconds(0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    const parts = this.value.split(/\s+/);
    const ranges = [
      { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 },
      { min: 1, max: 12 }, { min: 0, max: 7 }
    ];
    const values = [
      () => candidate.getMinutes(),
      () => candidate.getHours(),
      () => candidate.getDate(),
      () => candidate.getMonth() + 1,
      () => candidate.getDay()
    ];

    for (let i = 0; i < 525600; i++) {
      let match = true;
      for (let f = 0; f < 5; f++) {
        if (!this.matchesField(values[f](), parts[f], ranges[f].min, ranges[f].max)) {
          match = false;
          break;
        }
      }
      if (match) return candidate;
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return null;
  }

  matchesField(current, expr, min, max) {
    if (expr === '*') return true;
    if (expr.includes('/')) {
      const step = parseInt(expr.split('/')[1], 10);
      return current % step === 0;
    }
    if (expr.includes('-')) {
      const [a, b] = expr.split('-').map(Number);
      return current >= a && current <= b;
    }
    if (expr.includes(',')) {
      return expr.split(',').map(Number).includes(current);
    }
    return current === parseInt(expr, 10);
  }
}
