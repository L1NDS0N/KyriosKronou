// sync/engines/index.js - Sync destination engine registry.
//
// Mirrors src/main/db/index.js: one small interface per destination type, so
// adding Google Drive or another storage later is a new module here plus a
// line in the list - no changes anywhere else.
//
// Electron-free, so the Windows service can load it too.

const local = require('./local');
const smb = require('./smb');
const ftp = require('./ftp');
const sftp = require('./sftp');

const ENGINES = [local, smb, ftp, sftp];
const BY_ID = new Map(ENGINES.map(e => [e.id, e]));

function get(id) {
  return BY_ID.get(String(id || 'local').toLowerCase()) || local;
}

function has(id) {
  return BY_ID.has(String(id || '').toLowerCase());
}

/** Everything the UI needs to render the destination picker. */
function list() {
  return ENGINES.map(e => ({
    id: e.id,
    label: e.label,
    defaultPort: e.defaultPort || null,
    credentials: e.id !== 'local', // local needs no host/user
  }));
}

/**
 * A remote engine moves one file per connection, which is correct for a
 * handful of files and punishing for thousands. Profiles pointing at one are
 * warned in the UI, not blocked.
 */
function isRemotePerFile(id) {
  const e = get(id);
  return e.id === 'ftp' || e.id === 'sftp';
}

/**
 * Every engine must expose list(dest): retention decisions are made over
 * the destination's real contents, whatever the storage type.
 */
function listFiles(dest, id) {
  const e = get(id);
  if (typeof e.list !== 'function') return [];
  return Promise.resolve(e.list(dest)).then(
    (files) => (Array.isArray(files) ? files : []),
    () => [] // unreachable destination: nothing to report, retention skips
  );
}

module.exports = {
  get,
  has,
  list,
  listFiles,
  isRemotePerFile,
  INTERFACE: {
    testConnection(dest) { return Promise.resolve({ success: false, message: 'not implemented' }); },
    copyFile(localPath, dest, rel) { return Promise.resolve({ success: false }); },
    deleteFile(dest, rel) { return Promise.resolve({ success: false }); },
    list(dest) { return []; },
  },
};
