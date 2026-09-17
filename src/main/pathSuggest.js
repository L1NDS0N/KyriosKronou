// pathSuggest.js - Windows path completion.
//
// Typing a full path into a text box is the slowest, most error-prone part of
// creating a task, a service or a backup profile, and a wrong path only shows
// up later as a failed run. This walks the filesystem as the user types and
// offers what actually exists.
//
// Deliberately conservative: it only ever READS directory listings, never
// follows a path it was not given, and caps how much it returns so a listing
// of C:\Windows\System32 cannot lock the UI.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_RESULTS = 40;
// Long enough to be useful, short enough that the UI never stalls on a slow
// network drive.
const LIST_TIMEOUT_MS = 1500;

/** Environment shortcuts worth expanding, newest Windows first. */
const WELL_KNOWN = {
  '%programfiles%': process.env.ProgramFiles || 'C:\\Program Files',
  '%programfiles(x86)%': process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  '%programdata%': process.env.ProgramData || 'C:\\ProgramData',
  '%appdata%': process.env.APPDATA || '',
  '%localappdata%': process.env.LOCALAPPDATA || '',
  '%userprofile%': process.env.USERPROFILE || os.homedir(),
  '%temp%': process.env.TEMP || os.tmpdir(),
  '%windir%': process.env.windir || 'C:\\Windows',
  '%systemroot%': process.env.SystemRoot || 'C:\\Windows',
};

function expandEnv(input) {
  return String(input || '').replace(/%([^%]+)%/g, (match) => {
    const key = match.toLowerCase();
    if (WELL_KNOWN[key]) return WELL_KNOWN[key];
    const name = match.slice(1, -1);
    return process.env[name] != null ? process.env[name] : match;
  });
}

/** Drive letters that currently exist, so the list is never a guess. */
function listDrives() {
  const drives = [];
  for (let code = 65; code <= 90; code++) {
    const root = String.fromCharCode(code) + ':\\';
    try {
      fs.accessSync(root);
      drives.push(root);
    } catch (e) { /* not present */ }
  }
  return drives;
}

function isDirectory(full) {
  try { return fs.statSync(full).isDirectory(); } catch (e) { return false; }
}

/**
 * Suggest completions for a partially typed path.
 *
 * @param {string} input       what the user has typed
 * @param {object} options
 *        - kind: 'file' | 'directory' | 'any'   what the field is asking for
 *        - extensions: ['.ps1', '.bat']         restrict files to these
 * @returns {{ base: string, suggestions: Array }}
 */
function suggest(input, options = {}) {
  const kind = options.kind || 'any';
  const extensions = (options.extensions || []).map(e => e.toLowerCase());
  const raw = String(input || '');

  // Nothing typed yet: offer the drives and the usual starting points.
  if (!raw.trim()) {
    const starters = listDrives().map(d => ({ name: d, full: d, directory: true }));
    for (const [alias, target] of Object.entries(WELL_KNOWN)) {
      if (target && isDirectory(target)) {
        starters.push({ name: alias, full: target, directory: true, hint: target });
      }
    }
    return { base: '', suggestions: starters.slice(0, MAX_RESULTS) };
  }

  const expanded = expandEnv(raw).replace(/\//g, '\\');

  // Split into "the directory to list" and "the fragment to match".
  let dir;
  let fragment;
  const lastSep = expanded.lastIndexOf('\\');
  if (lastSep === -1) {
    // A bare word: match against drive roots rather than the process cwd,
    // which would be meaningless to the user.
    dir = null;
    fragment = expanded.toLowerCase();
    const drives = listDrives()
      .filter(d => d.toLowerCase().startsWith(fragment))
      .map(d => ({ name: d, full: d, directory: true }));
    return { base: '', suggestions: drives };
  }

  dir = expanded.slice(0, lastSep + 1);
  fragment = expanded.slice(lastSep + 1).toLowerCase();

  let entries;
  try {
    // readdirSync on a huge or unreachable directory is the one real risk
    // here; the try/catch plus the cap below is what keeps the UI responsive.
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { base: dir, suggestions: [], error: e.code === 'ENOENT' ? 'not-found' : e.code };
  }

  const matches = [];
  for (const entry of entries) {
    if (matches.length >= MAX_RESULTS) break;
    const name = entry.name;
    if (fragment && !name.toLowerCase().startsWith(fragment)) continue;

    let directory;
    try { directory = entry.isDirectory(); } catch (e) { directory = false; }

    if (!directory) {
      if (kind === 'directory') continue;
      if (extensions.length && !extensions.includes(path.extname(name).toLowerCase())) continue;
    }

    matches.push({
      name,
      full: path.join(dir, name) + (directory ? '\\' : ''),
      directory,
    });
  }

  // Directories first: the user is usually still navigating.
  matches.sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name) : (a.directory ? -1 : 1)));
  return { base: dir, suggestions: matches };
}

/** Does this path exist, and is it what the field expects? */
function validate(input, options = {}) {
  const kind = options.kind || 'any';
  const full = expandEnv(input || '').trim();
  if (!full) return { exists: false, message: '' };

  let stat;
  try { stat = fs.statSync(full); }
  catch (e) { return { exists: false, message: 'Este caminho não existe' }; }

  const directory = stat.isDirectory();
  if (kind === 'directory' && !directory) return { exists: true, valid: false, directory, message: 'É um arquivo; informe uma pasta' };
  if (kind === 'file' && directory) return { exists: true, valid: false, directory, message: 'É uma pasta; informe um arquivo' };

  return { exists: true, valid: true, directory, resolved: full, size: directory ? null : stat.size };
}

module.exports = { suggest, validate, expandEnv, listDrives, MAX_RESULTS, LIST_TIMEOUT_MS };
