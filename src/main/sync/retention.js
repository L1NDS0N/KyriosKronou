// sync/retention.js - Deleting old content on purpose.
//
// A sync copies files to the destination; retention decides which of the
// copies have lived past their useful life. The rule set is intentionally
// simple and composable - the questions a human actually asks of an archive:
//
//   "delete anything older than 30 days"            -> byAge
//   "keep only the 10 most recent snapshots"        -> byCount
//   "the destination cannot exceed 50 GB"           -> bySize
//   "but keep one copy per month for 24 months"     -> byMonthly (also
//                                                      weekly, biweekly)
//
// The periodic rules PROTECT copies; they never compete with the delete
// rules. They once did, and age + monthly erased the whole history.
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

// Periodic "keep one copy per period" rules. Each maps a calendar day to a
// bucket index (consecutive periods get consecutive indexes) and a label the
// preview shows. Quinzenal follows the Brazilian convention: 1-15 and 16-end.
const PERIODS = {
  weekly: {
    // Monday-based weeks; day 0 (1970-01-01) was a Thursday.
    bucket: (day) => Math.floor((day.num + 3) / 7),
    label: (day) => {
      const thursday = new Date((Math.floor((day.num + 3) / 7) * 7) * DAY_MS);
      const y = thursday.getUTCFullYear();
      const week = Math.floor((thursday.getTime() - Date.UTC(y, 0, 1)) / DAY_MS / 7) + 1;
      return `${y}-W${String(week).padStart(2, '0')}`;
    },
  },
  biweekly: {
    bucket: (day) => (day.y * 12 + day.m) * 2 + (day.d > 15 ? 1 : 0),
    label: (day) => `${day.y}-${String(day.m + 1).padStart(2, '0')}-Q${day.d > 15 ? 2 : 1}`,
  },
  monthly: {
    bucket: (day) => day.y * 12 + day.m,
    label: (day) => `${day.y}-${String(day.m + 1).padStart(2, '0')}`,
  },
};

/**
 * Compile the profile's Retention config into an internal form, rejecting
 * configs that cannot do anything (so a typo never empties a destination).
 *
 * Rules come in two kinds, and the difference is the whole point:
 *   - delete rules (age, count, size) say what is disposable;
 *   - keep rules (weekly, biweekly, monthly) protect one copy per period
 *     for the last N periods, and a protected copy survives every delete rule.
 * "Older than 180 days + one per month for 24 months" therefore keeps the
 * last 180 days whole plus one copy of each month up to 24 months back.
 *
 * @param {object} cfg - { Enabled, DateSource, ByAge, KeepDays, ByCount,
 *                        KeepCount, BySize, FreeGb, ByWeekly, WeeklyKeepWeeks,
 *                        ByBiweekly, BiweeklyKeepPeriods, ByMonthly,
 *                        MonthlyKeepMonths, MinKeep }
 * @returns { ok, rules: [...], minKeep, dateSource, error? }
 */
function compile(cfg) {
  const c = cfg || {};
  // Default is the mtime, the clock retention always used; the Retention
  // screen sends 'names' when the user picks dates from file names.
  const dateSource = c.DateSource === 'names' ? 'names' : 'metadata';
  if (!c.Enabled) return { ok: true, rules: [], minKeep: 0, dateSource };

  const rules = [];
  const keepDays = parseInt(c.KeepDays, 10);
  if (c.ByAge && keepDays > 0) {
    rules.push({ type: 'age', kind: 'delete', days: keepDays });
  }
  const keepCount = parseInt(c.KeepCount, 10);
  if (c.ByCount && keepCount > 0) {
    rules.push({ type: 'count', kind: 'delete', keep: keepCount });
  }
  const freeGb = parseFloat(c.FreeGb);
  if (c.BySize && freeGb > 0) {
    rules.push({ type: 'size', kind: 'delete', freeBytes: freeGb * 1024 * 1024 * 1024 });
  }
  const periodic = [
    ['weekly', c.ByWeekly, c.WeeklyKeepWeeks],
    ['biweekly', c.ByBiweekly, c.BiweeklyKeepPeriods],
    ['monthly', c.ByMonthly, c.MonthlyKeepMonths],
  ];
  for (const [type, on, n] of periodic) {
    const periods = parseInt(n, 10);
    if (on && periods > 0) rules.push({ type, kind: 'keep', periods });
  }

  if (!rules.length) {
    return { ok: false, rules: [], minKeep: 0, dateSource, error: 'Política de retenção ativa sem nenhum critério (idade, quantidade, espaço ou cópias periódicas)' };
  }

  // Never below MinKeep snapshots, whatever the rules say.
  const minKeep = Math.max(0, parseInt(c.MinKeep, 10) || 0);
  return { ok: true, rules, minKeep, dateSource };
}

