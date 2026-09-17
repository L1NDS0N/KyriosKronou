// tests/test-backup-credentials.js
//
// A non-ASCII password ("@eco.êçõgêstãõ1160") made every backup fail with
// "1045: Access denied" while the same password worked in the app's Test
// Connection button. Reason: Test Connection uses the mysql2 Node driver,
// which is UTF-8 clean, while the backup shelled out to mysqldump with
// --password on the command line. On Windows mysqldump converts command-line
// arguments and MYSQL_PWD through the process ANSI code page, mangling the
// UTF-8 bytes.
//
// Verified against MySQL 9.2 with a real user whose password contains accents:
//
//   --password= on the command line ... 1045 Access denied
//   MYSQL_PWD env var ................. 1045 Access denied
//   defaults file written as latin1 ... 1045 Access denied
//   defaults file written as UTF-8 .... works
//
// So credentials must travel through a UTF-8 defaults file, which also keeps
// the password out of the process list.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BackupManager = require('../src/main/backupManager');
const Logger = require('../src/main/logger');

const ACCENTED = '@eco.êçõgêstãõ1160';
const SOURCE = path.join(__dirname, '..', 'src', 'main', 'backupManager.js');

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-cred-test-'));
  const logger = new Logger(path.join(dir, 'logs'));
  const config = { configDir: dir, getSetting: (k, d) => d };
  return new BackupManager(config, logger);
}

describe('Backup credentials: non-ASCII passwords', () => {
  let bm;
  before(() => { bm = makeManager(); });

  it('writes the password as UTF-8 bytes, not ANSI', () => {
    const file = bm._writeCredentialsFile({ Host: 'localhost', Port: 3306, User: 'eco', Password: ACCENTED });
    try {
      const raw = fs.readFileSync(file);
      // Latin-1 would store "e-circumflex" as the single byte 0xEA; UTF-8 uses
      // 0xC3 0xAA. Asserting the multi-byte form is what pins the encoding.
      expect(raw.includes(Buffer.from('ê', 'utf8'))).to.equal(true);
      expect(raw.toString('utf8')).to.include(ACCENTED);
      expect(raw.toString('latin1')).to.not.include(ACCENTED);
    } finally { bm._removeCredentialsFile(file); }
  });

  it('writes a [client] section mysqldump will read', () => {
    const file = bm._writeCredentialsFile({ Host: 'db.example.com', Port: 3307, User: 'eco', Password: ACCENTED });
    try {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).to.match(/^\[client\]/);
      expect(text).to.include('host="db.example.com"');
      expect(text).to.include('port=3307');
      expect(text).to.include('user="eco"');
      expect(text).to.include('password="' + ACCENTED + '"');
    } finally { bm._removeCredentialsFile(file); }
  });

  it('escapes backslashes and quotes, which MySQL treats as escapes', () => {
    const nasty = 'pa\\ss"word';
    const file = bm._writeCredentialsFile({ Host: 'h', Port: 3306, User: 'u', Password: nasty });
    try {
      expect(fs.readFileSync(file, 'utf8')).to.include('password="pa\\\\ss\\"word"');
    } finally { bm._removeCredentialsFile(file); }
  });

  it('defaults to port 3306 when the profile has none', () => {
    const file = bm._writeCredentialsFile({ Host: 'h', User: 'u', Password: 'p' });
    try {
      expect(fs.readFileSync(file, 'utf8')).to.include('port=3306');
    } finally { bm._removeCredentialsFile(file); }
  });

  it('handles an empty password without producing a broken file', () => {
    const file = bm._writeCredentialsFile({ Host: 'h', Port: 3306, User: 'u', Password: '' });
    try {
      expect(fs.readFileSync(file, 'utf8')).to.include('password=""');
    } finally { bm._removeCredentialsFile(file); }
  });

  it('gives each run its own file, so concurrent backups cannot collide', () => {
    const profile = { Host: 'h', Port: 3306, User: 'u', Password: ACCENTED };
    const a = bm._writeCredentialsFile(profile);
    const b = bm._writeCredentialsFile(profile);
    try {
      expect(a).to.not.equal(b);
      expect(fs.existsSync(a)).to.equal(true);
      expect(fs.existsSync(b)).to.equal(true);
    } finally { bm._removeCredentialsFile(a); bm._removeCredentialsFile(b); }
  });

  it('removes the file and its directory afterwards - no credentials left on disk', () => {
    const file = bm._writeCredentialsFile({ Host: 'h', Port: 3306, User: 'u', Password: ACCENTED });
    const dir = path.dirname(file);
    expect(fs.existsSync(file)).to.equal(true);
    bm._removeCredentialsFile(file);
    expect(fs.existsSync(file)).to.equal(false);
    expect(fs.existsSync(dir)).to.equal(false);
  });

  it('tolerates being asked to clean up twice, or with nothing', () => {
    const file = bm._writeCredentialsFile({ Host: 'h', Port: 3306, User: 'u', Password: 'p' });
    bm._removeCredentialsFile(file);
    expect(() => bm._removeCredentialsFile(file)).to.not.throw();
    expect(() => bm._removeCredentialsFile(null)).to.not.throw();
  });
});

describe('Backup credentials: the password never reaches a command line', () => {
  it('no code path builds a --password argument for mysqldump', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    const offending = src.split('\n').filter((line) => {
      if (!line.includes('--password')) return false;
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith("'        #") && !t.startsWith("'    #");
    });
    expect(offending, 'these lines still build a --password argument:\n' + offending.join('\n'))
      .to.deep.equal([]);
  });

  it('the dump runs through execFile, so no shell can mangle the arguments', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    expect(src).to.include('execFile(this.mysqldumpPath');
  });

  it('the generated NSSM wrapper also uses a UTF-8 defaults file', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');
    expect(src).to.include('--defaults-file=');
    expect(src).to.include('UTF8Encoding');
    // And it must clean the file up rather than leaving credentials in TEMP.
    expect(src).to.include('Remove-Item $credFile');
  });
});

describe('Backup credentials: stranded files are swept', () => {
  const os2 = require('os');

  it('removes a credentials directory left behind by a killed backup', () => {
    const bm = makeManager();
    // Simulate a run that died before it could clean up.
    const orphan = bm._writeCredentialsFile({ Host: 'h', Port: 3306, User: 'u', Password: ACCENTED });
    expect(fs.existsSync(orphan)).to.equal(true);

    bm._sweepStaleCredentialFiles();
    expect(fs.existsSync(orphan)).to.equal(false, 'a password must not survive on disk');
  });

  it('leaves unrelated temp directories alone', () => {
    const bm = makeManager();
    const unrelated = fs.mkdtempSync(path.join(os2.tmpdir(), 'something-else-'));
    fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'important');
    try {
      bm._sweepStaleCredentialFiles();
      expect(fs.existsSync(unrelated)).to.equal(true);
    } finally { fs.rmSync(unrelated, { recursive: true, force: true }); }
  });

  it('sweeps on construction, so a restart cleans up after a crash', () => {
    const first = makeManager();
    const orphan = first._writeCredentialsFile({ Host: 'h', Port: 3306, User: 'u', Password: 'p' });
    expect(fs.existsSync(orphan)).to.equal(true);

    makeManager(); // a fresh BackupManager, as on app or service start
    expect(fs.existsSync(orphan)).to.equal(false);
  });
});
