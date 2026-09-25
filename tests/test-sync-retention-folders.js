// tests/test-sync-retention-folders.js
//
// Retention over a destination with several subfolders.
//
// The bug this file pins: "although files in subfolders are found, the
// algorithm seems to apply the pattern/retention as if only the first folder
// were found". The planner used to build ONE snapshot per top-level folder,
// so a subfolder with ten snapshots counted as a single copy - the count rule
// kept "3" and meant three FOLDERS, and the age rule dated a whole subfolder
// by its newest mtime, so its old snapshots never aged out. The analyzer, in
// turn, produced one pattern and one suggestion for the whole destination.
//
// These tests cover the per-subfolder engine (own pattern, own evidence, own
// suggestion, own plan) and the level-0 rule of formats.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const retention = require('../src/main/sync/retention');
const SyncManager = require('../src/main/sync/syncManager');
const RunRegistry = require('../src/main/runRegistry');

const DAY = retention.DAY_MS;
// Tuesday 2026-09-15, 12:00 UTC. Noon keeps the local calendar day equal to
// the UTC one in any timezone the suite runs in.
const NOW = Date.UTC(2026, 8, 15, 12);

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const at = (day, hour) => Date.parse(`${day}T${String(hour || 3).padStart(2, '0')}:00:00Z`);

/** File stamped with the clock of the day its name carries. */
function snap(rel, day, size) {
  return { rel, size: size || 10, mtimeMs: at(day) };
}

/** Daily subfolder snapshots: daily/2026-09-06 .. daily/2026-09-15. */
function dailySubfolder(count = 10, folder = 'daily') {
  const out = [];
  for (let i = 0; i < count; i++) {
    const day = new Date(NOW - i * DAY);
    out.push(snap(`${folder}/${ymd(day)}/db.7z`, ymd(day)));
  }
  return out;
}

/** Monthly subfolder snapshots, first of the month. */
function monthlySubfolder(days = ['2026-07-01', '2026-08-01', '2026-09-01'], folder = 'monthly') {
  return days.map(d => snap(`${folder}/${d}/db.7z`, d));
}

function run(files, cfg) {
  const compiled = retention.compile({ Enabled: true, MinKeep: 0, ...cfg });
  expect(compiled.ok, compiled.error).to.equal(true);
  return retention.planDeletion(files, compiled, { now: NOW });
}

const rels = (items) => items.map(i => i.rel).sort();

