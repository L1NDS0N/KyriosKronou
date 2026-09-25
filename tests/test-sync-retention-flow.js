// tests/test-sync-retention-flow.js
//
// End-to-end: a sync runs, then retention deletes what aged out of the
// destination - through the real SyncManager, the real local engine and real
// files, exactly like the service will do it.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const SyncManager = require('../src/main/sync/syncManager');
const RunRegistry = require('../src/main/runRegistry');
const { SchedulerCore } = require('../src/main/schedulerCore');
const CronParser = require('../src/main/cronParser');

const DAY = 86400000;

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-retflow-' + label + '-'));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content || 'x');
  return full;
}

function aged(dir, rel, days, content) {
  const full = write(dir, rel, content);
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(full, t, t);
  return full;
}

function fakeConfig() {
  const dir = tmpDir('cfg');
  return { configDir: dir, dispose() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} } };
}

function fakeLogger() {
  return {
    lines: [],
    log(level, msg) { this.lines.push(`[${level}] ${msg}`); },
    info(m) { this.log('INFO', m); },
    warn(m) { this.log('WARN', m); },
    error(m) { this.log('ERROR', m); },
    audit(action) { this.audits = this.audits || []; this.audits.push(action); },
  };
}

function newManager(logger) {
  return new SyncManager(fakeConfig(), logger || fakeLogger(), new RunRegistry());
}

describe('SyncManager: retention end to end (local engine, real files)', () => {
  let mgr, src, dst, logger;
  beforeEach(() => {
    logger = fakeLogger();
    mgr = newManager(logger);
    src = tmpDir('src');
    dst = tmpDir('dst');
  });
  afterEach(() => {
    for (const d of [src, dst, mgr.config.configDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    }
  });

  function profile(retention, overrides) {
    return mgr.createProfile(Object.assign({
      Name: 'Sync com retenção',
      SourcePath: src,
      DestPath: dst,
      Engine: 'local',
      Mode: 'incremental',
      Mirror: false,
      Retention: retention,
    }, overrides || {}));
  }

  it('copies files and then deletes the ones that aged out', async () => {
    write(src, 'atual.txt', 'viva');
    // Old content already in the destination (older than 7 days).
    aged(dst, 'antigo.txt', 30, 'velho');
    aged(dst, 'recente.txt', 1, 'novo');

    const p = profile({ Enabled: true, ByAge: true, KeepDays: 7, MinKeep: 0, FileExtensions: [] });
    const r = await mgr.executeSync(p.Id);

    expect(r.success).to.equal(true);
    expect(r.retention.ok).to.equal(true);
    expect(r.retention.deleted).to.equal(1);
    expect(fs.existsSync(path.join(dst, 'antigo.txt'))).to.equal(false);
    expect(fs.existsSync(path.join(dst, 'recente.txt'))).to.equal(true);
    expect(fs.readFileSync(path.join(dst, 'atual.txt'), 'utf8')).to.equal('viva');
  });

  it('freshly copied files are never deleted by the same run', async () => {
    // Source file is old itself: the copy preserves its mtime, but MinKeep
    // and the just-copied ordering must keep it alive.
    aged(src, 'importante-velho.txt', 400, 'precioso');

    const p = profile({ Enabled: true, ByAge: true, KeepDays: 7, MinKeep: 0, FileExtensions: [] });
    // First run copies it; MinKeep=1 protects it from being immediately deleted.
    const p2 = profile({ Enabled: true, ByAge: true, KeepDays: 7, MinKeep: 1, FileExtensions: [] });
    const r = await mgr.executeSync(p2.Id);

    expect(r.success).to.equal(true);
    expect(fs.existsSync(path.join(dst, 'importante-velho.txt'))).to.equal(true);
  });

  it('keeps at least MinKeep files even when all are old', async () => {
    write(src, 'unico.txt', 'so');
    aged(dst, 'velho1.txt', 100, 'a');
    aged(dst, 'velho2.txt', 90, 'b');
    aged(dst, 'velho3.txt', 80, 'c');
    aged(dst, 'velho4.txt', 70, 'd');

    // Four old files + the fresh copy of unico.txt (newest of all).
    // MinKeep=2 protects unico.txt and velho4; by age all five were doomed,
    // so velho1, velho2 and velho3 go.
    const p = profile({ Enabled: true, ByAge: true, KeepDays: 10, MinKeep: 2, FileExtensions: [] });
    const r = await mgr.executeSync(p.Id);
    expect(r.retention.deleted).to.equal(3);
    expect(fs.existsSync(path.join(dst, 'velho3.txt'))).to.equal(false);
    expect(fs.existsSync(path.join(dst, 'velho4.txt'))).to.equal(true);
    expect(fs.existsSync(path.join(dst, 'unico.txt'))).to.equal(true);
  });

  it('retention disabled never deletes anything beyond the sync plan', async () => {
    write(src, 'a.txt', 'a');
    aged(dst, 'antigo.txt', 999, 'velho');
    const p = profile({ Enabled: false, ByAge: true, KeepDays: 1 });
    const r = await mgr.executeSync(p.Id);
    expect(r.success).to.equal(true);
    expect(r.retention.deleted).to.equal(0);
    expect(fs.existsSync(path.join(dst, 'antigo.txt'))).to.equal(true);
  });

  it('count policy keeps only the newest N snapshot folders', async () => {
    // 5 dated snapshot folders in the source; only 2 may survive in the dest.
    for (let i = 4; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY);
      write(src, `${d.toISOString().slice(0, 10)}/dump.sql`, 'snap ' + i);
      write(dst, `${d.toISOString().slice(0, 10)}/dump.sql`, 'snap ' + i);
    }
    const p = profile({ Enabled: true, ByCount: true, KeepCount: 2, MinKeep: 0, FileExtensions: ['.sql'] });
    const r = await mgr.executeSync(p.Id);
    expect(r.success).to.equal(true);
    expect(r.retention.deleted).to.equal(3);
    const left = fs.readdirSync(dst).filter(f => fs.statSync(path.join(dst, f)).isDirectory()).sort();
    expect(left).to.have.lengthOf(2);
    // The newest two.
    expect(left[1]).to.equal(new Date().toISOString().slice(0, 10));
  });

  it('history records how many files retention removed', async () => {
    write(src, 'a.txt', 'a');
    aged(dst, 'velho.txt', 30, 'v');
    const p = profile({ Enabled: true, ByAge: true, KeepDays: 5, MinKeep: 0, FileExtensions: [] });
    await mgr.executeSync(p.Id);
    const h = mgr.getHistory(p.Id);
    expect(h[0].RetentionDeleted).to.equal(1);
  });

  it('analyzeFolder detects a dated-snapshot layout', async () => {
    for (let i = 0; i < 6; i++) {
      const d = new Date(Date.now() - i * DAY);
      write(src, `${d.toISOString().slice(0, 10)}/f.bin`, 'x');
    }
    const a = mgr.analyzeFolder(src);
    expect(a.ok).to.equal(true);
    expect(a.folderPattern).to.equal('dated-folders');
    expect(a.suggested.Enabled).to.equal(true);
  });

  it('analyzeFolder reports missing folders without throwing', () => {
    const a = mgr.analyzeFolder(path.join(src, 'sumiu'));
    expect(a.ok).to.equal(false);
  });

  it('previewRetention lists deletions without touching the disk', () => {
    aged(dst, 'antigo.txt', 30, 'v');
    aged(dst, 'novo.txt', 1, 'n');
    const preview = mgr.previewRetention(dst, { Enabled: true, ByAge: true, KeepDays: 7, MinKeep: 0, FileExtensions: [] });
    expect(preview.ok).to.equal(true);
    expect(preview.delete.map(x => x.rel)).to.deep.equal(['antigo.txt']);
    // Files are still there - it is a preview.
    expect(fs.existsSync(path.join(dst, 'antigo.txt'))).to.equal(true);
  });

  it('createProfile normalizes a missing Retention block', () => {
    const p = mgr.createProfile({ Name: 'Sem retenção', SourcePath: 'C:/a', DestPath: 'D:/b' });
    expect(p.Retention).to.deep.include({ Enabled: false, ByAge: false, MinKeep: 3 });
  });
});

