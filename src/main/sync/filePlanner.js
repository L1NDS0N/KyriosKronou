// sync/filePlanner.js - What should be copied, and why.
//
// A sync is only as trustworthy as its plan, so the plan is computed up front,
// as a pure-ish step over the real filesystem, and handed to an engine. The
// engine then does mechanical work (copy/delete) and never has to make
// decisions of its own.
//
// Two questions the user is asked when creating a profile:
//   - "everything" vs "only new/changed files"  -> mode: 'full' | 'incremental'
//   - "mirror the destination"                  -> mirror: delete dest files
//                                                  that no longer exist at the
//                                                  source
//
// Electron-free, so the Windows service can load it too.

const fs = require('fs');
const path = require('path');

// Destination timestamps can lose sub-second precision (network shares, FAT),
// so an equal size plus a clock-level tie counts as "unchanged".
const MTIME_TOLERANCE_MS = 1000;

/**
 * Recursively list every file under `dir` as { rel, size, mtimeMs }.
 * `rel` always uses forward slashes, so plans are identical no matter which
 * platform separator the filesystem reports. Symlinks are skipped: a link
 * pointing back up the tree would otherwise loop forever.
 */
function scan(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;

  const walk = (base) => {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (e) {
      return; // unreadable directory: skip it, the run reports what it could do
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
 * Compile a user-facing exclude pattern into a regex over `rel` paths.
 *
 *   '*.log'        any .log file, at any depth
 *   'node_modules' a file OR folder with that name, at any depth (its whole
 *                  subtree is excluded because nothing under it is scanned)
 *   'build/*.tmp'  contains a slash: anchored to the source root, one level
 *                  deep - 'deep/build/x.tmp' is NOT matched
 */
function compileExclude(pattern) {
  const p = String(pattern || '').trim().replace(/^\/+|\/+$/g, '');
  if (!p) return null;
  const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  // Slashed patterns are relative to the source root; bare words and bare
  // wildcards apply at any depth.
  if (p.includes('/')) {
    return new RegExp(`^${escaped}$`);
  }
  if (!p.includes('*')) {
    return new RegExp(`(?:^|/)${escaped}(?:/|$)`);
  }
  return new RegExp(`(?:^|/)${escaped}$`);
}

function isExcluded(rel, regexes) {
  for (const re of regexes) {
    if (re.test(rel)) return true;
  }
  return false;
}

/**
 * Build the sync plan.
 *
 * @param {object} options
 *   sourceDir   absolute path to sync from (required, must exist)
 *   destDir     absolute path to sync to (required)
 *   mode        'incremental' (default: only new/changed) or 'full' (everything)
 *   excludes    string patterns, see compileExclude
 *   mirror      also list destination files that vanished from the source
 *   scanner     injectable scan function (defaults to the real filesystem)
 *
 * @returns { ok: true, copy: [{rel, reason}], delete: [rel], skipped,
 *            totalSource, totalBytes }
 *       or { ok: false, error }
 */
function plan(options) {
  const opts = options || {};
  const sourceDir = opts.sourceDir;
  const destDir = opts.destDir;
  const mode = opts.mode === 'full' ? 'full' : 'incremental';
  const mirror = !!opts.mirror;
  const scanner = opts.scanner || scan;

  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return { ok: false, error: `Pasta de origem não encontrada: ${sourceDir || '(não informada)'}` };
  }
  if (!destDir) {
    return { ok: false, error: 'Pasta de destino não informada' };
  }

  const src = path.resolve(sourceDir);
  const dst = path.resolve(destDir);
  // Syncing a folder into itself would walk the destination while copying to
  // it and grow without bound.
  if (dst === src || dst.startsWith(src + path.sep)) {
    return { ok: false, error: 'A pasta de destino não pode ser a origem nem estar dentro dela' };
  }

  const excludeRes = (opts.excludes || []).map(compileExclude).filter(Boolean);
  const sourceFiles = scanner(src).filter(f => !isExcluded(f.rel, excludeRes));
  const sourceMap = new Map(sourceFiles.map(f => [f.rel, f]));

  // Incremental mode needs the destination listing to tell new from changed.
  // Full mode does not: everything is copied either way.
  const destFiles = (mirror || mode === 'incremental') && fs.existsSync(dst)
    ? scanner(dst)
    : [];
  const destMap = new Map(destFiles.map(f => [f.rel, f]));

  const copy = [];
  let skipped = 0;
  let totalBytes = 0;

  for (const f of sourceFiles) {
    totalBytes += f.size || 0;
    if (mode === 'full') {
      copy.push({ rel: f.rel, reason: 'full' });
      continue;
    }
    const d = destMap.get(f.rel);
    if (!d) {
      copy.push({ rel: f.rel, reason: 'new' });
      continue;
    }
    const sizeChanged = (d.size || 0) !== (f.size || 0);
    const sourceNewer = (f.mtimeMs - (d.mtimeMs || 0)) > MTIME_TOLERANCE_MS;
    if (sizeChanged || sourceNewer) {
      copy.push({ rel: f.rel, reason: 'changed' });
    } else {
      skipped++;
    }
  }

  // Mirror deletes must respect the same excludes as the source scan:
  // an excluded file is "invisible", and invisibility must not be punished
  // with deletion on the destination.
  const del = [];
  if (mirror) {
    for (const rel of destMap.keys()) {
      if (!sourceMap.has(rel) && !isExcluded(rel, excludeRes)) del.push(rel);
    }
  }

  return {
    ok: true,
    copy,
    delete: del,
    skipped,
    totalSource: sourceFiles.length,
    totalBytes,
  };
}

module.exports = { plan, scan, compileExclude, isExcluded, MTIME_TOLERANCE_MS };
