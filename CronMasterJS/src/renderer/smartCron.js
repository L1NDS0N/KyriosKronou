// SmartCronInput.js - Intelligent cron expression input component

class SmartCronInput {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.onChange = options.onChange || (() => {});
    this.value = options.value || '* * * * *';
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="smart-cron">
        <div class="cron-visual">
          <div class="cron-parts">
            <div class="cron-part" data-field="0">
              <label>Minute</label>
              <input type="text" class="cron-field" data-idx="0" placeholder="0-59">
              <div class="cron-part-hint"></div>
            </div>
            <div class="cron-sep">:</div>
            <div class="cron-part" data-field="1">
              <label>Hour</label>
              <input type="text" class="cron-field" data-idx="1" placeholder="0-23">
              <div class="cron-part-hint"></div>
            </div>
            <div class="cron-sep">&nbsp;</div>
            <div class="cron-part" data-field="2">
              <label>Day</label>
              <input type="text" class="cron-field" data-idx="2" placeholder="1-31">
              <div class="cron-part-hint"></div>
            </div>
            <div class="cron-sep">&nbsp;</div>
            <div class="cron-part" data-field="3">
              <label>Month</label>
              <input type="text" class="cron-field" data-idx="3" placeholder="1-12">
              <div class="cron-part-hint"></div>
            </div>
            <div class="cron-sep">&nbsp;</div>
            <div class="cron-part" data-field="4">
              <label>Weekday</label>
              <input type="text" class="cron-field" data-idx="4" placeholder="0-7">
              <div class="cron-part-hint"></div>
            </div>
          </div>
        </div>

        <div class="cron-description" id="cron-desc"></div>
        <div class="cron-next-run" id="cron-next"></div>
        <div class="cron-validation" id="cron-valid"></div>

        <div class="cron-templates">
          <span class="cron-templates-label">Quick:</span>
          <button class="cron-tpl" data-cron="* * * * *">Every min</button>
          <button class="cron-tpl" data-cron="*/5 * * * *">Every 5 min</button>
          <button class="cron-tpl" data-cron="*/15 * * * *">Every 15 min</button>
          <button class="cron-tpl" data-cron="0 * * * *">Every hour</button>
          <button class="cron-tpl" data-cron="0 0 * * *">Daily midnight</button>
          <button class="cron-tpl" data-cron="0 9 * * *">Daily 9 AM</button>
          <button class="cron-tpl" data-cron="0 2 * * *">Daily 2 AM</button>
          <button class="cron-tpl" data-cron="0 0 * * 0">Weekly Sunday</button>
          <button class="cron-tpl" data-cron="0 0 1 * *">Monthly 1st</button>
          <button class="cron-tpl" data-cron="0 9-17 * * 1-5">Work hours</button>
        </div>

        <div class="cron-help-toggle" id="cron-help-toggle">Syntax help ▾</div>
        <div class="cron-help hidden" id="cron-help">
          <table class="cron-help-table">
            <tr><td><code>*</code></td><td>Any value</td></tr>
            <tr><td><code>*/5</code></td><td>Every 5 units</td></tr>
            <tr><td><code>1-5</code></td><td>Range from 1 to 5</td></tr>
            <tr><td><code>1,3,5</code></td><td>Specific values</td></tr>
            <tr><td><code>0 9 * * 1-5</code></td><td>9:00 AM, Mon-Fri</td></tr>
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
  }

  setValue(cron) {
    this.value = cron;
    const parts = cron.split(/\s+/);
    for (let i = 0; i < 5; i++) {
      const input = this.container.querySelector(`.cron-field[data-idx="${i}"]`);
      if (input) input.value = parts[i] || '*';
    }
    this.updateDescription();
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
      if (base !== '*' && (isNaN(parseInt(base)) || parseInt(base) < min || parseInt(base) > max)) return false;
      return !isNaN(parseInt(step)) && parseInt(step) >= 1;
    }
    if (value.includes('-')) {
      const [a, b] = value.split('-').map(Number);
      return !isNaN(a) && !isNaN(b) && a >= min && b <= max && a <= b;
    }
    if (value.includes(',')) {
      return value.split(',').every(v => this.validateField(v.trim(), min, max));
    }
    const num = parseInt(value, 10);
    return !isNaN(num) && num >= min && num <= max;
  }

  updateDescription() {
    const descEl = document.getElementById('cron-desc');
    const validEl = document.getElementById('cron-valid');
    const nextEl = document.getElementById('cron-next');

    if (!this.isValid()) {
      descEl.textContent = '';
      validEl.innerHTML = '<span class="cron-invalid">Invalid expression</span>';
      nextEl.textContent = '';
      return;
    }

    validEl.innerHTML = '<span class="cron-valid">Valid</span>';
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
    const [min, hour, dom, month, dow] = parts;

    if (min === '*' && hour === '*') return 'Runs every minute';
    if (min.startsWith('*/')) return `Runs every ${min.replace('*/', '')} minutes`;
    if (hour.startsWith('*/')) return `Runs every ${hour.replace('*/', '')} hours`;

    let desc = 'Runs at ';
    desc += min === '*' ? 'minute 0' : `minute ${min}`;
    desc += hour === '*' ? ' of every hour' : ` past hour ${hour.padStart(2, '0')}`;

    if (dom !== '*') desc += `, on day ${dom}`;
    if (month !== '*') desc += ` of month ${month}`;
    if (dow !== '*') {
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      if (dow.includes('-')) {
        const [s, e] = dow.split('-');
        desc += `, ${dayNames[s]}-${dayNames[e]}`;
      } else {
        desc += `, ${dayNames[dow] || dow}`;
      }
    } else if (dom === '*') {
      desc += ' daily';
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
