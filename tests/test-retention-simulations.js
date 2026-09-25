// tests/test-retention-simulations.js
//
// Retention simulations over generated backup names. Each scenario builds a
// realistic archive (one backup a day for years), applies a policy and checks
// the EXACT set of survivors, written out by hand from the calendar.
//
// Born from a production incident: "older than 180 days" + "one copy per
// month for 24 months" deleted the whole history, because the monthly rule
// condemned files instead of protecting them.

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
const compact = (ms) => ymd(ms).replace(/-/g, '');

/** One backup-YYYYMMDD.zip per day, from `days` ago up to NOW's day. */
function dailyArchive(days, nameOf) {
  const files = [];
  const today = Date.UTC(2026, 8, 15);
  for (let i = 0; i < days; i++) {
    const t = today - i * DAY;
    // Nightly job: the file is written at 03:00 of its day.
    files.push({ rel: nameOf ? nameOf(t, i) : `backup-${compact(t)}.zip`, size: 1024, mtimeMs: t + 3 * 3600 * 1000 });
  }
  return files;
}

function run(files, cfg) {
  const compiled = retention.compile({ Enabled: true, MinKeep: 0, ...cfg });
  expect(compiled.ok, compiled.error).to.equal(true);
  const plan = retention.planDeletion(files, compiled, { now: NOW });
  expect(plan.ok).to.equal(true);
  const deleted = new Set(plan.delete.map(d => d.rel));
  const survivors = files.filter(f => !deleted.has(f.rel)).map(f => f.rel).sort();
  return { plan, deleted, survivors };
}

/** Names of the daily backups from `from` to `to` (inclusive, YYYY-MM-DD). */
function range(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += DAY) out.push(`backup-${compact(t)}.zip`);
  return out;
}

const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

describe('retention simulations: age + monthly (the production incident)', () => {
  const files = dailyArchive(3 * 365);
  const { plan, deleted, survivors } = run(files, {
    DateSource: 'names', ByAge: true, KeepDays: 180, ByMonthly: true, MonthlyKeepMonths: 24,
  });

  // Age cutoff: NOW - 180d = 2026-03-19 12:00, so 2026-03-20 on is kept whole.
  // Monthly window: Oct/2024 .. Sep/2026, the last day of each month.
  const monthly = [];
  for (let y = 2024, m = 9; y < 2026 || m <= 1; m === 11 ? (y++, m = 0) : m++) {
    monthly.push(`backup-${y}${String(m + 1).padStart(2, '0')}${lastDayOfMonth(y, m)}.zip`);
  }

  it('keeps every backup of the last 180 days', () => {
    for (const rel of range('2026-03-20', '2026-09-15')) expect(deleted.has(rel), rel).to.equal(false);
  });

  it('keeps exactly one backup per month from Oct/2024 to Feb/2026', () => {
    expect(monthly).to.have.lengthOf(17);
    expect(monthly[0]).to.equal('backup-20241031.zip');
    expect(monthly[16]).to.equal('backup-20260228.zip');
    for (const rel of monthly) expect(deleted.has(rel), rel).to.equal(false);
  });

  it('survivors are exactly those two sets - nothing more, nothing less', () => {
    const expected = [...range('2026-03-20', '2026-09-15'), ...monthly].sort();
    expect(survivors).to.deep.equal(expected);
    expect(survivors).to.have.lengthOf(180 + 17);
  });

  it('deletes everything older than the 24-month window', () => {
    expect(deleted.has('backup-20240930.zip')).to.equal(true);
    expect(deleted.has('backup-20231001.zip')).to.equal(true);
  });

  it('reports the rescued monthly copies with their month', () => {
    expect(plan.kept.map(k => k.rel).sort()).to.deep.equal([...monthly].sort());
    expect(plan.kept.every(k => k.reason === 'monthly')).to.equal(true);
    expect(plan.kept.map(k => k.detail)).to.include('2024-10').and.to.include('2026-02');
  });

  it('lists every deleted file with its reason and date', () => {
    expect(plan.delete).to.have.lengthOf(files.length - survivors.length);
    expect(plan.delete.every(d => d.reason === 'age' && /^\d{4}-\d{2}-\d{2}T/.test(d.date))).to.equal(true);
    expect(plan.rules.map(r => `${r.kind}:${r.type}`)).to.deep.equal(['delete:age', 'keep:monthly']);
  });
});