// ─── The reported bug: every subfolder gets its own plan ───
describe('retention: subfolder archives are planned separately', () => {
  it('a subfolder with ten snapshots is not one copy', () => {
    // 10 daily snapshots next to 3 monthly ones. Before the fix both folders
    // were single snapshots: totalSnapshots was 2 and nothing was ever deleted.
    const files = [...dailySubfolder(10), ...monthlySubfolder()];
    const plan = run(files, { DateSource: 'names', ByCount: true, KeepCount: 3 });

    expect(plan.totalSnapshots).to.equal(13);
    expect(plan.folders.map(f => f.rel)).to.deep.equal(['daily', 'monthly']);
    // "Keep 3" is 3 per subfolder, never 3 folders in total.
    expect(rels(plan.delete)).to.have.lengthOf(7);
    expect(plan.delete.every(d => d.rel.startsWith('daily/'))).to.equal(true);
    expect(plan.delete.every(d => d.reason === 'count')).to.equal(true);
    // The 3 newest daily snapshots survive, whole.
    const left = plan.folders.find(f => f.rel === 'daily');
    expect(rels(left.delete)).to.deep.equal([
      'daily/2026-09-06/db.7z', 'daily/2026-09-07/db.7z', 'daily/2026-09-08/db.7z',
      'daily/2026-09-09/db.7z', 'daily/2026-09-10/db.7z', 'daily/2026-09-11/db.7z',
      'daily/2026-09-12/db.7z',
    ]);
    // The monthly subfolder has only 3 snapshots: it loses nothing.
    expect(plan.folders.find(f => f.rel === 'monthly').delete).to.deep.equal([]);
  });

  it('ages each subfolder by its own snapshots, not by the newest of them', () => {
    const files = [
      ...monthlySubfolder(['2025-01-01', '2026-09-10']),
      ...dailySubfolder(1),
    ];
    const plan = run(files, { DateSource: 'names', ByAge: true, KeepDays: 20 });
    // Before the fix, the whole 'monthly' folder was dated by its newest mtime
    // (2026-09-10) and the 2025 snapshot survived forever.
    expect(rels(plan.delete)).to.deep.equal(['monthly/2025-01-01/db.7z']);
    expect(plan.delete[0].folder).to.equal('monthly');
    expect(plan.delete[0].reason).to.equal('age');
  });

  it('MinKeep shields the newest snapshots of every subfolder', () => {
    const files = [...dailySubfolder(5), ...monthlySubfolder(['2026-09-01'])];
    const plan = run(files, { DateSource: 'names', ByCount: true, KeepCount: 1, MinKeep: 2 });
    // Two newest per subfolder: the single monthly snapshot survives even
    // though it is the oldest file in the destination.
    expect(rels(plan.delete)).to.have.lengthOf(3);
    expect(plan.delete.every(d => d.rel.startsWith('daily/'))).to.equal(true);
  });

  it('keeps one periodic copy per subfolder, not one for the destination', () => {
    const files = [
      ...monthlySubfolder(['2026-06-05', '2026-07-10', '2026-08-02', '2026-09-01'], 'monthly'),
      ...monthlySubfolder(['2026-06-20', '2026-07-01', '2026-08-15', '2026-09-10'], 'mensal'),
    ];
    const plan = run(files, { DateSource: 'names', ByMonthly: true, MonthlyKeepMonths: 3 });
    // Jul, Aug and Sep are inside the window, so each subfolder protects its
    // own newest copy of each. With the buckets shared, one subfolder would
    // have won all three and the other lost everything but June.
    expect(rels(plan.delete)).to.deep.equal(['mensal/2026-06-20/db.7z', 'monthly/2026-06-05/db.7z']);
    expect(plan.folders.map(f => [f.rel, f.kept.length])).to.deep.equal([['mensal', 3], ['monthly', 3]]);
  });

  it('the size budget stays global: one destination, one target', () => {
    const files = [
      snap('velho/2026-01-01/db.7z', '2026-01-01', 5 * 1024 ** 3),
      snap('novo/2026-09-01/db.7z', '2026-09-01', 5 * 1024 ** 3),
    ];
    // 10 GB total, 6 GB target -> free 4 GB -> one 5 GB unit. Per subfolder
    // the same policy would have freed 8 GB.
    const plan = run(files, { DateSource: 'names', BySize: true, FreeGb: 6 });
    expect(rels(plan.delete)).to.deep.equal(['velho/2026-01-01/db.7z']);
    expect(plan.delete[0].reason).to.equal('size');
  });

  it('a subfolder whose own name is the date stays a snapshot of the root', () => {
    // The classic dated-folder archive: the top level IS the snapshot set, so
    // it stays one group and one count rule - unchanged behaviour.
    const files = [];
    for (let i = 0; i < 5; i++) {
      const day = ymd(NOW - i * DAY);
      files.push(snap(`${day}/db.7z`, day), snap(`${day}/files.zip`, day));
    }
    const plan = run(files, { DateSource: 'names', ByCount: true, KeepCount: 2 });
    expect(plan.folders.map(f => f.rel)).to.deep.equal(['']);
    expect(plan.totalSnapshots).to.equal(5);
    expect(rels(plan.delete)).to.deep.equal([
      '2026-09-11/db.7z', '2026-09-11/files.zip',
      '2026-09-12/db.7z', '2026-09-12/files.zip',
      '2026-09-13/db.7z', '2026-09-13/files.zip',
    ]);
  });

  it('undated subfolders are not sub-archives', () => {
    const files = [
      { rel: 'snap-01/a.7z', size: 10, mtimeMs: NOW - 10 * DAY },
      { rel: 'snap-02/a.7z', size: 10, mtimeMs: NOW - 9 * DAY },
      { rel: 'snap-03/a.7z', size: 10, mtimeMs: NOW - 8 * DAY },
      { rel: 'outro/a.7z', size: 10, mtimeMs: NOW - 1 * DAY },
    ];
    const plan = run(files, { ByCount: true, KeepCount: 2 });
    // No date anywhere below the subfolder name: they are plain folders of the
    // destination, exactly as before.
    expect(plan.folders.map(f => f.rel)).to.deep.equal(['']);
    expect(plan.totalSnapshots).to.equal(4);
    expect(rels(plan.delete)).to.deep.equal(['snap-01/a.7z', 'snap-02/a.7z']);
  });

  it('every planned file carries the subfolder it belongs to', () => {
    const files = [...dailySubfolder(3), ...monthlySubfolder(), { rel: 'raiz.7z', size: 1, mtimeMs: NOW - 400 * DAY }];
    const plan = run(files, { DateSource: 'names', ByAge: true, KeepDays: 2 });
    const folderOf = new Map(plan.folders.map(f => [f.rel, f]));
    expect([...folderOf.keys()]).to.deep.equal(['', 'daily', 'monthly']);
    for (const f of plan.folders) {
      for (const item of f.delete) {
        expect(item.folder).to.equal(f.rel);
        expect(folderOf.get(item.folder).delete).to.include(item);
      }
    }
    // The aggregate stays the concatenation of the groups, for old consumers.
    expect(plan.delete.map(d => d.rel)).to.have.lengthOf(
      plan.folders.reduce((s, f) => s + f.delete.length, 0));
  });
});

