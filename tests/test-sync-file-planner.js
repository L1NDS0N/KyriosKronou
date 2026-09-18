// tests/test-sync-file-planner.js
//
// The plan is the brain of a sync: it decides what gets copied, what gets
// deleted, and what is left alone. If the plan is wrong, the engine faithfully
// does the wrong thing, so these tests pin down each decision with real files
// and real timestamps.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const planner = require('../src/main/sync/filePlanner');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-sync-' + label + '-'));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('Sync file planner: validation', () => {
  it('rejects a missing source directory', () => {
    const r = planner.plan({ sourceDir: 'C:/definitely/not/here', destDir: 'C:/tmp-x' });
    expect(r.ok).to.equal(false);
    expect(r.error).to.be.a('string');
  });

  it('requires a destination', () => {
    const src = tmpDir('src');
    const r = planner.plan({ sourceDir: src, destDir: '' });
    expect(r.ok).to.equal(false);
  });

  it('refuses to sync a folder into itself', () => {
    const src = tmpDir('src');
    const r = planner.plan({ sourceDir: src, destDir: path.join(src, 'nested') });
    expect(r.ok).to.equal(false);
    expect(r.error).to.include('destino');
  });
});

describe('Sync file planner: incremental vs full', () => {
  let src, dst;
  beforeEach(() => { src = tmpDir('src'); dst = tmpDir('dst'); });

  it('plans everything as new when the destination is empty', () => {
    write(src, 'a.txt', 'aaa');
    write(src, 'sub/b.txt', 'bbb');

    const r = planner.plan({ sourceDir: src, destDir: dst, mode: 'incremental' });
    expect(r.ok).to.equal(true);
    expect(r.copy.map(c => c.rel).sort()).to.deep.equal(['a.txt', 'sub/b.txt']);
    expect(r.copy.every(c => c.reason === 'new')).to.equal(true);
    expect(r.delete).to.deep.equal([]);
    expect(r.totalSource).to.equal(2);
  });

  it('skips unchanged files and flags new and changed ones', () => {
    const a = write(src, 'a.txt', 'aaa');
    write(src, 'b.txt', 'bbb-velho');
    write(src, 'c.txt', 'ccc');

    // Seed the destination as if a previous run had happened.
    const aDst = write(dst, 'a.txt', 'aaa');
    write(dst, 'b.txt', 'bbb-novo-no-destino');

    // Same size, but the source is a couple of seconds newer than the
    // tolerance window -> counts as changed.
    const then = Date.now() - 5000;
    fs.utimesSync(aDst, new Date(then), new Date(then));
    fs.utimesSync(a, new Date(), new Date());

    const r = planner.plan({ sourceDir: src, destDir: dst, mode: 'incremental' });
    expect(r.ok).to.equal(true);
    const byRel = new Map(r.copy.map(c => [c.rel, c]));
    expect(byRel.get('a.txt').reason).to.equal('changed');   // newer mtime
    expect(byRel.get('b.txt').reason).to.equal('changed');   // different size
    expect(byRel.get('c.txt').reason).to.equal('new');       // not on destination
    expect(r.skipped).to.equal(0);
  });

  it('skips nothing in full mode, even identical files', () => {
    write(src, 'a.txt', 'aaa');
    write(dst, 'a.txt', 'aaa');

    const r = planner.plan({ sourceDir: src, destDir: dst, mode: 'full' });
    expect(r.ok).to.equal(true);
    expect(r.copy).to.have.lengthOf(1);
    expect(r.copy[0].reason).to.equal('full');
    // Full mode does not even need the destination listing.
    expect(r.skipped).to.equal(0);
  });

  it('increments nothing when source and destination agree', () => {
    const a = write(src, 'a.txt', 'aaa');
    const aDst = write(dst, 'a.txt', 'aaa');
    // Stamp both with the exact same time, well inside the tolerance window.
    const when = new Date(Date.now() - 60000);
    fs.utimesSync(a, when, when);
    fs.utimesSync(aDst, when, when);

    const r = planner.plan({ sourceDir: src, destDir: dst, mode: 'incremental' });
    expect(r.ok).to.equal(true);
    expect(r.copy).to.deep.equal([]);
    expect(r.skipped).to.equal(1);
  });
});