describe('retention simulations: weekly copies', () => {
  const files = dailyArchive(200);
  const { plan, survivors } = run(files, {
    DateSource: 'names', ByAge: true, KeepDays: 30, ByWeekly: true, WeeklyKeepWeeks: 8,
  });

  it('keeps 30 days whole plus the Sunday of each older week in the window', () => {
    // Weeks start on Monday. The 8 weeks: Jul 27 .. Sep 14 (current).
    // Age keeps Aug 17 on (cutoff Aug 16 12:00); the older weeks keep their
    // newest backup, the Sunday: Aug 2, Aug 9 and Aug 16.
    const sundays = ['backup-20260802.zip', 'backup-20260809.zip', 'backup-20260816.zip'];
    expect(survivors).to.deep.equal([...range('2026-08-17', '2026-09-15'), ...sundays].sort());
    expect(plan.kept.map(k => k.detail).sort()).to.deep.equal(['2026-W31', '2026-W32', '2026-W33']);
  });
});

describe('retention simulations: fortnightly copies', () => {
  const files = dailyArchive(200);
  const { plan, survivors } = run(files, {
    DateSource: 'names', ByAge: true, KeepDays: 30, ByBiweekly: true, BiweeklyKeepPeriods: 6,
  });

  it('keeps 30 days whole plus the last day of each older fortnight', () => {
    // Fortnights: 1-15 and 16-end. The 6: Jun Q2 .. Sep Q1 (current).
    const ends = ['backup-20260630.zip', 'backup-20260715.zip', 'backup-20260731.zip', 'backup-20260815.zip'];
    expect(survivors).to.deep.equal([...range('2026-08-17', '2026-09-15'), ...ends].sort());
    expect(plan.kept.map(k => k.detail).sort()).to.deep.equal(['2026-06-Q2', '2026-07-Q1', '2026-07-Q2', '2026-08-Q1']);
  });
});

describe('retention simulations: weekly + monthly together', () => {
  const files = dailyArchive(400);
  const { survivors } = run(files, {
    DateSource: 'names', ByAge: true, KeepDays: 14, ByWeekly: true, WeeklyKeepWeeks: 4, ByMonthly: true, MonthlyKeepMonths: 6,
  });

  it('each keep rule protects its own copies; their union survives', () => {
    // Age: Sep 2 on. Weekly (Aug 24 .. Sep 14 weeks): Sunday Aug 30.
    // Monthly (Apr .. Sep): Apr 30, May 31, Jun 30, Jul 31, Aug 31.
    const expected = [
      ...range('2026-09-02', '2026-09-15'),
      'backup-20260830.zip',
      'backup-20260430.zip', 'backup-20260531.zip', 'backup-20260630.zip', 'backup-20260731.zip', 'backup-20260831.zip',
    ].sort();
    expect(survivors).to.deep.equal(expected);
  });
});

describe('retention simulations: count, size and MinKeep with a keep rule', () => {
  it('count keeps the N newest; the monthly rule still rescues older months', () => {
    const files = dailyArchive(120);
    const { survivors } = run(files, { DateSource: 'names', ByCount: true, KeepCount: 10, ByMonthly: true, MonthlyKeepMonths: 3 });
    // 10 newest: Sep 6..15. Monthly Jul..Sep: Jul 31, Aug 31 (Sep 15 already kept).
    expect(survivors).to.deep.equal([...range('2026-09-06', '2026-09-15'), 'backup-20260731.zip', 'backup-20260831.zip'].sort());
  });

  it('size frees space oldest-first but skips protected copies', () => {
    const files = dailyArchive(90).map(f => ({ ...f, size: 1024 * 1024 * 1024 })); // 1 GB each
    const { survivors, plan } = run(files, { DateSource: 'names', BySize: true, FreeGb: 20, ByMonthly: true, MonthlyKeepMonths: 3 });
    // 20 GB fit in total. The protected Jul 31 still takes 1 GB of it, so
    // the unprotected backups are cut to the 19 newest (Aug 28 .. Sep 15).
    expect(survivors).to.deep.equal([...range('2026-08-28', '2026-09-15'), 'backup-20260731.zip'].sort());
    expect(plan.delete.every(d => d.reason === 'size')).to.equal(true);
  });

  it('MinKeep shields the newest snapshots from every rule', () => {
    const files = dailyArchive(60);
    const { survivors, plan } = run(files, { DateSource: 'names', ByAge: true, KeepDays: 1, MinKeep: 5 });
    expect(survivors).to.deep.equal(range('2026-09-11', '2026-09-15'));
    expect(plan.kept.every(k => k.reason === 'minKeep')).to.equal(true);
  });

  it('keep rules alone keep ONLY the periodic copies', () => {
    const files = dailyArchive(120);
    const { survivors, plan } = run(files, { DateSource: 'names', ByMonthly: true, MonthlyKeepMonths: 3 });
    expect(survivors).to.deep.equal(['backup-20260731.zip', 'backup-20260831.zip', 'backup-20260915.zip']);
    expect(plan.delete.every(d => d.reason === 'notPeriodic')).to.equal(true);
  });
});

