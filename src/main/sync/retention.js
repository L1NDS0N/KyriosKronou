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

// Level-0 rule of formats: retention only ever manages archive extensions
// unless the user narrows them further - or empties the list, which means
// "no filter, every format". An empty list is therefore NOT the default; the
// absence of the key is.
const DEFAULT_EXTENSIONS = ['.7z', '.zip'];

// Share of a subfolder's files that must carry a date in a name component
// BELOW the subfolder itself before that subfolder is treated as its own
// archive (and gets its own pattern, suggestion and plan).
const ARCHIVE_DATE_SHARE = 0.6;

// Evidence samples per subfolder: a bounded sample keeps one huge subfolder
// from bloating every analysis response.
const FOLDER_EVIDENCE_LIMIT = 50;

/**
 * Normalize the format filter of a retention config into ['.7z', '.zip']-style
 * lowercase extensions. Accepts FileExtensions or Extensions (the UI may send
 * either), an array, or a delimited string. Returns [] when the user removed
 * the filter, which means every format.
 */
function normalizeExtensions(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg : {};
  let raw;
  if (Array.isArray(cfg)) raw = cfg;
  else {
    for (const key of ['FileExtensions', 'Extensions']) {
      if (Object.prototype.hasOwnProperty.call(src, key)) { raw = src[key]; break; }
    }
  }
  if (raw === undefined || raw === null) return DEFAULT_EXTENSIONS.slice();
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,\s;|]+/);
  const out = [];
  for (const item of list) {
    let ext = String(item === undefined || item === null ? '' : item).trim().toLowerCase();
    if (!ext) continue;
    if (ext === '*' || ext === 'all' || ext === 'todos') return [];
    if (ext.charAt(0) !== '.') ext = '.' + ext;
    if (!out.includes(ext)) out.push(ext);
  }
  return out;
}

/** Lowercase extension of a relative path, '' when it has none. */
function extensionOf(rel) {
  const base = String(rel || '').split('/').pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/**
 * Keep only the files whose format the policy manages. An empty filter list
 * means every format, so nothing is dropped. This runs BEFORE analysis and
 * before planning: a file outside the filter is invisible to retention.
 */
function filterByExtension(files, extensions) {
  const exts = Array.isArray(extensions) ? extensions : DEFAULT_EXTENSIONS;
  if (!exts.length) return files;
  const wanted = exts
    .map(e => String(e).trim().toLowerCase())
    .filter(Boolean)
    .map(e => (e.charAt(0) === '.' ? e : '.' + e));
  if (!wanted.length) return files;
  return files.filter(f => wanted.includes(extensionOf(f.rel)));
}

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
 * Split the destination into the units retention actually reasons about.
 *
 * A subfolder is its OWN archive when its own name carries no date and most of
 * its files carry one in a component below it ('daily/2026-09-20/db.7z'). Those
 * subfolders rotate independently - a nightly job next to a monthly one - so
 * each gets its own pattern, suggestion and plan. A subfolder whose own name IS
 * the date ('2026-09-22/dump.sql') is a snapshot of the destination itself and
 * stays in the root group, as do undated subfolders and the files at the root.
 *
 * @returns {Array} [{ rel, files }] - rel '' is the destination root, listed
 *          first, then the sub-archives in alphabetical order.
 */
function groupFiles(files) {
  const rootFiles = [];
  const candidates = new Map();
  for (const f of files) {
    const parts = f.rel.split('/');
    if (parts.length < 2 || parseDateFromName(parts[0]) || !_hasInnerDate(f.rel)) {
      rootFiles.push(f);
      continue;
    }
    let c = candidates.get(parts[0]);
    if (!c) { c = { rel: parts[0], total: 0, dated: 0, files: [] }; candidates.set(parts[0], c); }
    c.total++;
    c.dated++;
    c.files.push(f);
  }
  const groups = [];
  if (rootFiles.length) groups.push({ rel: '', files: rootFiles });
  for (const c of candidates.values()) {
    // The share is the guard: a subfolder that only sometimes holds dated
    // content is not an archive, it is part of the destination.
    if (c.total && c.dated / c.total >= ARCHIVE_DATE_SHARE) groups.push({ rel: c.rel, files: c.files });
    else rootFiles.push(...c.files);
  }
  groups.sort((a, b) => (a.rel ? 1 : 0) - (b.rel ? 1 : 0) || a.rel.localeCompare(b.rel));
  return groups;
}

/** True when a path component BELOW the top-level folder carries a date. */
function _hasInnerDate(rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (parseDateFromName(parts[i])) return true;
  }
  return false;
}

