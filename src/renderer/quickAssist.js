// quickAssist.js - Intelligent Quick Create Assistant
// Provides inline suggestions, real-time validation, and smart predictions
// as the user types in the Quick Create textarea.

class QuickAssist {
  constructor(textareaId, options = {}) {
    this.textarea = document.getElementById(textareaId);
    if (!this.textarea) return;

    this.cronParser = options.cronParser || new CronParser();
    this.onValidation = options.onValidation || (() => {});
    this.onSuggestionSelect = options.onSuggestionSelect || null;

    this.suggestions = [];
    this.activeSuggestion = -1;
    this.currentField = null; // 'cron', 'name', 'script', 'args', 'desc'
    this.currentLine = '';
    this.cursorLine = 0;
    this.cursorCol = 0;
    this.lineResults = [];
    this.debounceTimer = null;

    this._createSuggestionPanel();
    this._bindEvents();
    this._addLineNumbers();
  }

  // ─── UI: Suggestion Panel ───
  _createSuggestionPanel() {
    this.panel = document.createElement('div');
    this.panel.className = 'qa-panel';
    this.panel.innerHTML = `
      <div class="qa-header">
        <i data-lucide="sparkles"></i>
        <span>Assistant</span>
        <span class="qa-hint">Tab to accept · ↑↓ navigate</span>
      </div>
      <div class="qa-suggestions" id="qa-suggestions"></div>
      <div class="qa-validation" id="qa-validation"></div>
    `;
    this.textarea.parentNode.insertBefore(this.panel, this.textarea.nextSibling);

    this.suggestionsEl = this.panel.querySelector('#qa-suggestions');
    this.validationEl = this.panel.querySelector('#qa-validation');
  }