describe('retention simulations: layouts and date sources', () => {
  it('dated folders live or die whole', () => {
    const files = [];
    for (const f of dailyArchive(400)) {
      const d = f.rel.slice(7, 15);
      const folder = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
      files.push({ ...f, rel: `${folder}/db.sql` }, { ...f, rel: `${folder}/files.zip` });
    }
    const { survivors } = run(files, { DateSource: 'names', ByAge: true, KeepDays: 7, ByMonthly: true, MonthlyKeepMonths: 2, FileExtensions: [] });
    const folders = [...new Set(survivors.map(r => r.split('/')[0]))].sort();
    expect(folders).to.deep.equal(['2026-08-31', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15']);
    // Both files of every surviving folder remain.
    expect(survivors).to.have.lengthOf(folders.length * 2);
  });

  it('metadata mode dates undated names by mtime and obeys the same rules', () => {
    const files = dailyArchive(400, (t, i) => `dump_${String(i).padStart(4, '0')}.sql`);
    const { survivors } = run(files, { DateSource: 'metadata', ByAge: true, KeepDays: 30, ByMonthly: true, MonthlyKeepMonths: 4, FileExtensions: ['.sql'] });
    // i = days before Sep 15. Age keeps i <= 29 (Aug 17 03:00 > Aug 16 12:00).
    // Monthly Jun..Sep: Jun 30 (i=77), Jul 31 (i=46), Aug 31 kept by age anyway.
    const expected = [];
    for (let i = 0; i <= 29; i++) expected.push(`dump_${String(i).padStart(4, '0')}.sql`);
    expected.push('dump_0046.sql', 'dump_0077.sql');
    expect(survivors).to.deep.equal(expected.sort());
  });

  it('names mode ignores a misleading mtime (restored backup)', () => {
    // Every file was copied today, so every mtime is fresh; the names are the
    // only truth. Age by mtime would keep everything.
    const files = dailyArchive(100).map(f => ({ ...f, mtimeMs: NOW - 3600 * 1000 }));
    const { survivors } = run(files, { DateSource: 'names', ByAge: true, KeepDays: 30, ByMonthly: true, MonthlyKeepMonths: 3 });
    expect(survivors).to.deep.equal([...range('2026-08-17', '2026-09-15'), 'backup-20260731.zip'].sort());
  });
});

describe('retention simulations: real files on disk, preview == apply', () => {
  let dir;
  let mgr;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-retsim-'));
    const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-retsim-cfg-'));
    const logger = { log() {}, info() {}, warn() {}, error() {}, audit() {} };
    mgr = new SyncManager({ configDir: cfgDir }, logger, new RunRegistry());
    for (const f of dailyArchive(3 * 365)) {
      const full = path.join(dir, f.rel);
      fs.writeFileSync(full, 'x');
      fs.utimesSync(full, new Date(f.mtimeMs), new Date(f.mtimeMs));
    }
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('the preview lists exactly the files the run deletes', async () => {
    const cfg = { Enabled: true, DateSource: 'names', ByAge: true, KeepDays: 180, ByMonthly: true, MonthlyKeepMonths: 24, MinKeep: 5 };
    const preview = mgr.previewRetention(dir, cfg, { now: NOW });
    expect(preview.ok).to.equal(true);
    expect(preview.rules.map(r => r.type)).to.deep.equal(['age', 'monthly']);
    expect(preview.kept).to.have.lengthOf(17);

    const result = await mgr.runRetentionNow(dir, cfg, { now: NOW });
    expect(result.ok).to.equal(true);
    expect(result.deleted).to.equal(preview.delete.length);

    const left = fs.readdirSync(dir).sort();
    const previewed = new Set(preview.delete.map(d => d.rel));
    expect(left.some(n => previewed.has(n))).to.equal(false);
    expect(left).to.have.lengthOf(3 * 365 - preview.delete.length);
    expect(left).to.have.lengthOf(197);
    expect(left).to.include('backup-20241031.zip');
    expect(left).to.not.include('backup-20240930.zip');
  });
});
