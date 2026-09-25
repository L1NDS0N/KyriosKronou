// tests/test-sync-retention.js
//
// Retention is the part of sync that DELETES, so it gets the strictest tests:
// pure functions over injected clocks, boundary days, MinKeep overrides and
// the folder-pattern analyzer that powers the wizard's suggestion.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const retention = require('../src/main/sync/retention');

const DAY = retention.DAY_MS;

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-reten-' + label + '-'));
}

function writeAged(dir, rel, ageDays, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content || 'x');
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(full, t, t);
  return full;
}

// ─── Date parsing from names ───
describe('retention: parseDateFromName', () => {
  const cases = [
    ['2026-09-22.zip', new Date(Date.UTC(2026, 8, 22))],
    ['backup-20260922.tar', new Date(Date.UTC(2026, 8, 22))],
    ['22-09-2026.log', new Date(Date.UTC(2026, 8, 22))],
    ['dump_22_09_2026.sql', new Date(Date.UTC(2026, 8, 22))],
    ['snap.22.09.2026.7z', new Date(Date.UTC(2026, 8, 22))],
    ['sem-data.txt', null],
    ['arquivo123.zip', null],
    ['2026-13-45.bin', null],   // month/day impossible
    ['30-02-2026.zip', null],   // calendar rejects
    ['2099-01-01.zip', null],   // future: a version number, not a date
  ];
  for (const [name, expected] of cases) {
    it(`${name} -> ${expected ? expected.toISOString().slice(0, 10) : 'null'}`, () => {
      const got = retention.parseDateFromName(name);
      if (!expected) expect(got).to.equal(null);
      else expect(got.toISOString().slice(0, 10)).to.equal(expected.toISOString().slice(0, 10));
    });
  }
});

