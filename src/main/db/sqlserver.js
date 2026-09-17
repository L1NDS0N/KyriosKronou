// db/sqlserver.js - Microsoft SQL Server engine.
//
// Connection work goes through the tedious-based `mssql` driver rather than
// sqlcmd: sqlcmd is not installed everywhere, and like mysqldump it converts a
// command-line password through the ANSI code page, so a non-ASCII password
// would be rejected. A pure-JS driver is UTF-8 clean.
//
// Two backup formats, because they are genuinely different tools:
//
//   .bak     Native backup. T-SQL BACKUP DATABASE runs INSIDE SQL Server, so
//            the file is written on the database host by the service account -
//            not streamed here. Fast and complete, but a .bak can only be
//            restored on the same major version or newer.
//
//   .bacpac  Portable export via SqlPackage.exe. Pulled client-side, so the
//            file lands on THIS machine. Smaller and restorable across
//            versions, but it carries schema and data only - no logins, jobs,
//            or file layout - and needs SqlPackage.exe installed.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const FORMAT_BAK = 'bak';
const FORMAT_BACPAC = 'bacpac';

const FORMATS = [
  {
    id: FORMAT_BAK,
    label: 'Backup nativo (.bak)',
    extension: '.bak',
    writtenOnServer: true,
    requiresTool: false,
    description: 'Rápido e completo. O arquivo é gravado pelo SQL Server, no host do banco. Só restaura em versão igual ou mais nova.',
  },
  {
    id: FORMAT_BACPAC,
    label: 'Portável (.bacpac)',
    extension: '.bacpac',
    writtenOnServer: false,
    requiresTool: true,
    description: 'Menor e restaura entre versões diferentes. Baixado para esta máquina. Contém apenas esquema e dados — sem logins, jobs ou arquivos físicos. Requer o SqlPackage.exe.',
  },
];

function formatFor(profile) {
  const wanted = String((profile && profile.BackupFormat) || FORMAT_BAK).toLowerCase();
  return FORMATS.find(f => f.id === wanted) || FORMATS[0];
}

function loadDriver() {
  try { return require('mssql'); }
  catch (e) { return null; }
}

// ─── SqlPackage discovery (only needed for .bacpac) ───
function findTool() {
  const roots = [
    process.env.ProgramFiles || 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  ];

  const direct = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'SqlPackage', 'SqlPackage.exe'),
    path.join(process.env.USERPROFILE || '', '.dotnet', 'tools', 'SqlPackage.exe'),
  ];
  for (const p of direct) {
    if (p && fs.existsSync(p)) return p;
  }

  // Versioned install roots: .../Microsoft SQL Server/<ver>/DAC/bin/SqlPackage.exe
  for (const root of roots) {
    for (const branch of [
      ['Microsoft SQL Server'],
      ['Microsoft SQL Server Management Studio 20', 'Common7', 'IDE', 'Extensions', 'Microsoft', 'SQLDB', 'DAC'],
      ['Microsoft SQL Server Management Studio 19', 'Common7', 'IDE', 'Extensions', 'Microsoft', 'SQLDB', 'DAC'],
      ['Microsoft SQL Server Management Studio 18', 'Common7', 'IDE', 'Extensions', 'Microsoft', 'SQLDB', 'DAC'],
    ]) {
      const base = path.join(root, ...branch);
      const found = scanForSqlPackage(base, 3);
      if (found) return found;
    }
  }

  return null;
}

