// quickCreate.js - Smart textarea for batch task creation
// Parses text like: cron | name | script | [args] | [description]
//
// The cron is validated by the main process through window.api: the parser is a
// main-only module and instantiating it here was what silently broke the
// preview (and the Create button) with a ReferenceError.

function qcText(value) {
  if (typeof escHtml === 'function') return escHtml(value);
  const d = document.createElement('div');
  d.textContent = value == null ? '' : String(value);
  return d.innerHTML;
}

function qcT(key, params) {
  if (typeof i18n !== 'undefined' && i18n.t) return i18n.t(key, params);
  return key;
}

/** A bridge call that must never take the preview down with it. */
async function qcAsk(fn, fallback) {
  try { return await fn(); } catch (e) { return fallback; }
}

// Checking clashes walks a week of fire times per schedule, so only the first
// lines of a long paste are checked; the rest still show their own description.
const QUICK_CONFLICT_LIMIT = 8;

async function parseQuickLines(text, api) {
  const bridge = api || (typeof window !== 'undefined' ? window.api : null);
  const lines = String(text || '').split('\n').filter(l => l.trim());
  const results = [];

  for (const line of lines) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length < 3) {
      results.push({
        raw: line, valid: false, lineNum: results.length + 1,
        error: qcT('quick.error.minFields'),
      });
      continue;
    }

    let [cron, name, script, args, desc] = parts;
    // Auto-correct common cron mistakes
    cron = autoCorrectCron(cron);

    const scriptCheck = validateScriptPath(script);
    results.push({
      raw: line,
      cron,
      name: name || qcT('quick.unnamed'),
      script: script || '',
      args: args || '',
      description: desc || '',
      scriptError: scriptCheck.valid ? null : scriptCheck.error,
      cronOk: false,
      valid: false,
      error: null,
      lineNum: results.length + 1,
      scriptExt: scriptCheck.ext,
      cronFields: parseCronFields(cron),
      conflicts: [],
      suggestion: null,
    });
  }

  // Cron validity decides what can be created, so the whole batch waits for it.
  await Promise.all(results.map(async (r) => {
    if (!r.cron) return;
    r.cronOk = bridge && bridge.validateCron
      ? await qcAsk(() => bridge.validateCron(r.cron), false)
      : false;
    r.valid = r.cronOk && !r.scriptError;
    r.error = !r.cronOk
      ? qcT('quick.error.cronInvalid', { cron: r.cron })
      : r.scriptError;
  }));

  // Predictability before the click: what it runs, when it runs next, and what
  // already fires at the same time.
  let checked = 0;
  await Promise.all(results.map(async (r) => {
    if (!r.valid) return;
    r.descriptionText = bridge && bridge.getCronDescription
      ? await qcAsk(() => bridge.getCronDescription(r.cron), '')
      : '';
    r.nextRun = bridge && bridge.getNextRun
      ? await qcAsk(() => bridge.getNextRun(r.cron), null)
      : null;
    if (!bridge || !bridge.checkScheduleConflicts || checked >= QUICK_CONFLICT_LIMIT) return;
    checked++;
    const clash = await qcAsk(() => bridge.checkScheduleConflicts(r.cron), null);
    if (!clash || !clash.success) return;
    r.conflicts = clash.conflicts || [];
    r.suggestion = clash.suggestion || null;
  }));

  // Two identical crons in the same paste are invisible to the conflict check,
  // which only knows what is already saved.
  const seen = new Set();
  for (const r of results) {
    if (!r.valid) continue;
    if (seen.has(r.cron)) r.duplicate = true;
    seen.add(r.cron);
  }

  return results;
}