// ─── Analysis: one pattern, evidence and suggestion per subfolder ───
describe('retention: analyze per subfolder', () => {
  const files = [...dailySubfolder(10), ...monthlySubfolder()];

  it('gives every subfolder its own pattern, evidence and suggestion', () => {
    const a = retention.analyze('.', { scanner: () => files });
    expect(a.ok).to.equal(true);
    expect(a.grouping).to.equal('folders');
    expect(a.folders.map(f => f.rel)).to.deep.equal(['daily', 'monthly']);

    const [daily, monthly] = a.folders;
    expect(daily.folderPattern).to.equal('dated-folders');
    expect(daily.pattern).to.equal('dated-folders');
    expect(daily.medianGapDays).to.equal(1);
    expect(daily.totalFiles).to.equal(10);
    expect(monthly.medianGapDays).to.equal(31);
    expect(monthly.totalFiles).to.equal(3);

    // Different rotations, different proposals.
    expect(daily.suggested.KeepDays).to.equal(7);
    expect(monthly.suggested.KeepDays).to.equal(126);
    expect(daily.suggested.KeepCount).to.equal(11);
    // ... and the aggregate is the least destructive of them, never stricter.
    expect(a.suggested.KeepDays).to.equal(126);
    expect(a.suggested.KeepCount).to.equal(11);

    // Evidence is per subfolder: every sample belongs to its own group.
    expect(daily.evidence.understood.length).to.equal(10);
    expect(daily.evidence.understood.every(e => e.rel.startsWith('daily/'))).to.equal(true);
    expect(monthly.evidence.understood.every(e => e.rel.startsWith('monthly/'))).to.equal(true);
    expect(daily.evidence.ignored).to.deep.equal([]);
  });

  it('keeps the aggregate fields the UI already reads', () => {
    const a = retention.analyze('.', { scanner: () => files });
    expect(a.totalFiles).to.equal(13);
    expect(a.folderPattern).to.equal('dated-folders');
    expect(a.dateIsh).to.equal(1);
    expect(a.label).to.equal('dated-folders');
    expect(a.understood).to.have.lengthOf(13);
    expect(a.subfolders.map(s => s.rel)).to.deep.equal(['daily', 'monthly']);
    expect(a.subfolders[0]).to.include({ rel: 'daily', files: 10 });
  });

  it('a single-group destination still returns one group, named ""', () => {
    const flat = [];
    for (let i = 0; i < 4; i++) {
      const day = ymd(NOW - i * 7 * DAY);
      flat.push(snap(`backup-${day.replace(/-/g, '')}.7z`, day));
    }
    const a = retention.analyze('.', { scanner: () => flat });
    expect(a.grouping).to.equal('root');
    expect(a.folders).to.have.lengthOf(1);
    expect(a.folders[0]).to.include({ rel: '', isRoot: true, totalFiles: 4 });
    expect(a.suggested).to.deep.equal(a.folders[0].suggested);
  });

  it('an empty destination returns an empty group list, not a crash', () => {
    const a = retention.analyze('.', { scanner: () => [] });
    expect(a.folders).to.deep.equal([]);
    expect(a.subfolders).to.deep.equal([]);
    expect(a.totalFiles).to.equal(0);
  });

  it('exposes the sample cap per subfolder', () => {
    const many = dailySubfolder(80);
    const a = retention.analyze('.', { scanner: () => many });
    expect(a.folders[0].evidence.understood).to.have.lengthOf(50);
    expect(a.folders[0].evidence.truncated).to.equal(true);
  });
});