describe('Sync file planner: excludes and mirror', () => {
  let src, dst;
  beforeEach(() => { src = tmpDir('src'); dst = tmpDir('dst'); });

  it('honours exclude patterns at any depth', () => {
    write(src, 'keep.txt', 'k');
    write(src, 'skip.log', 's');
    write(src, 'node_modules/pkg/index.js', 'n');
    write(src, 'deep/node_modules/x.js', 'd');

    const r = planner.plan({ sourceDir: src, destDir: dst, excludes: ['*.log', 'node_modules'] });
    expect(r.ok).to.equal(true);
    expect(r.copy.map(c => c.rel)).to.deep.equal(['keep.txt']);
  });

  it('excludes a single-depth pattern', () => {
    write(src, 'build/one.tmp', '1');
    write(src, 'build/nested/two.tmp', '2');

    const r = planner.plan({ sourceDir: src, destDir: dst, excludes: ['build/*.tmp'] });
    expect(r.copy.map(c => c.rel)).to.deep.equal(['build/nested/two.tmp']);
  });

  it('mirror lists destination files that vanished from the source', () => {
    write(src, 'a.txt', 'aaa');
    write(dst, 'a.txt', 'aaa');
    write(dst, 'gone.txt', 'was here once');
    write(dst, 'sub/gone-too.txt', 'x');

    const r = planner.plan({ sourceDir: src, destDir: dst, mirror: true });
    expect(r.ok).to.equal(true);
    expect(r.delete.sort()).to.deep.equal(['gone.txt', 'sub/gone-too.txt']);
  });

  it('mirror never deletes an excluded destination file', () => {
    write(src, 'a.txt', 'aaa');
    // Excluded from the source scan; if the destination has one, deleting it
    // would punish the user for a rule they asked for.
    write(dst, 'a.txt', 'aaa');
    write(dst, 'temp.log', 'log');

    const r = planner.plan({ sourceDir: src, destDir: dst, mirror: true, excludes: ['*.log'] });
    expect(r.delete).to.deep.equal([]);
  });

  it('mirror without deletions returns an empty list', () => {
    write(src, 'a.txt', 'aaa');
    write(dst, 'a.txt', 'aaa');
    const r = planner.plan({ sourceDir: src, destDir: dst, mirror: true });
    expect(r.delete).to.deep.equal([]);
  });
});

describe('Sync file planner: scanner', () => {
  it('walks nested directories and reports forward-slash paths', () => {
    const src = tmpDir('src');
    write(src, 'root.txt', 'r');
    write(src, 'level1/level2/deep.txt', 'd');

    const files = planner.scan(src);
    const rels = files.map(f => f.rel).sort();
    expect(rels).to.deep.equal(['level1/level2/deep.txt', 'root.txt']);
    expect(files.every(f => typeof f.size === 'number')).to.equal(true);
  });

  it('returns an empty list for a nonexistent directory', () => {
    expect(planner.scan('C:/definitely/not/here')).to.deep.equal([]);
  });

  it('skips symlinks so a link back up the tree cannot loop forever', function () {
    const src = tmpDir('src');
    write(src, 'real.txt', 'r');
    try {
      fs.symlinkSync(path.join(src, 'real.txt'), path.join(src, 'link.txt'), 'file');
    } catch (e) {
      // Creating symlinks on Windows needs admin or developer mode.
      this.skip();
    }
    const files = planner.scan(src);
    expect(files.map(f => f.rel)).to.deep.equal(['real.txt']);
  });
});

describe('Sync file planner: exclude pattern compilation', () => {
  const isExcluded = planner.isExcluded;

  it('a bare word matches the file or folder at any depth', () => {
    const re = planner.compileExclude('node_modules');
    expect(isExcluded('node_modules', [re])).to.equal(true);
    expect(isExcluded('node_modules/pkg/index.js', [re])).to.equal(true);
    expect(isExcluded('a/node_modules/b.js', [re])).to.equal(true);
    expect(isExcluded('mynode_modules', [re])).to.equal(false);
  });

  it('a wildcard is anchored to the file name at any depth', () => {
    const re = planner.compileExclude('*.log');
    expect(isExcluded('app.log', [re])).to.equal(true);
    expect(isExcluded('logs/app.log', [re])).to.equal(true);
    expect(isExcluded('app.log.bak', [re])).to.equal(false);
    expect(isExcluded('logger.txt', [re])).to.equal(false);
  });

  it('a pattern with a slash is relative to the source root', () => {
    const re = planner.compileExclude('build/*.tmp');
    expect(isExcluded('build/x.tmp', [re])).to.equal(true);
    expect(isExcluded('deep/build/x.tmp', [re])).to.equal(false);
  });

  it('empty or null patterns compile to nothing', () => {
    expect(planner.compileExclude('')).to.equal(null);
    expect(planner.compileExclude(null)).to.equal(null);
  });
});
