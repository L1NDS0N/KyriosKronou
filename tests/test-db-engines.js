// tests/test-db-engines.js
//
// Backups used to assume MySQL everywhere. Each engine now sits behind one
// small interface so a new database is a new module, not an if/else through
// the BackupManager. These tests pin the contract every engine must honour and
// the behaviour that differs between them.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const engines = require('../src/main/db');
const mysql = require('../src/main/db/mysql');
const sqlserver = require('../src/main/db/sqlserver');

describe('Database engines: the registry', () => {
  it('offers MySQL and SQL Server', () => {
    const ids = engines.list().map(e => e.id);
    expect(ids).to.include('mysql');
    expect(ids).to.include('sqlserver');
  });

  it('every engine honours the same interface', () => {
    for (const engine of engines.ENGINES) {
      expect(engine.id, 'id').to.be.a('string');
      expect(engine.label, `${engine.id}.label`).to.be.a('string');
      expect(engine.defaultPort, `${engine.id}.defaultPort`).to.be.a('number');
      expect(engine.dumpExtension, `${engine.id}.dumpExtension`).to.match(/^\./);
      expect(engine.capabilities, `${engine.id}.capabilities`).to.be.an('object');
      for (const method of ['findTool', 'testConnection', 'listDatabases', 'backup']) {
        expect(engine[method], `${engine.id}.${method}`).to.be.a('function');
      }
    }
  });

  it('resolves an engine by id, case-insensitively', () => {
    expect(engines.get('mysql').id).to.equal('mysql');
    expect(engines.get('SQLSERVER').id).to.equal('sqlserver');
  });

  it('falls back to MySQL for an unknown id rather than throwing', () => {
    expect(engines.get('oracle').id).to.equal('mysql');
    expect(engines.has('oracle')).to.equal(false);
  });

  // Profiles created before multi-engine support have no Engine field.
  it('treats a profile with no engine as MySQL, so old profiles keep working', () => {
    expect(engines.forProfile({}).id).to.equal('mysql');
    expect(engines.forProfile({ Name: 'Legacy', Host: 'localhost' }).id).to.equal('mysql');
    expect(engines.extensionFor({}).toLowerCase()).to.equal('.sql');
  });

  it('picks the file extension from the engine', () => {
    expect(engines.extensionFor({ Engine: 'mysql' })).to.equal('.sql');
    expect(engines.extensionFor({ Engine: 'sqlserver' })).to.equal('.bak');
  });
});

describe('Database engines: SQL Server output formats', () => {
  it('offers a native and a portable format', () => {
    const ids = sqlserver.formats.map(f => f.id);
    expect(ids).to.deep.equal(['bak', 'bacpac']);
  });

  it('uses .bak by default', () => {
    expect(engines.extensionFor({ Engine: 'sqlserver' })).to.equal('.bak');
    expect(sqlserver.formatFor({}).id).to.equal('bak');
  });

  it('switches the extension to .bacpac when that format is chosen', () => {
    expect(engines.extensionFor({ Engine: 'sqlserver', BackupFormat: 'bacpac' })).to.equal('.bacpac');
  });

  // This is the difference that actually bites: a native backup is written by
  // SQL Server on the database host, so the path is not a local one.
  it('knows a native backup is written on the server, and a bacpac here', () => {
    expect(engines.writesOnServer({ Engine: 'sqlserver', BackupFormat: 'bak' })).to.equal(true);
    expect(engines.writesOnServer({ Engine: 'sqlserver', BackupFormat: 'bacpac' })).to.equal(false);
    expect(engines.writesOnServer({ Engine: 'mysql' })).to.equal(false);
  });

  it('marks only the portable format as needing an external tool', () => {
    const bak = sqlserver.formats.find(f => f.id === 'bak');
    const bacpac = sqlserver.formats.find(f => f.id === 'bacpac');
    expect(bak.requiresTool).to.equal(false);
    expect(bacpac.requiresTool).to.equal(true);
  });

  it('falls back to the native format for an unknown value', () => {
    expect(sqlserver.formatFor({ BackupFormat: 'nonsense' }).id).to.equal('bak');
  });

  it('refuses --all-databases, which SQL Server has no equivalent for', async () => {
    const result = await sqlserver.backup({ Host: 'localhost' }, '--all-databases', 'C:\\x.bak');
    expect(result.success).to.equal(false);
    expect(result.message).to.match(/um banco por vez/i);
  });

  it('says plainly when SqlPackage is missing instead of failing obscurely', async function () {
    if (sqlserver.findTool()) return this.skip(); // installed here, nothing to assert
    const result = await sqlserver.backup(
      { Host: 'localhost', User: 'sa', Password: 'x', BackupFormat: 'bacpac' },
      'MyDb', path.join(os.tmpdir(), 'x.bacpac')
    );
    expect(result.success).to.equal(false);
    expect(result.message).to.include('SqlPackage');
  });

  it('never puts the password on a command line for connection work', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'db', 'sqlserver.js'), 'utf8');
    // sqlcmd would convert it through the ANSI code page, exactly as mysqldump
    // did; the JS driver is UTF-8 clean.
    const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    expect(code).to.not.include('sqlcmd');
  });

  it('quotes the database identifier so a name with a bracket cannot break out', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'db', 'sqlserver.js'), 'utf8');
    expect(src).to.include("replace(/]/g, ']]')");
    // And the path is a bound parameter, not string-concatenated.
    expect(src).to.include("request.input('path'");
  });
});

