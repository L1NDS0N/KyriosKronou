// db/index.js - Database engine registry.
//
// Backups used to assume MySQL everywhere: mysqldump was located in the
// BackupManager constructor and its command line was built inline. Adding a
// second engine that way would have meant if/else through the whole file, so
// each engine now lives behind one small interface and the BackupManager only
// asks the registry for the right one.
//
// To add an engine (PostgreSQL, Oracle, MongoDB...), write a module exposing
// the shape below and list it here. Nothing else needs to change.
//
// An engine module provides:
//
//   id                 stable key stored on the profile (never shown raw)
//   label              name shown in the UI
//   defaultPort
//   dumpExtension      '.sql', '.bak', ...
//   backupTargetIsRemote
//                      true, or a function of the profile, when the engine
//                      writes the file itself on the database host rather than
//                      streaming it here. The UI has to say so, because the
//                      path then means something different.
//   formats            optional list of output formats the engine offers
//                      (SQL Server: native .bak vs portable .bacpac)
//   extensionFor(p)    optional, when the extension depends on the format
//   capabilities       { listDatabases, allDatabases, compression }
//   findTool(config)   -> path string or null (engines that need a CLI)
//   testConnection(profile)            -> { success, message, version? }
//   listDatabases(profile)             -> { success, databases[], message? }
//   backup(profile, database, outPath) -> { success, message, stdout, stderr, size? }

const mysql = require('./mysql');
const sqlserver = require('./sqlserver');

const ENGINES = [mysql, sqlserver];
const BY_ID = new Map(ENGINES.map(e => [e.id, e]));

const DEFAULT_ENGINE = mysql.id;

/** Engine for a profile. Profiles written before multi-engine support have no
 *  Engine field and are MySQL, which keeps them working untouched. */
function forProfile(profile) {
  return get((profile && profile.Engine) || DEFAULT_ENGINE);
}

function get(id) {
  return BY_ID.get(String(id || DEFAULT_ENGINE).toLowerCase()) || BY_ID.get(DEFAULT_ENGINE);
}

function has(id) {
  return BY_ID.has(String(id || '').toLowerCase());
}

/** Everything the UI needs to render the engine picker. */
function list() {
  return ENGINES.map(e => ({
    id: e.id,
    label: e.label,
    defaultPort: e.defaultPort,
    dumpExtension: e.dumpExtension,
    backupTargetIsRemote: typeof e.backupTargetIsRemote === 'function' ? null : !!e.backupTargetIsRemote,
    formats: e.formats || null,
    capabilities: e.capabilities,
    toolName: e.toolName || null,
  }));
}

/** File extension for a profile, honouring the engine's chosen format. */
function extensionFor(profile) {
  const engine = forProfile(profile);
  return engine.extensionFor ? engine.extensionFor(profile) : engine.dumpExtension;
}

/** Whether the backup file is written on the database host, not here. */
function writesOnServer(profile) {
  const engine = forProfile(profile);
  return typeof engine.backupTargetIsRemote === 'function'
    ? !!engine.backupTargetIsRemote(profile)
    : !!engine.backupTargetIsRemote;
}

module.exports = { get, has, list, forProfile, extensionFor, writesOnServer, DEFAULT_ENGINE, ENGINES };
