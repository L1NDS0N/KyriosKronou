// tests/test-sync-engines.js
//
// Engines move bytes; the planner decides which bytes. Each engine here is
// exercised against real storage where possible (local disk), and the registry
// contract is pinned so a future Google Drive engine cannot silently break it.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const engines = require('../src/main/sync/engines');
const local = require('../src/main/sync/engines/local');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-synceng-' + label + '-'));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('Sync engines: registry', () => {
  it('lists every engine with the fields the UI picker needs', () => {
    const list = engines.list();
    const ids = list.map(e => e.id);
    expect(ids).to.include.members(['local', 'smb', 'ftp', 'sftp']);
    for (const e of list) {
      expect(e.label).to.be.a('string').and.not.empty;
      expect(e).to.have.property('credentials');
    }
  });

  it('falls back to the local engine for unknown ids', () => {
    expect(engines.get('gdrive-que-nao-existe').id).to.equal('local');
    expect(engines.get(undefined).id).to.equal('local');
  });

  it('finds engines case-insensitively', () => {
    expect(engines.get('SFTP').id).to.equal('sftp');
  });

  it('knows which engines reconnect per file', () => {
    expect(engines.isRemotePerFile('ftp')).to.equal(true);
    expect(engines.isRemotePerFile('sftp')).to.equal(true);
    expect(engines.isRemotePerFile('local')).to.equal(false);
    expect(engines.isRemotePerFile('smb')).to.equal(false);
  });

  it('every engine exposes the same interface', () => {
    for (const e of engines.list()) {
      const engine = engines.get(e.id);
      expect(engine.testConnection, e.id).to.be.a('function');
      expect(engine.copyFile, e.id).to.be.a('function');
      expect(engine.deleteFile, e.id).to.be.a('function');
    }
  });
});

describe('Sync engines: local', () => {
  let src, dst;
  beforeEach(() => { src = tmpDir('src'); dst = tmpDir('dst'); });
  afterEach(() => {
    for (const d of [src, dst]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    }
  });

  it('testConnection creates the destination and probes writability', async () => {
    const dest = { path: path.join(dst, 'novo', 'profundo') };
    const r = await local.testConnection(dest);
    expect(r.success).to.equal(true);
    expect(fs.existsSync(dest.path)).to.equal(true);
    // No probe file may be left behind.
    expect(fs.readdirSync(dest.path)).to.deep.equal([]);
  });

  it('testConnection fails on an unwritable path', async () => {
    // A file where the engine wants a directory makes mkdir fail.
    const blocker = path.join(dst, 'bloqueio');
    fs.writeFileSync(blocker, '');
    const r = await local.testConnection({ path: path.join(blocker, 'sub') });
    expect(r.success).to.equal(false);
  });

  it('copyFile writes the file and preserves the source mtime', async () => {
    const sourceFile = write(src, 'pasta/arquivo.txt', 'dados');
    const old = new Date(Date.now() - 86400000); // yesterday
    fs.utimesSync(sourceFile, old, old);

    const r = await local.copyFile(sourceFile, { path: dst }, 'pasta/arquivo.txt');
    expect(r.success).to.equal(true);

    const target = path.join(dst, 'pasta', 'arquivo.txt');
    expect(fs.readFileSync(target, 'utf8')).to.equal('dados');
    // Incremental mode compares mtimes: a copy stamped "now" would look
    // changed forever.
    expect(fs.statSync(target).mtimeMs).to.be.closeTo(fs.statSync(sourceFile).mtimeMs, 5);
  });

  it('copyFile streams a larger file intact', async () => {
    // A few MB, above any naive single-write shortcut but fast to build.
    const big = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
    const sourceFile = path.join(src, 'grande.bin');
    fs.writeFileSync(sourceFile, big);

    const r = await local.copyFile(sourceFile, { path: dst }, 'grande.bin');
    expect(r.success).to.equal(true);
    expect(fs.readFileSync(path.join(dst, 'grande.bin')).equals(big)).to.equal(true);
  });

  it('deleteFile removes the file and tolerates a second delete', async () => {
    write(dst, 'temp.txt', 'x');
    expect((await local.deleteFile({ path: dst }, 'temp.txt')).success).to.equal(true);
    expect(fs.existsSync(path.join(dst, 'temp.txt'))).to.equal(false);
    // Mirroring twice in a row must not fail on the already-gone file.
    expect((await local.deleteFile({ path: dst }, 'temp.txt')).success).to.equal(true);
  });

  it('deleteFile reports failures other than "already gone"', async () => {
    // A directory in the file's place makes unlink fail with EPERM/EISDIR.
    fs.mkdirSync(path.join(dst, 'ocupado'));
    const r = await local.deleteFile({ path: dst }, 'ocupado');
    expect(r.success).to.equal(false);
    expect(r.message).to.be.a('string');
  });
});
