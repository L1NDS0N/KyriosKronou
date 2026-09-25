// backupArtifacts.js - opening a backup file the UI claims exists.
//
// The history tells the UI which file each run produced, but the UI must never
// decide WHERE to open: whatever arrives from a renderer is untrusted input, and
// backup-history.json is a file anyone with write access can edit. So the caller
// sends a profile id plus a file NAME, and the full path is rebuilt here from
// the profile's own folder before anything is handed to the shell.
//
// electron-free on purpose, like the rest of src/main: shell.showItemInFolder
// and shell.openPath are the caller's business, which keeps this loadable by the
// headless service and by the tests.

const fs = require('fs');
const path = require('path');

// Every failure carries an i18n key, never a sentence: the main process does not
// know which language the user picked.
const REASONS = Object.freeze({
  PROFILE_MISSING: 'artifact.profileMissing',
  FOLDER_MISSING: 'artifact.folderMissing',
  FOLDER_NOT_FOUND: 'artifact.folderNotFound',
  NOT_A_FOLDER: 'artifact.notAFolder',
  NAME_MISSING: 'artifact.nameMissing',
  INVALID_NAME: 'artifact.invalidName',
  OUTSIDE_FOLDER: 'artifact.outsideFolder',
  NOT_FOUND: 'artifact.notFound',
  NOT_A_FILE: 'artifact.notAFile',
});

const fail = (reason) => ({ ok: false, reason });

function resolveProfile(manager, profileId) {
  if (!manager || typeof manager.getProfile !== 'function') return null;
  const id = typeof profileId === 'string' ? profileId.trim() : '';
  if (!id) return null;
  const profile = manager.getProfile(id);
  return profile && typeof profile === 'object' ? profile : null;
}

/**
 * A backup file name is ONE segment of a name, never a path.
 *
 * Refusing separators here instead of resolving them and inspecting the result
 * is what makes the containment check below a second line of defence rather than
 * the only one.
 */
function validateName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return fail(REASONS.NAME_MISSING);
  // A null byte truncates the name inside the Win32 API, so "app.sql\0.dll" is
  // a bypass on its own - before any path is ever resolved.
  if (name.includes('\0')) return fail(REASONS.INVALID_NAME);
  if (name === '.' || name === '..') return fail(REASONS.INVALID_NAME);
  if (/[\\/]/.test(name) || path.isAbsolute(name)) return fail(REASONS.INVALID_NAME);
  // basename() catches the Windows-only spellings the rules above miss, such as
  // the drive-relative "C:app.sql" or a trailing "app.sql ".
  if (path.basename(name) !== name) return fail(REASONS.INVALID_NAME);
  return { ok: true, name };
}

/**
 * Is `candidate` a strict descendant of `root`?
 *
 * A raw string prefix is not enough - it accepts `C:\backups-old` as a child of
 * `C:\backups` - and a case-SENSITIVE comparison is wrong here: the GUI and the
 * service each write the history, and Windows does not care how the folder name
 * is cased. So both sides are resolved and compared case-insensitively, and the
 * separator is required back after the prefix.
 */
function isInside(root, candidate) {
  let rootFull;
  let candFull;
  try {
    rootFull = path.resolve(String(root || '').trim());
    candFull = path.resolve(String(candidate || '').trim());
  } catch (e) {
    return false;
  }
  if (!rootFull || !candFull) return false;
  const prefix = rootFull.toLowerCase();
  const lowerCand = candFull.toLowerCase();
  if (lowerCand === prefix) return false;
  if (!lowerCand.startsWith(prefix)) return false;
  // A folder that is a drive root already ends in the separator; for any other
  // folder the separator has to follow the prefix, which is what stops
  // `C:\backups-old` from counting as a child of `C:\backups`.
  return rootFull.endsWith(path.sep) || candFull[prefix.length] === path.sep;
}

function resolveFolder(profile) {
  const raw = profile && typeof profile.BackupPath === 'string' ? profile.BackupPath.trim() : '';
  if (!raw || raw.includes('\0')) return fail(REASONS.FOLDER_MISSING);
  // The folder comes from the profile, but a relative one would resolve against
  // whatever cwd the process happens to have - the service included.
  if (!path.isAbsolute(raw)) return fail(REASONS.FOLDER_MISSING);
  const folder = path.resolve(raw);

  let stats;
  try { stats = fs.statSync(folder); }
  catch (e) { return fail(REASONS.FOLDER_NOT_FOUND); }
  if (!stats.isDirectory()) return fail(REASONS.NOT_A_FOLDER);
  return { ok: true, folder };
}

/**
 * Resolve the file a history entry claims exists.
 *
 * @param {object} manager    anything with getProfile(id) - BackupManager
 * @param {string} profileId  the profile the file belongs to
 * @param {string} name       a file NAME, never a path
 * @returns {{ok: true, filePath: string, fileName: string, folder: string, size: number}
 *          |{ok: false, reason: string}}
 */
function findArtifact(manager, profileId, name) {
  const profile = resolveProfile(manager, profileId);
  if (!profile) return fail(REASONS.PROFILE_MISSING);

  const folder = resolveFolder(profile);
  if (!folder.ok) return folder;

  const checked = validateName(name);
  if (!checked.ok) return checked;

  const filePath = path.join(folder.folder, checked.name);
  if (!isInside(folder.folder, filePath)) return fail(REASONS.OUTSIDE_FOLDER);

  let stats;
  try { stats = fs.statSync(filePath); }
  catch (e) { return fail(REASONS.NOT_FOUND); }
  // A directory in the backup folder is not something to hand to Explorer, and
  // a reparse point that claims to be a file is refused too.
  if (!stats.isFile()) return fail(REASONS.NOT_A_FILE);

  return { ok: true, filePath, fileName: checked.name, folder: folder.folder, size: stats.size };
}

/** The profile's backup folder, for the "the file is gone, show me the folder" case. */
function findFolder(manager, profileId) {
  const profile = resolveProfile(manager, profileId);
  if (!profile) return fail(REASONS.PROFILE_MISSING);
  return resolveFolder(profile);
}

/** Does this history result have a local file worth a button? */
function hasLocalArtifact(result) {
  if (!result || result.success === false) return false;
  if (result.remoteOnly) return false;
  return validateName(result.fileName).ok;
}

module.exports = {
  REASONS,
  validateName,
  isInside,
  resolveFolder,
  findArtifact,
  findFolder,
  hasLocalArtifact,
};
