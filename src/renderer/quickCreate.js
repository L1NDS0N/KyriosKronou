// quickCreate.js - Smart textarea for batch task creation with syntax validation
// Parses text like: cron | name | script | [args] | [description]

function parseQuickLines(text, cronParser) {
  const lines = text.split('\n').filter(l => l.trim());
  const results = [];

  for (const line of lines) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 3) {
      results.push({ raw: line, valid: false, error: 'Need at least: cron | name | script', lineNum: results.length + 1 });
      continue;
    }

    let [cron, name, script, args, desc] = parts;

    // Auto-correct common cron mistakes
    cron = autoCorrectCron(cron);

    const cronValid = cronParser.validate(cron);
    const scriptValid = validateScriptPath(script);
    const valid = cronValid && scriptValid.valid;

    let error = null;
    if (!cronValid) error = `Invalid cron: ${cron}`;
    else if (!scriptValid.valid) error = scriptValid.error;

    results.push({
      raw: line,
      valid,
      cron,
      name: name || 'Unnamed Task',
      script: script || '',
      args: args || '',
      description: desc || '',
      error,
      lineNum: results.length + 1,
      scriptExt: scriptValid.ext,
      cronFields: parseCronFields(cron)
    });
  }
  return results;
}

function validateScriptPath(script) {
  if (!script) return { valid: false, error: 'No script path', ext: '' };
  const trimmed = script.trim();
  const ext = getExt(trimmed);

  // Check valid extensions
  const validExts = ['.ps1', '.bat', '.cmd', '.exe', '.py', '.js', '.sh'];
  if (ext && !validExts.includes(ext.toLowerCase())) {
    return { valid: false, error: `Unknown extension: ${ext}`, ext };
  }

  // Check for common path issues
  if (trimmed.includes('  ')) {
    return { valid: false, error: 'Double spaces in path', ext };
  }

  return { valid: true, ext };
}

function getExt(path) {
  const lastDot = path.lastIndexOf('.');
  const lastSlash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastDot > lastSlash) return path.substring(lastDot);
  return '';
}

function parseCronFields(cron) {
  if (!cron) return [];
  const parts = cron.split(/\s+/);
  const labels = ['minute', 'hour', 'day', 'month', 'weekday'];
  return parts.map((p, i) => {
    let color = 'var(--green)';
    let desc = '';
    if (p === '*') desc = `every ${labels[i]}`;
    else if (p.includes('/')) desc = `every ${p.split('/')[1]} ${labels[i]}(s)`;
    else if (p.includes('-')) desc = `${labels[i]} ${p}`;
    else if (/^\d+$/.test(p)) desc = `${labels[i]} ${p}`;
    else { color = 'var(--red)'; desc = 'invalid'; }
    return { value: p, color, desc, label: labels[i] };
  });
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

  // Fix: single number without spaces -> assume "X * * * *"
  if (/^\d+$/.test(c) && parseInt(c) <= 59) {
    return `${c} * * * *`;
  }

  // Fix: "HH:MM" format -> "MM HH * * *"
  const hmMatch = c.match(/^(\d{1,2}):(\d{2})$/);
  if (hmMatch) {
    return `${hmMatch[2]} ${hmMatch[1]} * * *`;
  }

  // Fix: common typos
  c = c.replace(/\s+/g, ' ');
  c = c.replace(/,\s*$/, '');

  // Fix: missing fields -> pad with *
  const fields = c.split(' ');
  while (fields.length < 5) fields.push('*');

  return fields.slice(0, 5).join(' ');
}

function renderQuickPreview(results) {
  const container = document.getElementById('quick-preview');
  const status = document.getElementById('quick-status');
  const syntaxBar = document.getElementById('quick-syntax-bar');
  if (!container || !status) return;

  if (results.length === 0) {
    container.innerHTML = '';
    container.classList.remove('has-items');
    status.innerHTML = '';
    if (syntaxBar) syntaxBar.innerHTML = '';
    return;
  }

  container.classList.add('has-items');
  const validCount = results.filter(r => r.valid).length;
  const invalidCount = results.filter(r => !r.valid).length;

  container.innerHTML = results.map(r => {
    const extBadge = r.scriptExt ? `<span class="qpi-ext">${r.scriptExt}</span>` : '';
    return `
    <div class="quick-preview-item ${r.valid ? 'valid' : 'invalid'}">
      <span class="qpi-linenum">${r.lineNum}</span>
      <span class="qpi-cron">${escHtml(r.cron || '???')}</span>
      <span class="qpi-name">${escHtml(r.name || 'Unnamed')}</span>
      <span class="qpi-script">${escHtml(r.script || 'no script')} ${extBadge}</span>
      <span class="qpi-status">${r.valid ? '&#10003;' : r.error}</span>
    </div>`;
  }).join('');

  status.innerHTML = `<span class="valid-count">${validCount} valid</span>${invalidCount > 0 ? ` · <span class="invalid-count">${invalidCount} invalid</span>` : ''}`;

  // Render syntax bar for the last/active line
  if (syntaxBar) {
    // Show combined cron field breakdown for all valid lines
    const validResults = results.filter(r => r.valid && r.cronFields);
    if (validResults.length > 0) {
      const last = validResults[validResults.length - 1];
      syntaxBar.innerHTML = last.cronFields.map(f =>
        `<span class="sb-field" style="color:${f.color}"><span class="sb-val">${escHtml(f.value)}</span><span class="sb-label">${f.label}</span></span>`
      ).join('<span class="sb-sep">|</span>');
    } else {
      syntaxBar.innerHTML = '';
    }
  }
}