/** Local calendar day of an mtime; UTC calendar day of a name date. */
function _calendarDay(ms, fromName) {
  const d = new Date(ms);
  const y = fromName ? d.getUTCFullYear() : d.getFullYear();
  const m = fromName ? d.getUTCMonth() : d.getMonth();
  const dd = fromName ? d.getUTCDate() : d.getDate();
  return { y, m, d: dd, num: Math.floor(Date.UTC(y, m, dd) / DAY_MS) };
}

/**
 * Group files into snapshots - a top-level folder when the layout is nested,
 * or the file itself at the root - and date each one. Every rule decides on
 * whole snapshots, so a dated folder never survives half-deleted.
 */
function _snapshots(files, dateSource) {
  const units = new Map();
  for (const f of files) {
    const parts = f.rel.split('/');
    const key = parts.length > 1 ? parts[0] : '\u0000file:' + f.rel;
    let unit = units.get(key);
    if (!unit) {
      unit = { label: parts.length > 1 ? parts[0] : f.rel, files: [], size: 0, newestMtime: 0 };
      units.set(key, unit);
    }
    unit.files.push(f);
    unit.size += f.size || 0;
    if ((f.mtimeMs || 0) > unit.newestMtime) unit.newestMtime = f.mtimeMs || 0;
  }
  const out = [];
  for (const unit of units.values()) {
    // Names mode trusts the date in the snapshot's name and falls back to the
    // mtime when the name carries none - the same clock the age rule always
    // used, so undated files are not immune to retention.
    const nameDate = dateSource === 'names' ? parseDateFromName(unit.label) : null;
    unit.time = nameDate ? nameDate.getTime() : unit.newestMtime;
    unit.dateFrom = nameDate ? 'name' : 'metadata';
    unit.day = unit.time ? _calendarDay(unit.time, !!nameDate) : null;
    out.push(unit);
  }
  // Newest first; the mtime breaks ties between snapshots of the same day.
  out.sort((a, b) => (b.time - a.time) || (b.newestMtime - a.newestMtime));
  return out;
}

/**
 * Compute which files to delete from `files` (as returned by scanDest) under
 * the compiled rules. Pure: all clock input comes from `now`, which makes the
 * whole behaviour testable.
 *
 * Order of decision, per snapshot:
 *   1. protected (MinKeep, or chosen by a keep rule) -> kept, always;
 *   2. condemned by a delete rule -> deleted;
 *   3. with keep rules only and no delete rule, the policy means "keep ONLY
 *      the periodic copies", so anything unprotected is deleted.
 *
 * @param {Array} files - [{ rel, size, mtimeMs }]
 * @param {object} compiled - compile()'s output
 * @param {object} [hooks] - optional { now }
 * @returns { ok, delete: [{rel, reason, detail}], kept: [{rel, reason, detail}],
 *            rules, minKeep, dateSource, totalSnapshots, error? }
 */