// ─── Level-0 rule of formats ───
describe('retention: format filter', () => {
  it('defaults to the archive extensions when the config says nothing', () => {
    expect(retention.normalizeExtensions({})).to.deep.equal(['.7z', '.zip']);
    expect(retention.normalizeExtensions(null)).to.deep.equal(['.7z', '.zip']);
    expect(retention.DEFAULT_EXTENSIONS).to.deep.equal(['.7z', '.zip']);
    expect(retention.compile({ Enabled: true, ByAge: true, KeepDays: 7 }).extensions)
      .to.deep.equal(['.7z', '.zip']);
  });

  it('accepts either key, a string, and mixed case', () => {
    expect(retention.normalizeExtensions({ FileExtensions: ['7Z', '.RAR'] })).to.deep.equal(['.7z', '.rar']);
    expect(retention.normalizeExtensions({ Extensions: '.tar, gz' })).to.deep.equal(['.tar', '.gz']);
    // FileExtensions wins when both are present.
    expect(retention.normalizeExtensions({ FileExtensions: ['.7z'], Extensions: ['.bak'] }))
      .to.deep.equal(['.7z']);
  });

  it('an emptied list means every format, not none', () => {
    expect(retention.normalizeExtensions({ FileExtensions: [] })).to.deep.equal([]);
    expect(retention.normalizeExtensions({ FileExtensions: '*' })).to.deep.equal([]);
    expect(retention.normalizeExtensions({ Extensions: [] })).to.deep.equal([]);
    const files = [{ rel: 'a.7z' }, { rel: 'b.sql' }, { rel: 'c/sem-ext' }];
    expect(retention.filterByExtension(files, [])).to.have.lengthOf(3);
  });

  it('filters before planning: other formats are never touched', () => {
    const files = [
      { rel: 'antigo.7z', size: 10, mtimeMs: NOW - 400 * DAY },
      { rel: 'antigo.zip', size: 10, mtimeMs: NOW - 400 * DAY },
      { rel: 'antigo.sql', size: 10, mtimeMs: NOW - 400 * DAY },
      { rel: 'antigo.txt', size: 10, mtimeMs: NOW - 400 * DAY },
    ];
    const plan = run(files, { ByAge: true, KeepDays: 30 });
    expect(rels(plan.delete)).to.deep.equal(['antigo.7z', 'antigo.zip']);
    // The user removes the filter: now everything ages out.
    const all = run(files, { ByAge: true, KeepDays: 30, FileExtensions: [] });
    expect(rels(all.delete)).to.deep.equal(['antigo.7z', 'antigo.sql', 'antigo.txt', 'antigo.zip']);
    expect(all.extensions).to.deep.equal([]);
  });

  it('filters before analysis, so the pattern describes the managed formats', () => {
    const files = [
      { rel: '2026-01-01/db.7z', size: 10, mtimeMs: NOW - 400 * DAY },
      { rel: '2026-02-01/db.7z', size: 10, mtimeMs: NOW - 390 * DAY },
      { rel: 'lixo.sql', size: 10, mtimeMs: NOW },
    ];
    const scoped = retention.analyze('.', { scanner: () => files, extensions: ['.7z', '.zip'] });
    expect(scoped.totalFiles).to.equal(2);
    expect(scoped.extensions).to.deep.equal(['.7z', '.zip']);
    expect(scoped.folderPattern).to.equal('dated-folders');
    // No filter given: the analysis inspects everything, as it always did.
    expect(retention.analyze('.', { scanner: () => files }).totalFiles).to.equal(3);
  });

  it('ignores case and folders that merely look like an extension', () => {
    const files = [
      { rel: 'A.ZIP', size: 1, mtimeMs: NOW },
      { rel: 'pasta.zip/arquivo.txt', size: 1, mtimeMs: NOW },
      { rel: 'sem-extensao', size: 1, mtimeMs: NOW },
    ];
    expect(retention.filterByExtension(files, ['.zip', '.7z']).map(f => f.rel)).to.deep.equal(['A.ZIP']);
    expect(retention.extensionOf('pasta.zip/arquivo.txt')).to.equal('.txt');
    expect(retention.extensionOf('sem-extensao')).to.equal('');
  });
});