// ─── Folder pattern analysis ───
describe('retention: analyze', () => {
  let dir;
  beforeEach(() => { dir = tmpDir('an'); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

  it('detects dated snapshot folders and suggests age+count', () => {
    // 10 daily folders, each with one file inside.
    for (let i = 0; i < 10; i++) {
      const d = new Date(Date.now() - i * DAY);
      const iso = d.toISOString().slice(0, 10);
      writeAged(dir, `${iso}/dump.sql`, i, 'snap');
    }
    const a = retention.analyze(dir);
    expect(a.ok).to.equal(true);
    expect(a.folderPattern).to.equal('dated-folders');
    expect(a.withDates).to.equal(10);
    expect(a.medianGapDays).to.equal(1);
    expect(a.suggested.Enabled).to.equal(true);
    expect(a.suggested.ByAge).to.equal(true);
    expect(a.suggested.KeepDays).to.be.at.least(7);
    expect(a.suggested.ByCount).to.equal(true);
  });

  it('detects dated file names on a flat folder', () => {
    for (let i = 0; i < 8; i++) {
      const d = new Date(Date.now() - i * 7 * DAY); // weekly
      const [y, m, dd] = d.toISOString().slice(0, 10).split('-');
      writeAged(dir, `backup-${y}${m}${dd}.zip`, i * 7);
    }
    const a = retention.analyze(dir);
    expect(a.folderPattern).to.equal('dated-files');
    expect(a.medianGapDays).to.equal(7);
    expect(a.suggested.ByAge).to.equal(true);
  });

  it('classifies flat content and suggests only a size cap', () => {
    writeAged(dir, 'dados/a.bin', 1);
    writeAged(dir, 'dados/b.bin', 40);
    writeAged(dir, 'dados/c.bin', 90);
    const a = retention.analyze(dir);
    expect(a.folderPattern).to.equal('flat');
    expect(a.suggested.Enabled).to.equal(true);
    expect(a.suggested.ByAge).to.equal(false);
    expect(a.suggested.BySize).to.equal(true);
  });

  it('handles an empty or missing folder without crashing', () => {
    const a = retention.analyze(dir);
    expect(a.ok).to.equal(true);
    expect(a.totalFiles).to.equal(0);
    const missing = retention.analyze(path.join(dir, 'nao-existe'));
    expect(missing.ok).to.equal(true);
    expect(missing.totalFiles).to.equal(0);
  });
});

// ─── Policy compilation ───
describe('retention: compile', () => {
  it('disabled policy produces no rules', () => {
    const c = retention.compile({ Enabled: false, ByAge: true, KeepDays: 7 });
    expect(c.ok).to.equal(true);
    expect(c.rules).to.deep.equal([]);
  });

  it('active policy with no criterion is rejected', () => {
    const c = retention.compile({ Enabled: true });
    expect(c.ok).to.equal(false);
    expect(c.error).to.be.a('string');
  });

  it('collects the enabled criteria and defaults MinKeep to 0', () => {
    const c = retention.compile({ Enabled: true, ByAge: true, KeepDays: 30, BySize: true, FreeGb: 5 });
    expect(c.ok).to.equal(true);
    expect(c.rules.map(r => r.type)).to.deep.equal(['age', 'size']);
    expect(c.minKeep).to.equal(0);
  });
});

// ─── Deletion planning (pure, injected clock) ───
describe('retention: planDeletion', () => {
  const NOW = Date.UTC(2026, 8, 22, 12, 0, 0); // fixed clock: 2026-09-22 12:00 UTC
  const file = (rel, ageDays, size) => ({ rel, size: size || 100, mtimeMs: NOW - ageDays * DAY });

  it('deletes by age, keeping what is on the boundary', () => {
    const files = [file('hoje.zip', 1), file('limite.zip', 30), file('velho.zip', 31), file('antiquissimo.zip', 365)];
    const c = retention.compile({ Enabled: true, ByAge: true, KeepDays: 30 });
    const p = retention.planDeletion(files, c, { now: NOW });
    const rels = p.delete.map(x => x.rel).sort();
    expect(rels).to.deep.equal(['antiquissimo.zip', 'velho.zip']);
    expect(p.delete.every(x => x.reason === 'age')).to.equal(true);
  });

  it('deletes by count per top-level folder, newest survive', () => {
    const files = [
      file('snap-01/a.zip', 10), file('snap-02/a.zip', 9), file('snap-03/a.zip', 8),
      file('snap-04/a.zip', 7), file('snap-05/a.zip', 6),
      file('outro/b.zip', 1),
    ];
    const c = retention.compile({ Enabled: true, ByCount: true, KeepCount: 4 });
    const p = retention.planDeletion(files, c, { now: NOW });
    // Units: 5 snapshot folders + 1 root file. Keeping the 4 newest units
    // (outro + snap-05..02); the two oldest snapshot folders go whole.
    const rels = p.delete.map(x => x.rel).sort();
    expect(rels).to.deep.equal(['snap-01/a.zip', 'snap-02/a.zip']);
    expect(p.delete.every(x => x.reason === 'count')).to.equal(true);
  });

  it('deletes by size oldest-first until the free target is met', () => {
    const files = [
      file('a.bin', 100, 5 * 1024 * 1024 * 1024), // 5 GB, oldest
      file('b.bin', 50, 4 * 1024 * 1024 * 1024),  // 4 GB
      file('c.bin', 1, 2 * 1024 * 1024 * 1024),   // 2 GB
    ];
    // Total 11 GB; target: 8 GB free -> must free 3 GB -> only a.bin goes.
    const c = retention.compile({ Enabled: true, BySize: true, FreeGb: 8, FileExtensions: ['.bin'] });
    const p = retention.planDeletion(files, c, { now: NOW });
    expect(p.delete.map(x => x.rel)).to.deep.equal(['a.bin']);
  });

  it('MinKeep protects the newest files from every rule', () => {
    const files = [file('a.zip', 100), file('b.zip', 90), file('c.zip', 80), file('d.zip', 1)];
    // Newest-first: d, c, b, a. MinKeep=2 shields d and c; by age a, b
    // and c were doomed, so only a and b actually go.
    const c = retention.compile({ Enabled: true, ByAge: true, KeepDays: 10, MinKeep: 2 });
    const p = retention.planDeletion(files, c, { now: NOW });
    expect(p.delete.map(x => x.rel).sort()).to.deep.equal(['a.zip', 'b.zip']);
  });

  it('combines rules without deleting the same file twice', () => {
    const files = [file('a.zip', 100), file('b.zip', 90), file('c.zip', 1)];
    // By age: a, b. By count (keep 1): a, b (whole-file units at root).
    const c = retention.compile({ Enabled: true, ByAge: true, KeepDays: 30, ByCount: true, KeepCount: 1 });
    const p = retention.planDeletion(files, c, { now: NOW });
    const rels = p.delete.map(x => x.rel);
    expect(new Set(rels).size).to.equal(rels.length);
    expect(rels.sort()).to.deep.equal(['a.zip', 'b.zip']);
  });

  it('an invalid compiled policy deletes nothing and reports why', () => {
    const p = retention.planDeletion([file('a.zip', 100)], { ok: false, rules: [], error: 'x' }, { now: NOW });
    expect(p.ok).to.equal(false);
    expect(p.delete).to.deep.equal([]);
  });

  it('empty file list is a no-op success', () => {
    const c = retention.compile({ Enabled: true, ByAge: true, KeepDays: 1 });
    expect(retention.planDeletion([], c, { now: NOW }).delete).to.deep.equal([]);
  });
});

// ─── Metadata-based analysis (toggle useMetadata) ───
describe('retention: analyze with metadata dates', () => {
  it('counts files dated only by mtime when useMetadata is on', () => {
    const dir = tmpDir('meta');
    // No dates in any name; ages live in the mtimes.
    writeAged(dir, 'dump.sql', 2);
    writeAged(dir, 'dump-old.sql', 40);
    writeAged(dir, 'ancient.log', 200);

    const off = retention.analyze(dir, { useMetadata: false });
    expect(off.withDates).to.equal(0);
    expect(off.folderPattern).to.equal('flat');

    const on = retention.analyze(dir, { useMetadata: true });
    expect(on.withDates).to.equal(3);
    expect(on.fromMetadata).to.equal(3);
    // 200d vs 2d gaps -> median gap well above daily; still "dated".
    expect(on.folderPattern).to.equal('dated-files');
    expect(on.suggested.Enabled).to.equal(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names win over metadata per file when both are enabled', () => {
    const dir = tmpDir('both');
    // Name says 2020-01-01 but the mtime is fresh (a restored file).
    const full = writeAged(dir, '2020-01-01/dump.sql', 1);
    const r = retention.analyze(dir, { useNames: true, useMetadata: true });
    expect(r.withDates).to.equal(1);
    expect(r.fromMetadata).to.equal(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─── Monthly rule (keep rule) ───
describe('retention: monthly rule in planDeletion', () => {
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const compiled = retention.compile({ Enabled: true, DateSource: 'names', ByMonthly: true, MonthlyKeepMonths: 12, MinKeep: 0, FileExtensions: [] });

  function f(rel, mtimeMs) { return { rel, size: 10, mtimeMs }; }

  it('alone, keeps only the newest snapshot of each month', () => {
    const files = [
      f('2026-01-05/dump.sql', now - 250 * day),
      f('2026-01-20/dump.sql', now - 240 * day), // newer in Jan: survives
      f('2026-02-10/dump.sql', now - 220 * day), // only Feb: survives
      f('2026-02-01/dump.sql', now - 230 * day), // older in Feb: doomed
    ];
    const plan = retention.planDeletion(files, compiled, { now });
    const doomed = plan.delete.map(d => d.rel);
    expect(doomed.sort()).to.deep.equal(['2026-01-05/dump.sql', '2026-02-01/dump.sql']);
    expect(plan.delete.every(d => d.reason === 'notPeriodic')).to.equal(true);
  });

  it('dates snapshots without a date in the name by their mtime', () => {
    // Same month by mtime: the newer one is the monthly copy.
    const files = [
      f('undated/dump.sql', now - 300 * day),
      f('plain.txt', now - 300 * day + 3600 * 1000),
    ];
    const plan = retention.planDeletion(files, compiled, { now });
    expect(plan.delete.map(d => d.rel)).to.deep.equal(['undated/dump.sql']);
  });

  it('defaults to the mtime clock when no DateSource is given', () => {
    // A restored snapshot: old name, fresh mtime. The historical default
    // (mtime) must keep it; only an explicit 'names' ages it by its name.
    const files = [f('2020-01-01/dump.sql', now - day)];
    const byMtime = retention.compile({ Enabled: true, ByAge: true, KeepDays: 30, FileExtensions: ['.sql'] });
    const byName = retention.compile({ Enabled: true, ByAge: true, KeepDays: 30, DateSource: 'names', FileExtensions: ['.sql'] });
    expect(byMtime.dateSource).to.equal('metadata');
    expect(retention.planDeletion(files, byMtime, { now }).delete).to.have.lengthOf(0);
    expect(retention.planDeletion(files, byName, { now }).delete).to.have.lengthOf(1);
  });
});