  _bindEvents() {
    this.textarea.addEventListener('input', () => this._onInput());
    this.textarea.addEventListener('keydown', (e) => this._onKeydown(e));
    this.textarea.addEventListener('click', () => this._updateCursor());
    this.textarea.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'Tab', 'Escape'].includes(e.key)) return;
      this._updateCursor();
    });
    this.textarea.addEventListener('focus', () => this._onInput());
    this.textarea.addEventListener('blur', () => {
      setTimeout(() => this._hidePanel(), 200);
    });
  }

  // ─── Input Handler ───
  _onInput() {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this._updateCursor();
      this._validateAllLines();
      this._generateSuggestions();
      this._renderSuggestions();
      this._renderValidation();
    }, 80);
  }

  _onKeydown(e) {
    if (!this.panel.classList.contains('visible')) {
      // Tab to insert separator
      if (e.key === 'Tab' && !e.shiftKey) {
        const { field } = this._getCurrentField();
        if (field && field !== 'desc') {
          e.preventDefault();
          this._insertAtCursor(' | ');
        }
      }
      return;
    }

    const count = this.suggestions.length;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.activeSuggestion = (this.activeSuggestion + 1) % count;
      this._highlightSuggestion();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.activeSuggestion = (this.activeSuggestion - 1 + count) % count;
      this._highlightSuggestion();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      if (this.activeSuggestion >= 0 && this.activeSuggestion < count) {
        e.preventDefault();
        this._applySuggestion(this.suggestions[this.activeSuggestion]);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this._insertAtCursor(' | ');
      }
    } else if (e.key === 'Escape') {
      this._hidePanel();
    }
  }

  // ─── Cursor & Field Detection ───
  _updateCursor() {
    const val = this.textarea.value;
    const pos = this.textarea.selectionStart;
    const lines = val.substring(0, pos).split('\n');
    this.cursorLine = lines.length - 1;
    this.cursorCol = lines[lines.length - 1].length;
    this.currentLine = val.split('\n')[this.cursorLine] || '';
    this.currentField = this._detectField();
  }

  _detectField() {
    const line = this.currentLine;
    const col = this.cursorCol;
    const parts = line.split('|');
    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
      const start = pos;
      const end = pos + parts[i].length;
      if (col >= start && col <= end + 1) {
        const fields = ['cron', 'name', 'script', 'args', 'desc'];
        return { field: fields[i] || 'desc', index: i, value: parts[i].trim() };
      }
      pos = end + 2; // +2 for ' | '
    }
    return { field: 'desc', index: parts.length - 1, value: (parts[parts.length - 1] || '').trim() };
  }

  _getCurrentField() {
    return this._detectField();
  }

  // ─── Validation ───
  _validateAllLines() {
    const lines = this.textarea.value.split('\n');
    this.lineResults = lines.map(line => {
      if (!line.trim()) return { empty: true };
      const parts = line.split('|').map(p => p.trim());
      if (parts.length < 3) return { valid: false, error: 'Need: cron | name | script', line };
      const [cron] = parts;
      const corrected = autoCorrectCron(cron);
      const valid = this.cronParser.validate(corrected);
      return { valid, cron: corrected, error: valid ? null : `Invalid cron: ${corrected}`, line };
    });
    this.onValidation(this.lineResults);
  }

  // ─── Suggestion Generation ───
  _generateSuggestions() {
    const { field, value } = this._getCurrentField();
    this.suggestions = [];

    if (field === 'cron') {
      this.suggestions = this._cronSuggestions(value);
    } else if (field === 'name') {
      this.suggestions = this._nameSuggestions(value);
    } else if (field === 'script') {
      this.suggestions = this._scriptSuggestions(value);
    } else if (field === 'args') {
      this.suggestions = this._argsSuggestions(value);
    } else if (field === 'desc') {
      this.suggestions = this._descSuggestions(value);
    }

    this.activeSuggestion = this.suggestions.length > 0 ? 0 : -1;
  }

  _cronSuggestions(value) {
    const v = value.toLowerCase().trim();
    const suggestions = [];

    // Shorthand completions
    const shorthands = [
      { trigger: 'every', label: 'every minute', insert: '* * * * *', desc: 'Run every minute' },
      { trigger: 'every m', label: 'every minute', insert: '* * * * *', desc: 'Run every minute' },
      { trigger: 'every h', label: 'every hour', insert: '0 * * * *', desc: 'Run every hour at :00' },
      { trigger: 'every d', label: 'every day (midnight)', insert: '0 0 * * *', desc: 'Run daily at 00:00' },
      { trigger: 'every w', label: 'every week (Sunday)', insert: '0 0 * * 0', desc: 'Run every Sunday at midnight' },
      { trigger: 'every mo', label: 'every month (1st)', insert: '0 0 1 * *', desc: 'Run on the 1st of each month' },
      { trigger: 'daily', label: 'daily at midnight', insert: '0 0 * * *', desc: 'Every day at 00:00' },
      { trigger: 'daily ', label: 'daily at 2 AM', insert: '0 2 * * *', desc: 'Every day at 02:00' },
      { trigger: 'hourly', label: 'every hour', insert: '0 * * * *', desc: 'Every hour at :00' },
      { trigger: 'weekly', label: 'weekly on Sunday', insert: '0 0 * * 0', desc: 'Every Sunday' },
      { trigger: 'monthly', label: 'monthly on 1st', insert: '0 0 1 * *', desc: '1st of every month' },
      { trigger: 'weekdays', label: 'weekdays 9 AM', insert: '0 9 * * 1-5', desc: 'Mon–Fri at 09:00' },
      { trigger: 'weekends', label: 'weekends 9 AM', insert: '0 9 * * 0,6', desc: 'Sat & Sun at 09:00' },
      { trigger: 'work', label: 'work hours (9-17)', insert: '0 9-17 * * 1-5', desc: 'Mon–Fri every hour 9-17' },
      { trigger: 'night', label: 'nightly backup 2 AM', insert: '0 2 * * *', desc: 'Every day at 02:00' },
      { trigger: 'noon', label: 'every day at noon', insert: '0 12 * * *', desc: 'Every day at 12:00' },
      { trigger: '5m', label: 'every 5 minutes', insert: '*/5 * * * *', desc: 'Every 5 min' },
      { trigger: '10m', label: 'every 10 minutes', insert: '*/10 * * * *', desc: 'Every 10 min' },
      { trigger: '15m', label: 'every 15 minutes', insert: '*/15 * * * *', desc: 'Every 15 min' },
      { trigger: '30m', label: 'every 30 minutes', insert: '*/30 * * * *', desc: 'Every 30 min' },
    ];

    // Filter by what user typed
    const matches = v ? shorthands.filter(s =>
      s.trigger.includes(v) || s.label.includes(v) || s.insert.startsWith(v)
    ) : shorthands.slice(0, 8);

    matches.forEach(s => suggestions.push({
      type: 'cron-shorthand',
      label: s.label,
      insert: s.insert,
      desc: s.desc,
      icon: 'clock'
    }));

    // Time-based suggestions: if user types a number, suggest common schedules
    if (/^\d{1,2}$/.test(v)) {
      const h = parseInt(v);
      if (h >= 0 && h <= 23) {
        suggestions.push({
          type: 'cron-time',
          label: `Every day at ${String(h).padStart(2, '0')}:00`,
          insert: `0 ${h} * * *`,
          desc: `Daily at ${h}:00`,
          icon: 'clock'
        });
        suggestions.push({
          type: 'cron-time',
          label: `Weekdays at ${String(h).padStart(2, '0')}:00`,
          insert: `0 ${h} * * 1-5`,
          desc: `Mon–Fri at ${h}:00`,
          icon: 'calendar'
        });
      }
    }

    // HH:MM format
    const hmMatch = v.match(/^(\d{1,2}):?(\d{0,2})$/);
    if (hmMatch) {
      const h = parseInt(hmMatch[1]);
      const m = hmMatch[2] ? parseInt(hmMatch[2]) : 0;
      if (h <= 23 && m <= 59) {
        suggestions.unshift({
          type: 'cron-time',
          label: `Daily at ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
          insert: `${m} ${h} * * *`,
          desc: 'Exact time every day',
          icon: 'clock'
        });
      }
    }

    // Pattern hints for partial cron expressions
    if (v.includes('/') && !v.includes('*')) {
      suggestions.push({
        type: 'cron-hint',
        label: 'Step: */N means "every N"',
        insert: null,
        desc: 'e.g. */5 = every 5 units',
        icon: 'info'
      });
    }
    if (v.includes('-') && v.split(' ').length === 1) {
      suggestions.push({
        type: 'cron-hint',
        label: 'Range: start-end (in a single field)',
        insert: null,
        desc: 'e.g. 9-17 in hour field = 9 AM to 5 PM',
        icon: 'info'
      });
    }

    return suggestions.slice(0, 8);
  }

  _nameSuggestions(value) {
    const v = value.toLowerCase().trim();
    const suggestions = [];

    const templates = [
      { label: 'Daily Backup', insert: 'Daily Backup', desc: 'Common backup task' },
      { label: 'Health Check', insert: 'Health Check', desc: 'Server health monitoring' },
      { label: 'Report Generator', insert: 'Report Generator', desc: 'Automated reports' },
      { label: 'Database Maintenance', insert: 'Database Maintenance', desc: 'DB cleanup/optimization' },
      { label: 'Log Cleanup', insert: 'Log Cleanup', desc: 'Rotate/clean log files' },
      { label: 'Sync Files', insert: 'Sync Files', desc: 'File synchronization' },
      { label: 'Monitor Service', insert: 'Monitor Service', desc: 'Service health monitor' },
      { label: 'Deploy Update', insert: 'Deploy Update', desc: 'Deployment automation' },
    ];

    const matches = v ? templates.filter(t => t.label.toLowerCase().includes(v)) : templates.slice(0, 6);
    matches.forEach(s => suggestions.push({ ...s, type: 'name-template', icon: 'tag' }));

    // If the cron field has a description, suggest a name from it
    const { index } = this._getCurrentField();
    const line = this.currentLine;
    const parts = line.split('|').map(p => p.trim());
    if (index === 1 && parts[0]) {
      const cronDesc = this.cronParser.getDescription(parts[0]);
      if (cronDesc && cronDesc !== 'Invalid' && !v) {
        suggestions.unshift({
          type: 'name-from-cron',
          label: cronDesc.replace(/^Runs? /, '').substring(0, 40),
          insert: cronDesc.replace(/^Runs? /, '').substring(0, 40),
          desc: 'From cron description',
          icon: 'sparkles'
        });
      }
    }

    return suggestions.slice(0, 6);
  }

  _scriptSuggestions(value) {
    const v = value.toLowerCase().trim();
    const suggestions = [];

    const commonScripts = [
      { label: 'C:\\Scripts\\backup.ps1', insert: 'C:\\Scripts\\backup.ps1', desc: 'PowerShell backup' },
      { label: 'C:\\Scripts\\healthcheck.exe', insert: 'C:\\Scripts\\healthcheck.exe', desc: 'Health check executable' },
      { label: 'C:\\Scripts\\report.ps1', insert: 'C:\\Scripts\\report.ps1', desc: 'Report generator' },
      { label: 'C:\\Scripts\\cleanup.bat', insert: 'C:\\Scripts\\cleanup.bat', desc: 'Batch cleanup' },
      { label: 'C:\\Scripts\\sync.ps1', insert: 'C:\\Scripts\\sync.ps1', desc: 'File sync script' },
      { label: 'C:\\Scripts\\deploy.ps1', insert: 'C:\\Scripts\\deploy.ps1', desc: 'Deployment script' },
      { label: 'C:\\Scripts\\monitor.ps1', insert: 'C:\\Scripts\\monitor.ps1', desc: 'Monitoring script' },
      { label: 'C:\\Scripts\\notify.ps1', insert: 'C:\\Scripts\\notify.ps1', desc: 'Notification script' },
    ];

    const matches = v ? commonScripts.filter(s => s.label.toLowerCase().includes(v)) : commonScripts.slice(0, 5);
    matches.forEach(s => suggestions.push({ ...s, type: 'script-path', icon: 'file-code' }));

    // Extension hints
    if (v && !v.includes('.')) {
      suggestions.push({ type: 'ext-hint', label: '.ps1 (PowerShell)', insert: value + '.ps1', desc: 'Add PowerShell extension', icon: 'info' });
      suggestions.push({ type: 'ext-hint', label: '.exe (Executable)', insert: value + '.exe', desc: 'Add executable extension', icon: 'info' });
      suggestions.push({ type: 'ext-hint', label: '.bat (Batch)', insert: value + '.bat', desc: 'Add batch extension', icon: 'info' });
    }

    return suggestions.slice(0, 6);
  }

  _argsSuggestions(value) {
    const v = value.toLowerCase().trim();
    const suggestions = [];

    const argTemplates = [
      { label: '-Verbose', insert: '-Verbose', desc: 'Enable verbose output' },
      { label: '-WhatIf', insert: '-WhatIf', desc: 'Dry run (simulate)' },
      { label: '-Force', insert: '-Force', desc: 'Force operation' },
      { label: '-NoProfile', insert: '-NoProfile', desc: 'Skip PowerShell profile' },
      { label: '-ExecutionPolicy Bypass', insert: '-ExecutionPolicy Bypass', desc: 'Bypass execution policy' },
      { label: '-Email admin@company.com', insert: '-Email admin@company.com', desc: 'Send notification email' },
      { label: '-Config C:\\config.json', insert: '-Config C:\\config.json', desc: 'Custom config file' },
      { label: '-Output C:\\logs\\', insert: '-Output C:\\logs\\', desc: 'Output directory' },
    ];

    const matches = v ? argTemplates.filter(a => a.label.toLowerCase().includes(v)) : argTemplates.slice(0, 5);
    matches.forEach(s => suggestions.push({ ...s, type: 'args-template', icon: 'terminal' }));

    return suggestions.slice(0, 5);
  }

  _descSuggestions(value) {
    const v = value.toLowerCase().trim();
    const suggestions = [];

    // Generate description from other fields
    const { index } = this._getCurrentField();
    const line = this.currentLine;
    const parts = line.split('|').map(p => p.trim());

    if (parts[0] && parts[1] && !v) {
      const cronDesc = this.cronParser.getDescription(parts[0]);
      if (cronDesc && cronDesc !== 'Invalid') {
        suggestions.push({
          type: 'desc-from-cron',
          label: cronDesc,
          insert: cronDesc,
          desc: 'Auto-generated from cron',
          icon: 'sparkles'
        });
      }
    }

    const descTemplates = [
      { label: 'Scheduled automated task', insert: 'Scheduled automated task', desc: 'Generic description' },
      { label: 'Runs automatically on schedule', insert: 'Runs automatically on schedule', desc: 'Auto description' },
      { label: 'Critical - do not disable', insert: 'Critical - do not disable', desc: 'Mark as critical' },
    ];

    const matches = v ? descTemplates.filter(d => d.label.toLowerCase().includes(v)) : descTemplates.slice(0, 3);
    matches.forEach(s => suggestions.push({ ...s, type: 'desc-template', icon: 'file-text' }));

    return suggestions.slice(0, 5);
  }

  // ─── Rendering ───
  _renderSuggestions() {
    if (this.suggestions.length === 0) {
      this._hidePanel();
      return;
    }

    this.panel.classList.add('visible');

    this.suggestionsEl.innerHTML = this.suggestions.map((s, i) => `
      <div class="qa-suggestion ${i === this.activeSuggestion ? 'active' : ''}" data-index="${i}">
        <i data-lucide="${s.icon}" class="qa-si-icon"></i>
        <div class="qa-si-body">
          <span class="qa-si-label">${escHtml(s.label)}</span>
          <span class="qa-si-desc">${escHtml(s.desc || '')}</span>
        </div>
        ${s.insert ? `<span class="qa-si-insert">${escHtml(s.insert)}</span>` : '<span class="qa-si-hint">info</span>'}
      </div>
    `).join('');

    // Bind click
    this.suggestionsEl.querySelectorAll('.qa-suggestion').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.index);
        this._applySuggestion(this.suggestions[idx]);
      });
      el.addEventListener('mouseenter', () => {
        this.activeSuggestion = parseInt(el.dataset.index);
        this._highlightSuggestion();
      });
    });

    lucide.createIcons();
  }

  _highlightSuggestion() {
    this.suggestionsEl.querySelectorAll('.qa-suggestion').forEach((el, i) => {
      el.classList.toggle('active', i === this.activeSuggestion);
    });
    // Scroll into view
    const active = this.suggestionsEl.querySelector('.qa-suggestion.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  _renderValidation() {
    const results = this.lineResults.filter(r => !r.empty);
    if (results.length === 0) {
      this.validationEl.innerHTML = '';
      return;
    }

    const valid = results.filter(r => r.valid).length;
    const invalid = results.filter(r => !r.valid).length;

    let html = `<span class="qa-val-count">${results.length} line${results.length !== 1 ? 's' : ''}</span>`;
    if (valid > 0) html += `<span class="qa-val-ok"><i data-lucide="check-circle"></i> ${valid} valid</span>`;
    if (invalid > 0) html += `<span class="qa-val-err"><i data-lucide="alert-circle"></i> ${invalid} invalid</span>`;

    // Show per-line validation
    const lineErrors = results.filter(r => !r.valid);
    if (lineErrors.length > 0 && lineErrors.length <= 3) {
      html += '<div class="qa-val-errors">';
      lineErrors.forEach(r => {
        html += `<div class="qa-val-error"><i data-lucide="alert-triangle"></i> L${this.lineResults.indexOf(r) + 1}: ${escHtml(r.error)}</div>`;
      });
      html += '</div>';
    }

    this.validationEl.innerHTML = html;
    lucide.createIcons();
  }

  _hidePanel() {
    this.panel.classList.remove('visible');
  }

  _showPanel() {
    this.panel.classList.add('visible');
  }

  // ─── Suggestion Application ───
  _applySuggestion(suggestion) {
    if (!suggestion || !suggestion.insert) return;

    const { field, index } = this._getCurrentField();
    const lines = this.textarea.value.split('\n');
    const line = lines[this.cursorLine] || '';
    const parts = line.split('|').map(p => p.trim());

    // Pad parts if needed
    while (parts.length < 5) parts.push('');

    if (field === 'cron') {
      parts[0] = suggestion.insert;
    } else if (field === 'name') {
      parts[1] = suggestion.insert;
    } else if (field === 'script') {
      parts[2] = suggestion.insert;
    } else if (field === 'args') {
      parts[3] = suggestion.insert;
    } else if (field === 'desc') {
      parts[4] = suggestion.insert;
    }

    // Rebuild line
    lines[this.cursorLine] = parts.filter(p => p !== '').join(' | ');
    this.textarea.value = lines.join('\n');

    // Move cursor to end of the inserted value
    const newLine = lines[this.cursorLine];
    let newPos = 0;
    for (let i = 0; i <= index; i++) {
      newPos += parts[i].length;
      if (i < index) newPos += 3; // ' | '
    }
    this.textarea.selectionStart = this.textarea.selectionEnd = newPos;
    this.textarea.focus();

    // Re-trigger validation and suggestions
    this._onInput();
  }

  // ─── Utilities ───
  _insertAtCursor(text) {
    const start = this.textarea.selectionStart;
    const end = this.textarea.selectionEnd;
    const val = this.textarea.value;
    this.textarea.value = val.substring(0, start) + text + val.substring(end);
    this.textarea.selectionStart = this.textarea.selectionEnd = start + text.length;
    this._onInput();
  }

  _addLineNumbers() {
    // Add line number gutter style to textarea via CSS class
    this.textarea.classList.add('qa-textarea');
  }

  // ─── Public API ───
  destroy() {
    if (this.panel && this.panel.parentNode) {
      this.panel.parentNode.removeChild(this.panel);
    }
  }

  getLineResults() {
    return this.lineResults;
  }

  getSuggestions() {
    return this.suggestions;
  }
}