/** Look for SqlPackage.exe a few levels down, since the version folder varies. */
function scanForSqlPackage(dir, depth) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === 'sqlpackage.exe') {
      return path.join(dir, entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = scanForSqlPackage(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

function connectionConfig(profile, database) {
  return {
    server: profile.Host || 'localhost',
    port: parseInt(profile.Port, 10) || 1433,
    user: profile.User,
    password: profile.Password || '',
    database: database || 'master',
    connectionTimeout: 15000,
    requestTimeout: 900000,
    options: {
      // On-prem servers almost always use a self-signed certificate; refusing
      // it would make the product unusable against a typical install.
      trustServerCertificate: true,
      encrypt: profile.Encrypt !== false,
      enableArithAbort: true,
    },
    pool: { max: 2, min: 0, idleTimeoutMillis: 5000 },
  };
}

async function withConnection(profile, database, fn) {
  const sql = loadDriver();
  if (!sql) return { success: false, message: 'mssql driver not installed. Run: npm install mssql' };

  let pool;
  try {
    pool = await new sql.ConnectionPool(connectionConfig(profile, database)).connect();
    return await fn(pool, sql);
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    if (pool) { try { await pool.close(); } catch (e) {} }
  }
}

async function testConnection(profile) {
  return withConnection(profile, 'master', async (pool) => {
    const result = await pool.request().query('SELECT @@VERSION AS v');
    const version = (result.recordset[0] && result.recordset[0].v) || '';
    return { success: true, message: 'Connected', version: version.split('\n')[0].trim() };
  });
}

async function listDatabases(profile) {
  const result = await withConnection(profile, 'master', async (pool) => {
    const query = await pool.request().query(
      // database_id > 4 skips master/tempdb/model/msdb; state 0 is ONLINE.
      'SELECT name FROM sys.databases WHERE database_id > 4 AND state = 0 ORDER BY name'
    );
    return { success: true, databases: query.recordset.map(r => r.name) };
  });
  return result.success ? result : { success: false, databases: [], message: result.message };
}

// ─── .bak: server-side native backup ───
async function backupNative(profile, database, outPath) {
  const sql = loadDriver();
  if (!sql) return { success: false, message: 'mssql driver not installed. Run: npm install mssql' };

  // An object name cannot be parameterised, so it is quoted the way T-SQL
  // requires (a closing bracket is doubled); the path IS a bound parameter.
  const safeName = String(database).replace(/]/g, ']]');

  const result = await withConnection(profile, 'master', async (pool) => {
    const request = pool.request();
    request.input('path', sql.NVarChar, outPath);
    await request.query(
      `BACKUP DATABASE [${safeName}] TO DISK = @path WITH INIT, FORMAT, SKIP, NOREWIND, NOUNLOAD, COMPRESSION, STATS = 10`
    );
    return { success: true };
  });

  if (!result.success) {
    return { success: false, message: result.message, stdout: '', stderr: result.message };
  }

  // The file lives on the database host. When that is this machine we can see
  // it; when it is remote we cannot, and saying so beats implying otherwise.
  if (!fs.existsSync(outPath)) {
    const note = `SQL Server gravou o backup em ${outPath} no host "${profile.Host}". Esse caminho é do servidor e não está acessível a partir desta máquina, então compactação e upload foram ignorados.`;
    return { success: true, message: note, stdout: note, stderr: '', remoteOnly: true };
  }
  return { success: true, message: 'Completed', stdout: '', stderr: '' };
}

// ─── .bacpac: client-side portable export ───
async function backupBacpac(profile, database, outPath, ctx = {}) {
  const tool = ctx.toolPath || findTool();
  if (!tool) {
    return {
      success: false,
      message: 'SqlPackage.exe não encontrado. Instale o SqlPackage (dotnet tool install -g microsoft.sqlpackage) ou escolha o formato .bak.',
    };
  }

  // SqlPackage overwrites nothing: an existing target file makes it fail.
  try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}

  const args = [
    '/Action:Export',
    `/SourceServerName:${profile.Host},${parseInt(profile.Port, 10) || 1433}`,
    `/SourceDatabaseName:${database}`,
    `/SourceUser:${profile.User}`,
    `/SourcePassword:${profile.Password || ''}`,
    `/TargetFile:${outPath}`,
    '/SourceTrustServerCertificate:True',
    '/Quiet:True',
  ];
  if (profile.Encrypt === false) args.push('/SourceEncryptConnection:False');

  return new Promise((resolve) => {
    execFile(tool, args, { timeout: 3600000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = [stdout, stderr, error.message].filter(Boolean).join('\n').trim();
        return resolve({ success: false, message: message.substring(0, 2000), stdout: stdout || '', stderr: stderr || '' });
      }
      if (!fs.existsSync(outPath)) {
        return resolve({ success: false, message: 'SqlPackage terminou sem erro, mas o arquivo não foi criado.', stdout: stdout || '', stderr: stderr || '' });
      }
      resolve({ success: true, message: 'Completed', stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function backup(profile, database, outPath, ctx = {}) {
  if (database === '--all-databases') {
    return { success: false, message: 'SQL Server faz backup de um banco por vez. Selecione os bancos explicitamente.' };
  }
  const format = formatFor(profile);
  return format.id === FORMAT_BACPAC
    ? backupBacpac(profile, database, outPath, ctx)
    : backupNative(profile, database, outPath);
}

module.exports = {
  id: 'sqlserver',
  label: 'Microsoft SQL Server',
  defaultPort: 1433,
  // Default extension; the profile's chosen format wins (see extensionFor).
  dumpExtension: '.bak',
  toolName: 'SqlPackage.exe',
  formats: FORMATS,
  /** Only the native format is written by the server. */
  backupTargetIsRemote: (profile) => formatFor(profile).writtenOnServer,
  extensionFor: (profile) => formatFor(profile).extension,
  formatFor,
  capabilities: { listDatabases: true, allDatabases: false, compression: true, formats: true },
  findTool,
  testConnection,
  listDatabases,
  backup,
};