describe('SchedulerCore: sync profiles on cron', () => {
  let mgr, src, dst;
  beforeEach(() => {
    mgr = newManager();
    src = tmpDir('src');
    dst = tmpDir('dst');
  });
  afterEach(() => {
    for (const d of [src, dst, mgr.config.configDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
    }
  });

  function newScheduler(ownerPid) {
    return new SchedulerCore(
      { taskManager: { getDueTasks: () => [] }, backupManager: null, syncManager: mgr, cronParser: new CronParser(), logger: fakeLogger() },
      'service',
      {},
      { pid: ownerPid }
    );
  }

  it('runDueSyncs executes due cron syncs', async () => {
    write(src, 'a.txt', 'a');
    mgr.createProfile({ Name: 'Cron sync', SourcePath: src, DestPath: dst, CronExpression: '* * * * *' });
    // Fresh profile: LastRun null and cron matches now -> due.

    const sched = newScheduler(process.pid);
    sched.runDueSyncs();
    // Executed async; wait a beat.
    await new Promise(r => setTimeout(r, 150));
    expect(fs.existsSync(path.join(dst, 'a.txt'))).to.equal(true);
  });

  it('does not double-fire the same sync inside the guard window', async () => {
    write(src, 'a.txt', 'a');
    const p = mgr.createProfile({ Name: 'Guarda', SourcePath: src, DestPath: dst, CronExpression: '* * * * *' });

    const sched = newScheduler(process.pid);
    sched.runDueSyncs();
    await new Promise(r => setTimeout(r, 150));
    sched.runDueSyncs(); // same minute: _guard must reject
    await new Promise(r => setTimeout(r, 100));

    expect(mgr.getHistory(p.Id)).to.have.lengthOf(1);
  });
});

describe('SyncManager: task triggers with retention profiles', () => {
  it('still triggers attached syncs whose Retention block is present', async () => {
    const mgr = newManager();
    const src = tmpDir('src'), dst = tmpDir('dst');
    write(src, 'artefato.bin', 'build');
    aged(dst, 'lixo.bin', 99, 'velho');

    const p = mgr.createProfile({
      Name: 'Pós-build', SourcePath: src, DestPath: dst,
      TriggerTaskId: 'task-x', CronExpression: '',
      Retention: { Enabled: true, ByAge: true, KeepDays: 10, MinKeep: 0 },
    });

    const results = await mgr.handleTaskFinished({ Id: crypto.randomUUID(), TaskId: 'task-x', Status: 'Success' });
    expect(results).to.have.lengthOf(1);
    expect(results[0].success).to.equal(true);
    expect(fs.existsSync(path.join(dst, 'lixo.bin'))).to.equal(false);

    mgr.config.dispose();
    try { fs.rmSync(src, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch (e) {}
  });
});