function planDeletion(files, compiled, hooks = {}) {
  const now = hooks.now || Date.now();
  if (!compiled || !compiled.ok) {
    return { ok: false, delete: [], kept: [], error: (compiled && compiled.error) || 'Política de retenção inválida' };
  }
  const meta = { rules: compiled.rules, minKeep: compiled.minKeep, dateSource: compiled.dateSource || 'metadata' };
  if (!compiled.rules.length || !Array.isArray(files) || !files.length) {
    return { ok: true, delete: [], kept: [], totalSnapshots: 0, ...meta };
  }

  const units = _snapshots(files, meta.dateSource);
  const protectedBy = new Map(); // unit -> { reason, detail }
  const doomedBy = new Map();    // unit -> { reason, detail }

  units.slice(0, compiled.minKeep).forEach(u => protectedBy.set(u, { reason: 'minKeep', detail: `${compiled.minKeep}` }));

  // Keep rules: for each of the last N periods (the current one included),
  // the newest snapshot inside it is protected.
  const today = _calendarDay(now, false);
  for (const rule of compiled.rules.filter(r => r.kind === 'keep')) {
    const period = PERIODS[rule.type];
    const current = period.bucket(today);
    const taken = new Set();
    for (const u of units) { // newest first: the first seen per bucket wins
      if (!u.day) continue;
      const b = period.bucket(u.day);
      if (b > current || current - b >= rule.periods || taken.has(b)) continue;
      taken.add(b);
      if (!protectedBy.has(u)) protectedBy.set(u, { reason: rule.type, detail: period.label(u.day) });
    }
  }

  // A protected snapshot that a delete rule wanted is "rescued": the preview
  // lists those so the user sees the keep rules working.
  const rescued = new Set();
  const condemn = (u, reason, detail) => {
    if (protectedBy.has(u)) rescued.add(u);
    else if (!doomedBy.has(u)) doomedBy.set(u, { reason, detail });
  };
  const deleteRules = compiled.rules.filter(r => r.kind === 'delete');
  for (const rule of deleteRules) {
    if (rule.type === 'age') {
      const cutoff = now - rule.days * DAY_MS;
      for (const u of units) {
        if (u.time && u.time < cutoff) condemn(u, 'age', `${Math.floor((now - u.time) / DAY_MS)}d`);
      }
    } else if (rule.type === 'count') {
      for (const u of units.slice(rule.keep)) condemn(u, 'count', `>${rule.keep}`);
    }
  }
  // Size runs last: it only has to free what the other rules did not.
  const sizeRule = deleteRules.find(r => r.type === 'size');
  if (sizeRule) {
    let remaining = units.filter(u => !doomedBy.has(u)).reduce((s, u) => s + u.size, 0);
    const detail = `${Math.round(sizeRule.freeBytes / (1024 * 1024 * 1024))}GB`;
    for (const u of [...units].reverse()) { // oldest first
      if (remaining <= sizeRule.freeBytes) break;
      if (doomedBy.has(u)) continue;
      if (protectedBy.has(u)) { rescued.add(u); continue; }
      doomedBy.set(u, { reason: 'size', detail });
      remaining -= u.size;
    }
  }
  if (!deleteRules.length) {
    for (const u of units) condemn(u, 'notPeriodic', '');
  }

  const del = [];
  const kept = [];
  for (const u of units) {
    const why = doomedBy.get(u);
    if (why) {
      for (const f of u.files) del.push({ rel: f.rel, ...why, date: u.time ? new Date(u.time).toISOString() : null, size: f.size || 0 });
      continue;
    }
    const safe = rescued.has(u) && protectedBy.get(u);
    if (safe) {
      for (const f of u.files) kept.push({ rel: f.rel, ...safe, date: u.time ? new Date(u.time).toISOString() : null, size: f.size || 0 });
    }
  }
  // Oldest first reads like a timeline in the preview.
  del.reverse();
  kept.reverse();
  return { ok: true, delete: del, kept, totalSnapshots: units.length, ...meta };
}

module.exports = {
  analyze,
  compile,
  planDeletion,
  scanDest,
  parseDateFromName,
  DAY_MS,
};