describe('Database engines: MySQL', () => {
  it('reports itself as a client-side dump', () => {
    expect(mysql.backupTargetIsRemote).to.equal(false);
    expect(mysql.capabilities.allDatabases).to.equal(true);
  });

  it('locates mysqldump on this machine, or says it cannot', () => {
    const tool = mysql.findTool({ getSetting: (k, d) => d });
    if (tool) expect(fs.existsSync(tool)).to.equal(true);
    else expect(tool).to.equal(null);
  });

  it('honours a configured mysqldump path over the search', () => {
    const fake = path.join(os.tmpdir(), 'fake-mysqldump-' + Date.now() + '.exe');
    fs.writeFileSync(fake, '');
    try {
      const found = mysql.findTool({ getSetting: (k, d) => (k === 'MysqldumpPath' ? fake : d) });
      expect(found).to.equal(fake);
    } finally { fs.unlinkSync(fake); }
  });

  it('reports a missing tool rather than throwing', async () => {
    const result = await mysql.backup(
      { Host: 'localhost', User: 'u', Password: 'p' }, 'db',
      path.join(os.tmpdir(), 'out.sql'),
      { toolPath: null, config: { getSetting: () => path.join(os.tmpdir(), 'does-not-exist.exe') } }
    );
    // Either it found a real mysqldump on this machine and failed to connect,
    // or it reported the missing tool. Both are graceful.
    expect(result.success).to.equal(false);
    expect(result.message).to.be.a('string').with.length.above(0);
  });
});

describe('Database engines: live MySQL backup', function () {
  this.timeout(60000);

  const BIN = path.join('C:', 'tools', 'mysql', 'current', 'bin');
  const tool = path.join(BIN, 'mysqldump.exe');

  it('produces a dump through the engine interface', async function () {
    if (!fs.existsSync(tool)) return this.skip();

    // Reuse whatever local credentials the machine already has configured.
    let rootProfile;
    try {
      const profiles = JSON.parse(fs.readFileSync('C:/ProgramData/KyriosChronos/config/backup-profiles.json', 'utf8'));
      rootProfile = profiles.find(p => p.User === 'root');
    } catch (e) { /* no local config */ }
    if (!rootProfile) return this.skip();

    const probe = await mysql.testConnection(rootProfile);
    if (!probe.success) return this.skip();

    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-dump-')), 'out.sql');
    const result = await mysql.backup(
      Object.assign({}, rootProfile, { ExtraArgs: '--no-data' }),
      'mysql', out, { toolPath: tool }
    );

    expect(result.success, result.message).to.equal(true);
    expect(fs.existsSync(out)).to.equal(true);
    expect(fs.statSync(out).size).to.be.above(0);
  });

  it('lists databases through the engine interface', async function () {
    let rootProfile;
    try {
      const profiles = JSON.parse(fs.readFileSync('C:/ProgramData/KyriosChronos/config/backup-profiles.json', 'utf8'));
      rootProfile = profiles.find(p => p.User === 'root');
    } catch (e) {}
    if (!rootProfile) return this.skip();

    const probe = await mysql.testConnection(rootProfile);
    if (!probe.success) return this.skip();

    const result = await mysql.listDatabases(rootProfile);
    expect(result.success).to.equal(true);
    expect(result.databases).to.be.an('array');
    // System schemas are noise in a backup picker.
    expect(result.databases.map(d => d.toLowerCase())).to.not.include('information_schema');
  });
});
