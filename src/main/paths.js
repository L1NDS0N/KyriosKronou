// paths.js - Single source of truth for data locations.
//
// The GUI runs as the logged-in user; the Windows service runs as LocalSystem.
// Those two accounts have DIFFERENT %APPDATA% folders, so storing tasks there
// meant the service started fine and then scheduled nothing - it was reading an
// empty config directory. Everything lives under %ProgramData% instead, which
// both accounts share.
//
// Must stay free of any `electron` require: the service process loads this as
// plain Node (ELECTRON_RUN_AS_NODE=1).

const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_DIR_NAME = 'KyriosChronos';

function programData() {
  return process.env.ProgramData || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
}

function roamingAppData() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

// KYRION_DATA_DIR lets the service (and the tests) be pointed somewhere else.
function dataDir() {
  return process.env.KYRION_DATA_DIR || path.join(programData(), APP_DIR_NAME);
}

function configDir() { return path.join(dataDir(), 'config'); }
function logsDir() { return path.join(dataDir(), 'logs'); }

// Heartbeat file naming the process that currently owns task execution.
function ownerFile() { return path.join(configDir(), 'scheduler-owner.json'); }

// Directories the GUI used before the %ProgramData% move, newest first.
function legacyDirs() {
  const roaming = roamingAppData();
  return [
    path.join(roaming, 'KyrionKronou'),
    path.join(roaming, 'CronMaster'),
  ];
}

function ensureDirs() {
  for (const dir of [dataDir(), configDir(), logsDir()]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  return { dataDir: dataDir(), configDir: configDir(), logsDir: logsDir() };
}

function copyDirInto(src, dst) {
  if (!fs.existsSync(src)) return 0;
  if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(src)) {
    const from = path.join(src, entry);
    const to = path.join(dst, entry);
    try {
      if (fs.statSync(from).isDirectory()) {
        copied += copyDirInto(from, to);
      } else if (!fs.existsSync(to)) {
        // Never clobber data already living in the new location.
        fs.copyFileSync(from, to);
        copied++;
      }
    } catch (e) { /* skip unreadable entries, migration is best-effort */ }
  }
  return copied;
}

/**
 * Move config/logs out of the old per-user %APPDATA% folders on first run.
 * Idempotent: a marker file stops it from running again, and existing files in
 * the destination are never overwritten.
 */
function migrateLegacyData() {
  ensureDirs();
  const marker = path.join(dataDir(), '.migrated');
  if (fs.existsSync(marker)) return { migrated: false, reason: 'already-migrated' };

  let copied = 0;
  const sources = [];
  for (const legacy of legacyDirs()) {
    if (!fs.existsSync(legacy)) continue;
    const n = copyDirInto(path.join(legacy, 'config'), configDir())
            + copyDirInto(path.join(legacy, 'logs'), logsDir());
    if (n > 0) { copied += n; sources.push(legacy); }
  }

  try {
    fs.writeFileSync(marker, JSON.stringify({
      at: new Date().toISOString(), copied, sources,
    }, null, 2), 'utf8');
  } catch (e) { /* marker is an optimisation, not a requirement */ }

  return { migrated: copied > 0, copied, sources };
}

module.exports = {
  APP_DIR_NAME,
  dataDir,
  configDir,
  logsDir,
  ownerFile,
  legacyDirs,
  ensureDirs,
  migrateLegacyData,
};