function validateScriptPath(script) {
  if (!script) return { valid: false, error: qcT('quick.error.noScript'), ext: '' };
  const trimmed = script.trim();
  const ext = getExt(trimmed);

  // Check valid extensions
  const validExts = ['.ps1', '.bat', '.cmd', '.exe', '.py', '.js', '.sh'];
  if (ext && !validExts.includes(ext.toLowerCase())) {
    return { valid: false, error: qcT('quick.error.unknownExt', { ext }), ext };
  }

  // Check for common path issues
  if (trimmed.includes('  ')) {
    return { valid: false, error: qcT('quick.error.doubleSpaces'), ext };
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
  const labels = qcT('quick.cronLabels').split(',');
  return parts.map((p, i) => {
    const label = labels[i] || '';
    let color = 'var(--green)';
    let desc = '';
    if (p === '*') desc = qcT('quick.cron.every', { field: label });
    else if (p.includes('/')) desc = qcT('quick.cron.everyN', { n: p.split('/')[1], field: label });
    else if (p.includes('-')) desc = qcT('quick.cron.range', { field: label });
    else if (/^\d+$/.test(p)) desc = qcT('quick.cron.at', { field: label, p });
    else color = 'var(--red)';
    return { value: p, color, desc, label };
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

function quickMetaLine(r) {
  const bits = [];
  if (r.descriptionText) bits.push(qcText(r.descriptionText));
  if (r.nextRun) bits.push(qcT('quick.nextRunAt', { when: formatQuickTime(r.nextRun) }));

  const flags = [];
  if (r.duplicate) flags.push(qcT('quick.duplicateCron'));
  if (r.conflicts && r.conflicts.length) {
    const who = r.conflicts.slice(0, 2).map(c => qcText(c.name)).join(', ');
    const rest = r.conflicts.length > 2 ? ` +${r.conflicts.length - 2}` : '';
    flags.push(qcT('quick.conflictsWith', { who: who + rest }));
  }
  return bits.concat(flags).join(' · ');
}

function formatQuickTime(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderQuickPreview(results) {
  const container = document.getElementById('quick-preview');
  const status = document.getElementById('quick-status');
  const syntaxBar = document.getElementById('quick-syntax-bar');
  if (!container || !status) return;

  if (!results || results.length === 0) {
    container.innerHTML = '';
    container.classList.remove('has-items');
    status.innerHTML = '';
    if (syntaxBar) syntaxBar.innerHTML = '';
    return;
  }

  container.classList.add('has-items');
  const validCount = results.filter(r => r.valid).length;
  const invalidCount = results.length - validCount;

  container.innerHTML = results.map(r => {
    const extBadge = r.scriptExt ? `<span class="qpi-ext">${qcText(r.scriptExt)}</span>` : '';
    const meta = r.valid ? quickMetaLine(r) : '';
    return `
    <div class="quick-preview-item ${r.valid ? 'valid' : 'invalid'}">
      <div class="qpi-main">
        <span class="qpi-linenum">${r.lineNum}</span>
        <span class="qpi-cron">${qcText(r.cron || '???')}</span>
        <span class="qpi-name">${qcText(r.name)}</span>
        <span class="qpi-script">${qcText(r.script || qcT('quick.noScript'))} ${extBadge}</span>
        <span class="qpi-status">${r.valid ? '&#10003;' : qcText(r.error || '')}</span>
      </div>
      ${meta ? `<div class="qpi-meta">${meta}</div>` : ''}
    </div>`;
  }).join('');

  status.innerHTML = `<span class="valid-count">${qcT('quick.validCount', { n: validCount })}</span>`
    + (invalidCount > 0 ? ` · <span class="invalid-count">${qcT('quick.invalidCount', { n: invalidCount })}</span>` : '');

  // Render syntax bar for the last/active line
  if (syntaxBar) {
    // Show combined cron field breakdown for all valid lines
    const validResults = results.filter(r => r.valid && r.cronFields);
    if (validResults.length > 0) {
      const last = validResults[validResults.length - 1];
      syntaxBar.innerHTML = last.cronFields.map(f =>
        `<span class="sb-field" style="color:${f.color}" data-tip="${qcText(f.desc)}"><span class="sb-val">${qcText(f.value)}</span><span class="sb-label">${qcText(f.label)}</span></span>`
      ).join('<span class="sb-sep">|</span>');
    } else {
      syntaxBar.innerHTML = '';
    }
  }
}