/**
 * Describe a set of files that belong to the same archive. Pure, so the whole
 * destination and each of its subfolders go through the exact same code.
 *
 * @returns { totalFiles, totalBytes, withDates, fromMetadata, dateIsh,
 *            folderPattern, medianGapDays, label, understood, ignored,
 *            filesTruncated, suggested }
 */
function _describe(files, opts, sampleLimit) {
  const { useNames, useMetadata } = opts;
  if (!files.length) {
    return {
      totalFiles: 0, totalBytes: 0, withDates: 0, fromMetadata: 0, dateIsh: 0,
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
      if (ignored.length < sampleLimit) ignored.push({ rel: f.rel, reason: 'no-date' });
      continue;
    }
    withDates++;
    if (inFolder) fromFolders++;
    dates.push(date.getTime());
    if (understood.length < sampleLimit) {
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
  return {
    totalFiles: files.length,
    totalBytes,
    withDates,
    fromMetadata,
    fromFolders,
    datedInFolders: fromFolders,
    dateIsh: Math.round(dateIsh * 100) / 100,
    folderPattern,
    medianGapDays,
    label: folderPattern,
    understood,
    ignored,
    filesTruncated: understood.length < withDates || ignored.length < files.length,
    suggested: _suggest({ dateIsh, medianGapDays, totalFiles: files.length }),
  };
}

/**
 * Look at a folder and describe its content pattern, per subfolder.
 *
 * The aggregate fields (totalFiles, folderPattern, medianGapDays, suggested,
 * understood...) describe the WHOLE destination and keep their historical
 * meaning. `folders` adds the per-subfolder view the UI turns into accordions:
 * each entry carries its own pattern, evidence and suggested policy, so a
 * nightly subfolder and a monthly one are never judged by the same clock.
 *
 * @param {string} dir - folder to inspect
 * @param {object} [options] - { scanner, useNames, useMetadata, extensions }
 *   `extensions` restricts the analysis to the formats retention manages;
 *   omit it to inspect everything.
 * @returns { ok, totalFiles, totalBytes, withDates, dateIsh (0..1),
 *            folderPattern: 'dated-folders'|'dated-files'|'mixed'|'flat',
 *            medianGapDays, suggested, folders, subfolders, extensions }
 */
function analyze(dir, options = {}) {
  const scanner = options.scanner || scanDest;
  const now = options.now || Date.now();
  // Date source toggle: file NAMES (default) and/or file METADATA (mtime).
  // Names beat metadata per file: a name that parses is a human's snapshot
  // label, the mtime is whatever the copy/transfer stamped.
  const opts = {
    useNames: options.useNames !== false,
    useMetadata: options.useMetadata === true,
  };
  // The format filter, when the caller knows it, is applied before anything is
  // measured - the analysis must not describe files retention would never touch.
  const exts = options.extensions === undefined || options.extensions === null
    ? null : normalizeExtensions(options.extensions);
  const scanned = scanner(dir);
  const files = exts ? filterByExtension(scanned, exts) : scanned;

  if (!files.length) {
    return {
      ok: true, totalFiles: 0, totalBytes: 0, withDates: 0, dateIsh: 0,
      folderPattern: 'flat', medianGapDays: null, label: 'empty',
      understood: [], ignored: [], filesTruncated: false,
      folders: [], subfolders: [],
      extensions: exts || DEFAULT_EXTENSIONS.slice(),
      suggested: _suggest({ totalFiles: 0, dateIsh: 0, medianGapDays: null }),
    };
  }

  // A bounded sample prevents a folder with tens of thousands of files from
  // bloating every analyzer response.
  const total = _describe(files, opts, 500);
  const groups = groupFiles(files);
  const folders = groups.map(g => {
    const d = _describe(g.files, opts, FOLDER_EVIDENCE_LIMIT);
    return {
      rel: g.rel,
      isRoot: g.rel === '',
      totalFiles: d.totalFiles,
      totalBytes: d.totalBytes,
      withDates: d.withDates,
      dateIsh: d.dateIsh,
      folderPattern: d.folderPattern,
      pattern: d.folderPattern,
      label: d.label,
      medianGapDays: d.medianGapDays,
      evidence: {
        understood: d.understood,
        ignored: d.ignored,
        truncated: d.filesTruncated,
        datedInFolders: d.datedInFolders,
        fromMetadata: d.fromMetadata,
      },
      suggested: d.suggested,
      suggestion: d.suggested,
    };
  });

  return {
    ok: true,
    ...total,
    // With more than one archive the single aggregate suggestion is the union
    // of what each one needs - never stricter than a subfolder's own policy.
    suggested: _mergeSuggested(folders.map(f => f.suggested)),
    folders,
    subfolders: _subfolderInventory(files),
    extensions: exts || DEFAULT_EXTENSIONS.slice(),
    grouping: groups.length > 1 ? 'folders' : 'root',
  };
}

/** Top-level subfolder inventory: { rel, files, bytes }, alphabetical. */
function _subfolderInventory(files) {
  const seen = new Map();
  for (const f of files) {
    const parts = f.rel.split('/');
    if (parts.length < 2) continue;
    let e = seen.get(parts[0]);
    if (!e) { e = { rel: parts[0], files: 0, bytes: 0 }; seen.set(parts[0], e); }
    e.files++;
    e.bytes += f.size || 0;
  }
  return [...seen.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The least destructive policy that satisfies every subfolder's own policy. */
function _mergeSuggested(list) {
  const parts = list.filter(Boolean);
  if (!parts.length) return _suggest({ totalFiles: 0, dateIsh: 0, medianGapDays: null });
  if (parts.length === 1) return parts[0];
  const out = {
    Enabled: false, ByAge: false, KeepDays: 0, ByCount: false, KeepCount: 0,
    BySize: false, FreeGb: 0, ByMonthly: false, MinKeep: 0,
  };
  for (const s of parts) {
    out.Enabled = out.Enabled || s.Enabled;
    if (s.ByAge) { out.ByAge = true; out.KeepDays = Math.max(out.KeepDays, s.KeepDays); }
    if (s.ByCount) { out.ByCount = true; out.KeepCount = Math.max(out.KeepCount, s.KeepCount); }
    if (s.BySize) { out.BySize = true; out.FreeGb = Math.max(out.FreeGb, s.FreeGb); }
    out.ByMonthly = out.ByMonthly || s.ByMonthly;
    out.MinKeep = Math.max(out.MinKeep, s.MinKeep);
  }
  return out;
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
 * @param {object} cfg - { Enabled, DateSource, FileExtensions, ByAge, KeepDays, ByCount,
 *                        KeepCount, BySize, FreeGb, ByWeekly, WeeklyKeepWeeks,
 *                        ByBiweekly, BiweeklyKeepPeriods, ByMonthly,
 *                        MonthlyKeepMonths, MinKeep }
 * @returns { ok, rules: [...], minKeep, dateSource, extensions, error? }
 */
function compile(cfg) {
  const c = cfg || {};
  // Default is the mtime, the clock retention always used; the Retention
  // screen sends 'names' when the user picks dates from file names.
  const dateSource = c.DateSource === 'names' ? 'names' : 'metadata';
  // Format filter. Absent key -> the level-0 default; empty list -> every format.
  const extensions = normalizeExtensions(c);
  if (!c.Enabled) return { ok: true, rules: [], minKeep: 0, dateSource, extensions };

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
    return { ok: false, rules: [], minKeep: 0, dateSource, extensions, error: 'Política de retenção ativa sem nenhum critério (idade, quantidade, espaço ou cópias periódicas)' };
  }

  // Never below MinKeep snapshots, whatever the rules say.
  const minKeep = Math.max(0, parseInt(c.MinKeep, 10) || 0);
  return { ok: true, rules, minKeep, dateSource, extensions };
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
 * Group one archive's files into snapshots - its dated subfolder, or the file
 * itself - and date each one. Every rule decides on whole snapshots, so a
 * dated folder never survives half-deleted.
 */
function _snapshots(group, dateSource) {
  const units = new Map();
  for (const f of group.files) {
    const parts = f.rel.split('/');
    // Inside a sub-archive the label is the component BELOW the subfolder, so
    // 'daily/2026-09-20/db.7z' is a snapshot called 2026-09-20 - not a whole
    // subfolder called 'daily'.
    const rest = group.rel ? parts.slice(1) : parts;
    const key = rest.length > 1 ? rest[0] : '\u0000file:' + f.rel;
    let unit = units.get(key);
    if (!unit) {
      unit = { label: rest.length > 1 ? rest[0] : f.rel, files: [], size: 0, newestMtime: 0 };
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
 * The destination is split into archives first (see groupFiles) and every
 * count/age/periodic rule is applied WITHIN each one, so a subfolder is never
 * judged by the rotation of its neighbour - or, as the bug behind this was,
 * by the rotation of whichever folder happened to be found first. The size
 * rule stays global: it is a budget for the whole destination.
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
 *            folders: [{ rel, delete, kept }], rules, minKeep, dateSource,
 *            extensions, totalSnapshots, error? }
 */
function planDeletion(files, compiled, hooks = {}) {
  const now = hooks.now || Date.now();
  if (!compiled || !compiled.ok) {
    return { ok: false, delete: [], kept: [], folders: [], error: (compiled && compiled.error) || 'Política de retenção inválida' };
  }
  const meta = { rules: compiled.rules, minKeep: compiled.minKeep, dateSource: compiled.dateSource || 'metadata' };
  // The format filter comes first: a .sql sitting next to the archives is not
  // retention's business when the policy only manages .7z/.zip.
  const scoped = Array.isArray(compiled.extensions) ? filterByExtension(Array.isArray(files) ? files : [], compiled.extensions)
    : (Array.isArray(files) ? files : []);
  if (!compiled.rules.length || !scoped.length) {
    return { ok: true, delete: [], kept: [], folders: [], totalSnapshots: 0, extensions: compiled.extensions || [], ...meta };
  }

  const groups = groupFiles(scoped);
  for (const g of groups) g.units = _snapshots(g, meta.dateSource);
  const units = groups.flatMap(g => g.units);
  const protectedBy = new Map(); // unit -> { reason, detail }
  const doomedBy = new Map();    // unit -> { reason, detail }
  const keepRules = compiled.rules.filter(r => r.kind === 'keep');

  const today = _calendarDay(now, false);
  for (const g of groups) {
    g.units.slice(0, compiled.minKeep).forEach(u => protectedBy.set(u, { reason: 'minKeep', detail: `${compiled.minKeep}` }));

    // Keep rules: for each of the last N periods (the current one included),
    // the newest snapshot of THIS archive inside it is protected.
    for (const rule of keepRules) {
      const period = PERIODS[rule.type];
      const current = period.bucket(today);
      const taken = new Set();
      for (const u of g.units) { // newest first: the first seen per bucket wins
        if (!u.day) continue;
        const b = period.bucket(u.day);
        if (b > current || current - b >= rule.periods || taken.has(b)) continue;
        taken.add(b);
        if (!protectedBy.has(u)) protectedBy.set(u, { reason: rule.type, detail: period.label(u.day) });
      }
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
      for (const g of groups) {
        for (const u of g.units) {
          if (u.time && u.time < cutoff) condemn(u, 'age', `${Math.floor((now - u.time) / DAY_MS)}d`);
        }
      }
    } else if (rule.type === 'count') {
      // Per archive: "keep the last 5" means 5 snapshots in EVERY subfolder.
      for (const g of groups) {
        for (const u of g.units.slice(rule.keep)) condemn(u, 'count', `>${rule.keep}`);
      }
    }
  }
  // Size runs last: it only has to free what the other rules did not, and its
  // budget is the destination's, not each subfolder's.
  const sizeRule = deleteRules.find(r => r.type === 'size');
  if (sizeRule) {
    let remaining = units.filter(u => !doomedBy.has(u)).reduce((s, u) => s + u.size, 0);
    const detail = `${Math.round(sizeRule.freeBytes / (1024 * 1024 * 1024))}GB`;
    const oldestFirst = [...units].sort((a, b) => (a.time - b.time) || (a.newestMtime - b.newestMtime));
    for (const u of oldestFirst) {
      if (remaining <= sizeRule.freeBytes) break;
      if (doomedBy.has(u)) continue;
      if (protectedBy.has(u)) { rescued.add(u); continue; }
      doomedBy.set(u, { reason: 'size', detail });
      remaining -= u.size;
    }
  }
  if (!deleteRules.length) {
    for (const g of groups) {
      for (const u of g.units) condemn(u, 'notPeriodic', '');
    }
  }

  const del = [];
  const kept = [];
  const folders = [];
  for (const g of groups) {
    const groupDel = [];
    const groupKept = [];
    for (const u of g.units) {
      const why = doomedBy.get(u);
      if (why) {
        for (const f of u.files) groupDel.push({ rel: f.rel, folder: g.rel, ...why, date: u.time ? new Date(u.time).toISOString() : null, size: f.size || 0 });
        continue;
      }
      const safe = rescued.has(u) && protectedBy.get(u);
      if (safe) {
        for (const f of u.files) groupKept.push({ rel: f.rel, folder: g.rel, ...safe, date: u.time ? new Date(u.time).toISOString() : null, size: f.size || 0 });
      }
    }
    // Oldest first reads like a timeline in the preview.
    groupDel.reverse();
    groupKept.reverse();
    del.push(...groupDel);
    kept.push(...groupKept);
    folders.push({
      rel: g.rel,
      isRoot: g.rel === '',
      files: g.files.length,
      totalSnapshots: g.units.length,
      delete: groupDel,
      kept: groupKept,
      deleteBytes: groupDel.reduce((s, d) => s + (d.size || 0), 0),
    });
  }
  return {
    ok: true, delete: del, kept, folders,
    totalSnapshots: units.length,
    extensions: compiled.extensions || [],
    ...meta,
  };
}

module.exports = {
  analyze,
  compile,
  planDeletion,
  scanDest,
  parseDateFromName,
  groupFiles,
  normalizeExtensions,
  filterByExtension,
  extensionOf,
  DEFAULT_EXTENSIONS,
  DAY_MS,
};