// ─── End to end: preview and execution must agree on every subfolder ───
describe('SyncManager: retention across subfolders (real files)', () => {
  let dir;
  let mgr;
  const cfgDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-retsub-cfg-'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-retsub-'));
    const logger = { log() {}, info() {}, warn() {}, error() {}, audit() {} };
    mgr = new SyncManager({ configDir: cfgDir() }, logger, new RunRegistry());
    const write = (rel, day, size) => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'x'.repeat(size || 1));
      fs.utimesSync(full, new Date(at(day)), new Date(at(day)));
    };
    for (const f of dailySubfolder(10)) write(f.rel, ymd(f.mtimeMs));
    for (const f of monthlySubfolder()) write(f.rel, ymd(f.mtimeMs));
    // A .sql inside a snapshot: outside the format filter, it must survive.
    write('daily/2026-09-01/notas.sql', '2026-09-01');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const cfg = { Enabled: true, DateSource: 'names', ByCount: true, KeepCount: 3, MinKeep: 0 };

  it('preview groups the verdict per subfolder and keeps the aggregates', () => {
    const preview = mgr.previewRetention(dir, cfg, { now: NOW });
    expect(preview.ok).to.equal(true);
    expect(preview.folders.map(f => f.rel)).to.deep.equal(['daily', 'monthly']);
    expect(preview.extensions).to.deep.equal(['.7z', '.zip']);
    // Aggregates unchanged: totalFiles counts the whole scan, as before.
    expect(preview.totalFiles).to.equal(14);
    expect(preview.totalSnapshots).to.equal(13);
    expect(preview.delete).to.have.lengthOf(7);
    expect(preview.deleteBytes).to.equal(7);
    expect(preview.folders.find(f => f.rel === 'monthly').delete).to.deep.equal([]);
    // Nothing on disk moved.
    expect(fs.readdirSync(path.join(dir, 'monthly')).sort())
      .to.deep.equal(['2026-07-01', '2026-08-01', '2026-09-01']);
  });

  it('the run deletes in every subfolder the preview planned', async () => {
    const preview = mgr.previewRetention(dir, cfg, { now: NOW });
    const result = await mgr.runRetentionNow(dir, cfg, { now: NOW });
    expect(result.ok).to.equal(true);
    expect(result.deleted).to.equal(preview.delete.length);
    expect(result.folders.map(f => f.rel)).to.deep.equal(['daily']);
    expect(result.folders[0]).to.include({ rel: 'daily', planned: 7, deleted: 7 });

    // 10 daily snapshots -> 3 newest left; 3 monthly untouched. 2026-09-01
    // survives only as the folder holding the out-of-scope .sql.
    expect(fs.readdirSync(path.join(dir, 'daily')).sort()).to.deep.equal([
      '2026-09-01', '2026-09-13', '2026-09-14', '2026-09-15',
    ]);
    expect(fs.readdirSync(path.join(dir, 'monthly')).sort())
      .to.deep.equal(['2026-07-01', '2026-08-01', '2026-09-01']);
    // The .sql was never in scope: the format filter runs before the plan.
    expect(fs.existsSync(path.join(dir, 'daily', '2026-09-01', 'notas.sql'))).to.equal(true);
  });

  it('an emptied format filter lets every format age out, preview == run', async () => {
    const all = { ...cfg, ByCount: false, ByAge: true, KeepDays: 2, FileExtensions: [] };
    const preview = mgr.previewRetention(dir, all, { now: NOW });
    expect(preview.extensions).to.deep.equal([]);
    expect(preview.delete.map(d => d.rel)).to.include('daily/2026-09-01/notas.sql');
    const result = await mgr.runRetentionNow(dir, all, { now: NOW });
    expect(result.deleted).to.equal(preview.delete.length);
    expect(fs.existsSync(path.join(dir, 'daily', '2026-09-01', 'notas.sql'))).to.equal(false);
  });

  it('a profile stores the normalized extensions under both keys', () => {
    const p = mgr.createProfile({
      Name: 'subpastas', SourcePath: dir, DestPath: dir, Engine: 'local',
      Retention: { Enabled: true, ByAge: true, KeepDays: 30, Extensions: '.7Z' },
    });
    expect(p.Retention.FileExtensions).to.deep.equal(['.7z']);
    expect(p.Retention.Extensions).to.deep.equal(['.7z']);

    const defaulted = mgr.createProfile({ Name: 'padrao', SourcePath: dir, DestPath: dir });
    expect(defaulted.Retention.FileExtensions).to.deep.equal(['.7z', '.zip']);

    const cleared = mgr.updateProfile({ Id: p.Id, Retention: { Enabled: true, ByAge: true, KeepDays: 30, FileExtensions: [] } });
    expect(cleared.Retention.FileExtensions).to.deep.equal([]);
    expect(cleared.Retention.Extensions).to.deep.equal([]);
  });
});
