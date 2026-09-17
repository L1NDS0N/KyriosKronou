// db/mysql.js - MySQL and MariaDB engine.
//
// Dumps through mysqldump. Credentials travel in a temporary UTF-8 defaults
// file rather than on the command line: on Windows mysqldump converts
// command-line arguments through the process ANSI code page, which corrupts a
// non-ASCII password and yields "1045 Access denied" for a perfectly valid one.
// See tests/test-backup-credentials.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFile } = require('child_process');

const CRED_DIR_PREFIX = 'kyrios-mycnf-';

const CANDIDATES = [
  'C:\\Program Files\\MySQL\\MySQL Server 9.0\\bin\\mysqldump.exe',
  'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqldump.exe',
  'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
  'C:\\Program Files\\MySQL\\MySQL Server 5.7\\bin\\mysqldump.exe',
  'C:\\Program Files\\MySQL\\MySQL Server 5.6\\bin\\mysqldump.exe',
  'C:\\Program Files (x86)\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
  'C:\\Program Files\\MariaDB 11.0\\bin\\mysqldump.exe',
  'C:\\Program Files\\MariaDB 10.6\\bin\\mysqldump.exe',
  'C:\\Program Files\\MariaDB 10.5\\bin\\mysqldump.exe',
  'C:\\Program Files\\MariaDB 10.4\\bin\\mysqldump.exe',
  'C:\\Program Files (x86)\\MariaDB 10.4\\bin\\mysqldump.exe',
  'C:\\xampp\\mysql\\bin\\mysqldump.exe',
  'C:\\wamp64\\bin\\mysql\\mysql8.0.31\\bin\\mysqldump.exe',
  'C:\\wamp64\\bin\\mysql\\mysql8.2.0\\bin\\mysqldump.exe',
  'C:\\wamp64\\bin\\mysql\\mariadb-10.6.12\\bin\\mysqldump.exe',
  'C:\\wamp\\bin\\mysql\\mysql8.0.31\\bin\\mysqldump.exe',
  'C:\\laragon\\bin\\mysql\\mysql-8.0.30\\bin\\mysqldump.exe',
  'C:\\laragon\\bin\\mysql\\mariadb-10.6.9\\bin\\mysqldump.exe',
  'C:\\ProgramData\\DockerDesktop\\version-bin\\mysqldump.exe',
  'C:\\ProgramData\\chocolatey\\bin\\mysqldump.exe',
  'C:\\tools\\mysql\\bin\\mysqldump.exe',
  'C:\\tools\\mysql\\current\\bin\\mysqldump.exe',
  'C:\\MySQL\\bin\\mysqldump.exe',
  'C:\\mysql\\bin\\mysqldump.exe',
  '/usr/bin/mysqldump',
  '/usr/local/bin/mysqldump',
  '/usr/local/mysql/bin/mysqldump',
  '/opt/homebrew/bin/mysqldump',
  '/opt/homebrew/opt/mysql-client/bin/mysqldump',
  '/snap/bin/mysqldump',
];

function findTool(config) {
  const custom = config && config.getSetting ? config.getSetting('MysqldumpPath', '') : '';
  if (custom && fs.existsSync(custom)) return custom;

  try {
    const cmd = process.platform === 'win32' ? 'where mysqldump 2>nul' : 'which mysqldump 2>/dev/null';
    const found = execSync(cmd, { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    const first = found.split('\n')[0].trim();
    if (first && fs.existsSync(first)) return first;
  } catch (e) {}

  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }

  for (const env of ['MYSQL_HOME', 'MYSQL_DIR', 'MYSQLPATH', 'MARIADB_HOME']) {
    if (!process.env[env]) continue;
    for (const exe of ['mysqldump.exe', 'mysqldump']) {
      const p = path.join(process.env[env], 'bin', exe);
      if (fs.existsSync(p)) return p;
    }
  }

  // Scan the usual install roots for any version.
  for (const root of ['C:\\tools\\mysql', process.env.ProgramFiles || 'C:\\Program Files']) {
    try {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root)) {
        const binDir = path.join(root, entry, 'bin');
        if (!fs.existsSync(binDir)) continue;
        const exe = fs.readdirSync(binDir).find(f => f.toLowerCase() === 'mysqldump.exe');
        if (exe) return path.join(binDir, exe);
      }
    } catch (e) {}
  }

  return null;
}

/**
 * Write a short-lived MySQL defaults file with the connection details.
 * Written as UTF-8 because mysqldump reads the file as raw bytes - that is what
 * makes a non-ASCII password survive intact.
 */
