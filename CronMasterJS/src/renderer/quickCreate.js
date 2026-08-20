// quickCreate.js - Smart textarea for batch task creation
// Parses text like: cron | name | script | [args] | [description]

function parseQuickLines(text, cronParser) {
  const lines = text.split('\n').filter(l => l.trim());
  const results = [];

  for (const line of lines) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 3) {
      results.push({ raw: line, valid: false, error: 'Need at least: cron | name | script' });
      continue;
    }

    let [cron, name, script, args, desc] = parts;

    // Auto-correct common cron mistakes
    cron = autoCorrectCron(cron);

    const valid = cronParser.validate(cron);
    results.push({
      raw: line,
      valid,
      cron,
      name: name || 'Unnamed Task',
      script: script || '',
      args: args || '',
      description: desc || '',
      error: valid ? null : `Invalid cron: ${cron}`
    });
  }
  return results;
}

function autoCorrectCron(expr) {
  if (!expr) return '* * * * *';
  let c = expr.trim();

  // Common shorthand replacements
  const shorthands = {
    'every minute': '* * * * *',
    'every hour': '0 * * * *',
    'every day': '0 0 * * *',
    'every week': '0 0 * * 0',
    'every month': '0 0 1 * *',
    'daily': '0 0 * * *',
    'hourly': '0 * * * *',
    'weekly': '0 0 * * 0',
    'monthly': '0 0 1 * *',
    'weekdays': '0 9 * * 1-5',
    'weekends': '0 9 * * 0,6',
  };
  const lower = c.toLowerCase();
  if (shorthands[lower]) return shorthands[lower];

  // Fix: single number without spaces → assume "X * * * *"
  if (/^\d+$/.test(c) && parseInt(c) <= 59) {
    return `${c} * * * *`;
  }

  // Fix: "HH:MM" format → "MM HH * * *"
  const hmMatch = c.match(/^(\d{1,2}):(\d{2})$/);
  if (hmMatch) {
    return `${hmMatch[2]} ${hmMatch[1]} * * *`;
  }

  // Fix: common typos
  c = c.replace(/\s+/g, ' ');
  c = c.replace(/,\s*$/, '');

  // Fix: missing fields → pad with *
  const fields = c.split(' ');
  while (fields.length < 5) fields.push('*');

  return fields.slice(0, 5).join(' ');
}

function renderQuickPreview(results) {
  const container = document.getElementById('quick-preview');
  const status = document.getElementById('quick-status');
  if (!container || !status) return;

  if (results.length === 0) {
    container.innerHTML = '';
    container.classList.remove('has-items');
    status.innerHTML = '';
    return;
  }

  container.classList.add('has-items');
  const validCount = results.filter(r => r.valid).length;
  const invalidCount = results.filter(r => !r.valid).length;

  container.innerHTML = results.map(r => `
    <div class="quick-preview-item ${r.valid ? 'valid' : 'invalid'}">
      <span class="qpi-cron">${escHtml(r.cron || '???')}</span>
      <span class="qpi-name">${escHtml(r.name || 'Unnamed')}</span>
      <span class="qpi-script">${escHtml(r.script || 'no script')}</span>
      <span class="qpi-status">${r.valid ? 'OK' : r.error}</span>
    </div>
  `).join('');

  status.innerHTML = `<span class="valid-count">${validCount} valid</span>${invalidCount > 0 ? ` · <span class="invalid-count">${invalidCount} invalid</span>` : ''}`;
}
