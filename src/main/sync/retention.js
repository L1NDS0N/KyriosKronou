// sync/retention.js - Deleting old content on purpose.
//
// A sync copies files to the destination; retention decides which of the
// copies have lived past their useful life. The rule set is intentionally
// simple and composable - age, count and size - because those are the three
// questions a human actually asks of an archive:
//
//   "delete anything older than 30 days"            -> byAge
//   "keep only the 10 most recent snapshots"        -> byCount
//   "the destination cannot exceed 50 GB"           -> bySize
//
// It also knows how to *look* at a folder and propose a policy: files whose
// names carry dates (2026-09-22, backup-20260922.zip, log_09-2026.txt) are
// timed content, and the spacing between dates suggests a natural retention
// window. The wizard uses that to fill the form so the user confirms instead
// of configuring from scratch.
//
// Electron-free, so the Windows service can load it too.

const fs = require('fs');
const path = require('path');

// Date shapes a filename may carry, tried in order of specificity.
// All of them must be plausible dates - 20261345 or 99-99-9999 are just
// long numbers, and treating them as dates would compute nonsense ages.
const DATE_PATTERNS = [
  { re: /(?:^|[^\d])(\d{4})-(\d{2})-(\d{2})(?:[^\d]|$)/, order: ['y', 'm', 'd'] },        // 2026-09-22
  { re: /(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?:[^\d]|$)/, order: ['y', 'm', 'd'] },          // 20260922
  { re: /(?:^|[^\d])(\d{2})-(\d{2})-(\d{4})(?:[^\d]|$)/, order: ['d', 'm', 'y'] },        // 22-09-2026
  { re: /(?:^|[^\d])(\d{2})\.(\d{2})\.(\d{4})(?:[^\d]|$)/, order: ['d', 'm', 'y'] },      // 22.09.2026
  { re: /(?:^|[^\d])(\d{2})_(\d{2})_(\d{4})(?:[^\d]|$)/, order: ['d', 'm', 'y'] },        // 22_09_2026
];

const DAY_MS = 86400000;

/** Parse the first plausible date in a filename; null when there is none. */
function parseDateFromName(name) {
  for (const p of DATE_PATTERNS) {
    const m = name.match(p.re);
    if (!m) continue;
    const parts = {};
    p.order.forEach((key, i) => { parts[key] = parseInt(m[i + 1], 10); });
    const { y, m: month, d } = parts;
    if (month < 1 || month > 12 || d < 1 || d > 31) continue;
    const date = new Date(Date.UTC(y, month - 1, d));
    // Round-trips only when the calendar agrees (rejects 30-02-2026).
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== d) continue;
    // Anything this old predates computing; anything in the future is a
    // different convention (e.g. 20260922 as a version number).
    if (y < 1970 || date.getTime() > Date.now() + DAY_MS) continue;
    return date;
  }
  return null;
}

/**
 * Recursively list destination files as { rel, size, mtimeMs }.
 * Mirrors filePlanner.scan; kept separate so the planner never grows
 * retention concerns.
 */