function writeCredentialsFile(profile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), CRED_DIR_PREFIX));
  const file = path.join(dir, 'my.cnf');
  // Inside a double-quoted option-file value MySQL treats "\" as an escape.
  const esc = (v) => String(v == null ? '' : v).split('\\').join('\\\\').split('"').join('\\"');
  const body = [
    '[client]',
    `host="${esc(profile.Host)}"`,
    `port=${parseInt(profile.Port, 10) || 3306}`,
    `user="${esc(profile.User)}"`,
    `password="${esc(profile.Password)}"`,
    '',
  ].join(String.fromCharCode(10));

  fs.writeFileSync(file, Buffer.from(body, 'utf8'), { mode: 0o600 });
  return file;
}

function removeCredentialsFile(file) {
  if (!file) return;
  try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch (e) {
    try { fs.unlinkSync(file); } catch (e2) {}
    try { fs.rmdirSync(path.dirname(file)); } catch (e2) {}
  }
}

function sweepStaleCredentialFiles() {
  let entries;
  try { entries = fs.readdirSync(os.tmpdir()); } catch (e) { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(CRED_DIR_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), entry);
    try {
      const contents = fs.readdirSync(dir);
      if (contents.length && !contents.every(f => f === 'my.cnf')) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (e) {}
  }
  return removed;
}

function testConnection(profile) {
  return new Promise((resolve) => {
    let driver;
    try { driver = require('mysql2/promise'); }
    catch (e) { return resolve({ success: false, message: 'mysql2 driver not installed' }); }

    driver.createConnection({
      host: profile.Host,
      port: parseInt(profile.Port, 10) || 3306,
      user: profile.User,
      password: profile.Password || '',
      connectTimeout: 10000,
    }).then(async (conn) => {
      try {
        const [rows] = await conn.query('SELECT VERSION() AS v');
        await conn.end();
        resolve({ success: true, message: 'Connected', version: rows[0] && rows[0].v });
      } catch (err) {
        try { await conn.end(); } catch (e) {}
        resolve({ success: false, message: err.message });
      }
    }).catch((err) => resolve({ success: false, message: err.message }));
  });
}

function listDatabases(profile) {
  return new Promise((resolve) => {
    let driver;
    try { driver = require('mysql2/promise'); }
    catch (e) { return resolve({ success: false, databases: [], message: 'mysql2 driver not installed' }); }

    driver.createConnection({
      host: profile.Host,
      port: parseInt(profile.Port, 10) || 3306,
      user: profile.User,
      password: profile.Password || '',
      connectTimeout: 10000,
    }).then(async (conn) => {
      try {
        const [rows] = await conn.query('SHOW DATABASES');
        await conn.end();
        const skip = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
        const databases = rows
          .map(r => Object.values(r)[0])
          .filter(name => !skip.has(String(name).toLowerCase()));
        resolve({ success: true, databases });
      } catch (err) {
        try { await conn.end(); } catch (e) {}
        resolve({ success: false, databases: [], message: err.message });
      }
    }).catch((err) => resolve({ success: false, databases: [], message: err.message }));
  });
}

function backup(profile, database, outPath, ctx = {}) {
  return new Promise((resolve) => {
    const tool = ctx.toolPath || findTool(ctx.config);
    if (!tool) {
      return resolve({ success: false, message: 'mysqldump not found. Install MySQL client tools or set the path in Settings.' });
    }

    const credFile = writeCredentialsFile(profile);
    // --defaults-file must come first, before every other option.
    const args = [`--defaults-file=${credFile}`];
    if (profile.ExtraArgs) args.push(...String(profile.ExtraArgs).split(/\s+/).filter(Boolean));
    if (database === '--all-databases') args.push('--all-databases');
    else args.push(database);
    args.push(`--result-file=${outPath}`);

    // execFile, not exec: no shell means no quoting to get wrong.
    execFile(tool, args, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      removeCredentialsFile(credFile);
      if (error) {
        const message = [stdout, stderr, error.message].filter(Boolean).join('\n').trim();
        return resolve({ success: false, message: message.substring(0, 2000), stdout: stdout || '', stderr: stderr || '' });
      }
      resolve({ success: true, message: 'Completed', stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

module.exports = {
  id: 'mysql',
  label: 'MySQL / MariaDB',
  defaultPort: 3306,
  dumpExtension: '.sql',
  toolName: 'mysqldump',
  backupTargetIsRemote: false,
  capabilities: { listDatabases: true, allDatabases: true, compression: true },
  findTool,
  testConnection,
  listDatabases,
  backup,
  // Exposed for the credential tests and for start-up cleanup.
  writeCredentialsFile,
  removeCredentialsFile,
  sweepStaleCredentialFiles,
};