function scanDest(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const walk = (base) => {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(base, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      out.push({
        rel: path.relative(dir, full).replace(/\\/g, '/'),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  };
  walk(dir);
  return out;
}

/**
 * Look at a folder and describe its content pattern.
 *
 * @returns { ok, totalFiles, totalBytes, withDates, dateIsh (0..1),
 *            folderPattern: 'dated-folders'|'dated-files'|'mixed'|'flat',
 *            medianGapDays, suggested: {Enabled, ByAge, KeepDays, ByCount,
 *            KeepCount, BySize, FreeGb}, label }
 */
function analyze(dir, options = {}) {
  const scanner = options.scanner || scanDest;
  const now = options.now || Date.now();
  // Date source toggle: file NAMES (default) and/or file METADATA (mtime).
  // Names beat metadata per file: a name that parses is a human's snapshot
  // label, the mtime is whatever the copy/transfer stamped.
  const useNames = options.useNames !== false;
  const useMetadata = options.useMetadata === true;
  const files = scanner(dir);

  if (!files.length) {
    return {
      ok: true, totalFiles: 0, totalBytes: 0, withDates: 0, dateIsh: 0,
      folderPattern: 'flat', medianGapDays: null, label: 'empty',
      understood: [], ignored: [], filesTruncated: false,
      suggested: _suggest({ totalFiles: 0, dateIsh: 0, medianGapDays: null }),
    };
  }

  // The snapshot label is the FIRST date-bearing component of each path,
  // wherever it sits: '2026-09-22/dump.sql' -> the folder,
  // 'snapshots/2026-09-22/dump.sql' -> the middle folder,
  // 'backup-20260922.zip' -> the file name itself.
  let withDates = 0;
  let fromFolders = 0;
  let fromMetadata = 0;
  const dates = [];
  // Keep the evidence visible in the UI. A bounded sample prevents a folder
  // with tens of thousands of files from bloating every analyzer response.
  const FILE_SAMPLE_LIMIT = 500;
  const understood = [];
  const ignored = [];

  for (const f of files) {
    let date = null;
    let inFolder = false;
    let source = null;
    if (useNames) {
      const parts = f.rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        const d = parseDateFromName(parts[i]);
        if (!d) continue;
        date = d;
        inFolder = i < parts.length - 1;
        source = inFolder ? 'folder-name' : 'file-name';
        break;
      }
    }
    // Metadata fallback: the mtime is the snapshot date when the name says
    // nothing. The age rule already trusts mtimes, so the analysis does too.
    if (!date && useMetadata && f.mtimeMs) {
      date = new Date(f.mtimeMs);
      source = 'metadata';
      fromMetadata++;
    }
    if (!date) {
      if (ignored.length < FILE_SAMPLE_LIMIT) ignored.push({ rel: f.rel, reason: 'no-date' });
      continue;
    }
    withDates++;
    if (inFolder) fromFolders++;
    dates.push(date.getTime());
    if (understood.length < FILE_SAMPLE_LIMIT) {
      understood.push({ rel: f.rel, source, date: date.toISOString(), size: f.size || 0 });
    }
  }

  // Median gap between consecutive dated snapshots suggests how often
  // content rotates: daily folders ~1 day, monthly ~30.
  let medianGapDays = null;
  if (dates.length >= 2) {
    const sorted = [...new Set(dates)].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
    gaps.sort((a, b) => a - b);
    medianGapDays = Math.round(gaps[Math.floor(gaps.length / 2)] / DAY_MS);
  }

  const dateIsh = withDates / files.length;
  const folderPattern = dateIsh >= 0.6
    ? (fromFolders > withDates / 2 ? 'dated-folders' : 'dated-files')
    : (dateIsh > 0.1 ? 'mixed' : 'flat');

  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  const suggested = _suggest({ dateIsh, medianGapDays, totalFiles: files.length });

  return {
    ok: true,
    totalFiles: files.length,
    totalBytes,
    withDates,
    fromMetadata,
    dateIsh: Math.round(dateIsh * 100) / 100,
    folderPattern,
    medianGapDays,
    label: folderPattern,
    understood,
    ignored,
    filesTruncated: understood.length < withDates || ignored.length < files.length,
    suggested,
  };
}

/**
 * Propose a policy from the observed pattern. Conservative on purpose:
 * dated content gets age + count guards, flat content only size, and
 * nothing suggests deleting without a safety margin.
 */
function _suggest({ dateIsh, medianGapDays, totalFiles }) {
  const s = {
    Enabled: false,
    ByAge: false, KeepDays: 30,
    ByCount: false, KeepCount: 10,
    BySize: false, FreeGb: 0,
    ByMonthly: false,
    MinKeep: 3,
  };
  if (!totalFiles) return s;

  if (dateIsh >= 0.6) {
    // Timed content: the median gap tells us what "old" means here.
    s.Enabled = true;
    s.ByAge = true;
    if (medianGapDays && medianGapDays > 0) {
      // Keep ~4 rotations plus a weekend of slack.
      s.KeepDays = Math.max(7, medianGapDays * 4 + 2);
    }
    s.ByCount = true;
    s.KeepCount = Math.max(5, Math.round((s.KeepDays / (medianGapDays || 1)) * 1.5));
  } else {
    // Flat content has no intrinsic clock; only a size cap is safe to guess.
    s.Enabled = true;
    s.BySize = true;
    s.FreeGb = 10;
  }
  return s;
}

/**
 * Compile the profile's Retention config into an internal form, rejecting
 * configs that cannot do anything (so a typo never empties a destination).
 *
 * @param {object} cfg - { Enabled, ByAge, KeepDays, ByCount, KeepCount,
 *                        BySize, FreeGb, ByMonthly, MinKeep }
 * @returns { ok, rules: [...], minKeep, error? }
 */
function compile(cfg) {
  const c = cfg || {};
  if (!c.Enabled) return { ok: true, rules: [], minKeep: 0 };

  const rules = [];
  const keepDays = parseInt(c.KeepDays, 10);
  if (c.ByAge && keepDays > 0) {
    rules.push({ type: 'age', days: keepDays });
  }
  const keepCount = parseInt(c.KeepCount, 10);
  if (c.ByCount && keepCount > 0) {
    rules.push({ type: 'count', keep: keepCount });
  }
  const freeGb = parseFloat(c.FreeGb);
  if (c.BySize && freeGb > 0) {
    rules.push({ type: 'size', freeBytes: freeGb * 1024 * 1024 * 1024 });
  }
  // Monthly rule: one snapshot per month is kept - the annual history. It
  // composes with the other rules like age does.
  if (c.ByMonthly && c.MonthlyKeepMonths > 0) {
    rules.push({ type: 'monthly' });
  }

  if (!rules.length) {
    return { ok: false, rules: [], minKeep: 0, error: 'Política de retenção ativa sem nenhum critério (idade, quantidade ou espaço)' };
  }

  // Never below MinKeep files, whatever the rules say.
  const minKeep = Math.max(0, parseInt(c.MinKeep, 10) || 0);
  return { ok: true, rules, minKeep };
}

/**
 * Compute which files to delete from `files` (as returned by scanDest) under
 * the compiled rules. Pure: all clock input comes from `now`, which makes the
 * whole behaviour testable.
 *
 * @param {Array} files - [{ rel, size, mtimeMs }]
 * @param {object} compiled - compile()'s output
 * @param {object} [hooks] - optional { now, logger } for audit logging
 * @returns { ok, delete: [{rel, reason, detail}], error? }
 */
function planDeletion(files, compiled, hooks = {}) {
  const now = hooks.now || Date.now();
  if (!compiled || !compiled.ok) {
    return { ok: false, delete: [], error: (compiled && compiled.error) || 'Política de retenção inválida' };
  }
  if (!compiled.rules.length) return { ok: true, delete: [] };
  if (!Array.isArray(files) || !files.length) return { ok: true, delete: [] };

  const doomed = new Map(); // rel -> { reason, detail }

  for (const rule of compiled.rules) {
    if (rule.type === 'age') {
      const cutoff = now - rule.days * DAY_MS;
      for (const f of files) {
        const mtime = f.mtimeMs || 0;
        if (mtime && mtime < cutoff && !doomed.has(f.rel)) {
          doomed.set(f.rel, { reason: 'age', detail: `${Math.floor((now - mtime) / DAY_MS)}d` });
        }
      }
    } else if (rule.type === 'count') {
      // "Keep the N most recent snapshots." A snapshot is a top-level
      // folder when the layout is nested, or the file itself at the root -
      // dated folders die whole, flat files die one by one.
      const units = new Map(); // key -> { newest, files: [] }
      for (const f of files) {
        const parts = f.rel.split('/');
        const key = parts.length > 1 ? parts[0] : '\u0000file:' + f.rel;
        let unit = units.get(key);
        if (!unit) { unit = { newest: 0, files: [] }; units.set(key, unit); }
        unit.files.push(f);
        if ((f.mtimeMs || 0) > unit.newest) unit.newest = f.mtimeMs || 0;
      }
      const ordered = [...units.values()].sort((a, b) => b.newest - a.newest);
      for (const unit of ordered.slice(rule.keep)) {
        for (const f of unit.files) {
          if (!doomed.has(f.rel)) doomed.set(f.rel, { reason: 'count', detail: `>${rule.keep}` });
        }
      }
    } else if (rule.type === 'monthly') {
      // Annual history, one snapshot per month. A snapshot is the same unit
      // as the count rule: a top-level dated folder, or the file itself. For
      // each month (YYYY-MM), the NEWEST unit inside it survives; everything
      // else in that month is old history. Units whose date is unknown are
      // never touched.
      const units = new Map(); // key -> { newest, month, files: [] }
      for (const f of files) {
        const parts = f.rel.split('/');
        const key = parts.length > 1 ? parts[0] : '\u0000file:' + f.rel;
        let unit = units.get(key);
        if (!unit) { unit = { newest: 0, month: null, files: [] }; units.set(key, unit); }
        unit.files.push(f);
        if ((f.mtimeMs || 0) > unit.newest) unit.newest = f.mtimeMs || 0;
        if (!unit.month) {
          let label = parts.length > 1 ? parts[0] : f.rel;
          const d = parseDateFromName(label);
          if (d) unit.month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        }
      }
      const newestByMonth = new Map(); // 'YYYY-MM' -> newest mtime
      for (const unit of units.values()) {
        if (!unit.month) continue;
        const cur = newestByMonth.get(unit.month) || 0;
        if (unit.newest > cur) newestByMonth.set(unit.month, unit.newest);
      }
      for (const unit of units.values()) {
        if (!unit.month) continue; // undated: never condemned by month rule
        if (unit.newest < (newestByMonth.get(unit.month) || 0)) {
          for (const f of unit.files) {
            if (!doomed.has(f.rel)) doomed.set(f.rel, { reason: 'monthly', detail: unit.month });
          }
        }
      }
    } else if (rule.type === 'size') {
      // Free space target: delete oldest-first until (total - deleted) fits.
      const total = files.reduce((s, f) => s + (f.size || 0), 0);
      const mustFree = total - rule.freeBytes;
      if (mustFree > 0) {
        const byAge = [...files].sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
        let freed = 0;
        for (const f of byAge) {
          if (freed >= mustFree) break;
          if (!doomed.has(f.rel)) doomed.set(f.rel, { reason: 'size', detail: `${Math.round(mustFree / (1024 * 1024))}MB` });
          freed += f.size || 0;
        }
      }
    }
  }

  // MinKeep: the newest files are always safe. Sort newest-first and mark
  // that many as untouchable, whatever the rules computed.
  if (compiled.minKeep > 0) {
    const byAge = [...files].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    for (const f of byAge.slice(0, compiled.minKeep)) doomed.delete(f.rel);
  }

  return { ok: true, delete: [...doomed.entries()].map(([rel, why]) => ({ rel, ...why })) };
}

module.exports = {
  analyze,
  compile,
  planDeletion,
  scanDest,
  parseDateFromName,
  DAY_MS,
};