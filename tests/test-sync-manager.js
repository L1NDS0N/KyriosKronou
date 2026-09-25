// tests/test-sync-manager.js
//
// The SyncManager glues profiles, planning, engines, history and the run
// registry together. These tests use the real local engine against temp
// folders, so what gets verified is the whole copy path, not a mock of it.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const SyncManager = require('../src/main/sync/syncManager');
const RunRegistry = require('../src/main/runRegistry');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-syncm-' + label + '-'));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// A config manager double with its OWN temp directory per instance: sharing
// one directory between two managers is exactly the reload scenario, and the
// second instance would see the first's profiles on construction.
function fakeConfig() {
  const dir = tmpDir('cfg');
  return {
    configDir: dir,
    dispose() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} },
  };
}

// A logger double: audit() must exist, log lines are captured for assertions.
function fakeLogger() {
  return {
    lines: [],
    log(level, msg) { this.lines.push(`[${level}] ${msg}`); },
    info(msg) { this.log('INFO', msg); },
    warn(msg) { this.log('WARN', msg); },
    error(msg) { this.log('ERROR', msg); },
    audit(action, details) { this.audits = this.audits || []; this.audits.push(action); },
  };
}

function newManager(logger) {
  return new SyncManager(fakeConfig(), logger || fakeLogger(), new RunRegistry());
}

describe('SyncManager: profile CRUD', () => {
  let mgr;
  beforeEach(() => { mgr = newManager(); });
  afterEach(() => { mgr.config.dispose(); });

  it('creates a profile with defaults', () => {
    const p = mgr.createProfile({ Name: 'Docs → NAS', SourcePath: 'C:/docs', DestPath: 'D:/nas/docs' });
    expect(p.Id).to.be.a('string');
    expect(p.Mode).to.equal('incremental');
    expect(p.Mirror).to.equal(true);
    expect(p.Enabled).to.equal(true);
    expect(p.Engine).to.equal('local');
    expect(mgr.getAllProfiles()).to.have.lengthOf(1);
  });

  it('persists profiles to disk and loads them in a fresh instance', () => {
    const cfg = fakeConfig();
    const first = new SyncManager(cfg, fakeLogger(), null);
    const p = first.createProfile({ Name: 'Persiste', SourcePath: 'C:/a', DestPath: 'D:/b' });

    // A new manager over the same data directory starts from what is on disk,
    // exactly like the service process starting while the GUI already saved.
    const second = new SyncManager(cfg, fakeLogger(), null);
    expect(second.getAllProfiles()).to.have.lengthOf(1);
    expect(second.getProfile(p.Id).Name).to.equal('Persiste');
    cfg.dispose();
  });

  it('updates a profile and keeps UpdatedAt fresh', () => {
    const p = mgr.createProfile({ Name: 'Antes', SourcePath: 'C:/a', DestPath: 'D:/b' });
    const updated = mgr.updateProfile({ Id: p.Id, Name: 'Depois', Mode: 'full' });
    expect(updated.Name).to.equal('Depois');
    expect(updated.Mode).to.equal('full');
    expect(mgr.getProfile(p.Id).Name).to.equal('Depois');
  });

  it('returns null when updating a profile that does not exist', () => {
    expect(mgr.updateProfile({ Id: crypto.randomUUID(), Name: 'x' })).to.equal(null);
  });

  it('deletes a profile', () => {
    const p = mgr.createProfile({ Name: 'Efêmero', SourcePath: 'C:/a', DestPath: 'D:/b' });
    expect(mgr.deleteProfile(p.Id)).to.equal(true);
    expect(mgr.getProfile(p.Id)).to.equal(null);
    expect(mgr.deleteProfile(p.Id)).to.equal(false);
  });
});

describe('SyncManager: execution (local engine, real files)', () => {
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

  function profile(overrides) {
    return mgr.createProfile(Object.assign({
      Name: 'Sync de teste',
      SourcePath: src,
      DestPath: dst,
      Engine: 'local',
      Mode: 'incremental',
      Mirror: false,
    }, overrides || {}));
  }

  it('copies all files on the first run', async () => {
    write(src, 'a.txt', 'conteudo a');
    write(src, 'sub/b.txt', 'conteudo b');
    const p = profile();

    const r = await mgr.executeSync(p.Id);
    expect(r.success).to.equal(true);
    expect(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8')).to.equal('conteudo a');
    expect(fs.readFileSync(path.join(dst, 'sub', 'b.txt'), 'utf8')).to.equal('conteudo b');
  });

  it('copies only new/changed files on the second run', async () => {
    write(src, 'same.txt', 'igual');
    write(src, 'chenge.txt', 'v1');
    const p = profile();
    await mgr.executeSync(p.Id);

    // One file unchanged, one changed, one new.
    fs.writeFileSync(path.join(src, 'chenge.txt'), 'v2-longer');
    write(src, 'novo.txt', 'novidade');

    const r = await mgr.executeSync(p.Id);
    expect(r.success).to.equal(true);
    expect(r.planned.copy.map(c => c.rel).sort()).to.deep.equal(['chenge.txt', 'novo.txt']);
    expect(r.planned.skipped).to.equal(1);
    expect(fs.readFileSync(path.join(dst, 'chenge.txt'), 'utf8')).to.equal('v2-longer');
  });

  it('full mode re-copies identical files', async () => {
    write(src, 'a.txt', 'aaa');
    const p = profile({ Mode: 'full' });
    await mgr.executeSync(p.Id);
    const r = await mgr.executeSync(p.Id);
    expect(r.planned.copy).to.have.lengthOf(1);
    expect(r.planned.copy[0].reason).to.equal('full');
  });

  it('mirror removes destination files that vanished from the source', async () => {
    write(src, 'fica.txt', 'fica');
    write(src, 'sai.txt', 'sai');
    const p = profile({ Mirror: true });
    await mgr.executeSync(p.Id);

    fs.unlinkSync(path.join(src, 'sai.txt'));
    const r = await mgr.executeSync(p.Id);

    expect(r.success).to.equal(true);
    expect(fs.existsSync(path.join(dst, 'sai.txt'))).to.equal(false);
    expect(fs.existsSync(path.join(dst, 'fica.txt'))).to.equal(true);
    expect(r.results.some(x => x.op === 'delete' && x.rel === 'sai.txt' && x.success)).to.equal(true);
  });

  it('non-mirror mode leaves extra destination files alone', async () => {
    write(src, 'a.txt', 'aaa');
    const p = profile({ Mirror: false });
    await mgr.executeSync(p.Id);
    write(dst, 'extra.txt', 'sobrevivente');
    await mgr.executeSync(p.Id);
    expect(fs.existsSync(path.join(dst, 'extra.txt'))).to.equal(true);
  });

  it('reports failure when the source folder disappears', async () => {
    const gone = tmpDir('gone');
    fs.rmdirSync(gone);
    const p = profile({ SourcePath: gone });
    const r = await mgr.executeSync(p.Id);
    expect(r.success).to.equal(false);
    expect(r.message).to.be.a('string');
  });

  it('refuses a destination inside the source', async () => {
    const p = profile({ DestPath: path.join(src, 'dentro') });
    const r = await mgr.executeSync(p.Id);
    expect(r.success).to.equal(false);
    expect(r.message).to.include('destino');
  });

  it('returns failure for a profile id that does not exist', async () => {
    const r = await mgr.executeSync(crypto.randomUUID());
    expect(r.success).to.equal(false);
    expect(r.message).to.include('não encontrado');
  });

  it('honours excludes end to end', async () => {
    write(src, 'keep.txt', 'k');
    write(src, 'noise.log', 'n');
    const p = profile({ Excludes: ['*.log'] });
    const r = await mgr.executeSync(p.Id);
    expect(r.planned.copy.map(c => c.rel)).to.deep.equal(['keep.txt']);
    expect(fs.existsSync(path.join(dst, 'noise.log'))).to.equal(false);
  });

  it('writes history entries and stats for each run', async () => {
    write(src, 'a.txt', 'aaa');
    const p = profile();
    await mgr.executeSync(p.Id);

    const history = mgr.getHistory(p.Id);
    expect(history).to.have.lengthOf(1);
    expect(history[0].Status).to.equal('Success');
    expect(history[0].Copied).to.equal(1);

    const stats = mgr.getHistoryStats(p.Id);
    expect(stats.total).to.equal(1);
    expect(stats.success).to.equal(1);
    expect(stats.failed).to.equal(0);
    expect(stats.lastRun).to.be.a('string');
  });

  it('marks the profile LastRun/LastStatus after a run', async () => {
    write(src, 'a.txt', 'aaa');
    const p = profile();
    await mgr.executeSync(p.Id);
    const after = mgr.getProfile(p.Id);
    expect(after.LastRun).to.be.a('string');
    expect(after.LastStatus).to.equal('Success');
  });

  it('tracks the run in the run registry while executing', async () => {
    write(src, 'a.txt', 'aaa');
    const p = profile();
    const r = await mgr.executeSync(p.Id);
    expect(r.success).to.equal(true);
    // The run finished and was swept from active, but the registry saw it:
    // recent() keeps finished runs briefly for the UI.
    const recent = mgr.runs.recent();
    expect(recent.some(x => x.kind === 'sync' && x.name === p.Name)).to.equal(true);
  });

  it('does nothing successfully when source and destination already agree', async () => {
    write(src, 'a.txt', 'aaa');
    const p = profile();
    await mgr.executeSync(p.Id);
    const r = await mgr.executeSync(p.Id);
    expect(r.success).to.equal(true);
    expect(r.planned.copy).to.deep.equal([]);
    expect(r.planned.delete).to.deep.equal([]);
    expect(r.results).to.deep.equal([]);
  });
});

describe('SyncManager: task triggers', () => {
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

  const entry = (taskId, status) => ({
    Id: crypto.randomUUID(), TaskId: taskId, TaskName: 'Build',
    Timestamp: new Date().toISOString(), Status: status,
  });

  it('runs syncs attached to a task when the task succeeds', async () => {
    write(src, 'artefato.txt', 'build ok');
    const p = mgr.createProfile({ Name: 'Artefatos', SourcePath: src, DestPath: dst, TriggerTaskId: 'task-1', CronExpression: '' });

    const results = await mgr.handleTaskFinished(entry('task-1', 'Success'));
    expect(results).to.have.lengthOf(1);
    expect(results[0].success).to.equal(true);
    expect(fs.readFileSync(path.join(dst, 'artefato.txt'), 'utf8')).to.equal('build ok');
  });

  it('skips attached syncs when the task fails (default)', async () => {
    write(src, 'artefato.txt', 'build quebrado');
    mgr.createProfile({ Name: 'Artefatos', SourcePath: src, DestPath: dst, TriggerTaskId: 'task-1' });

    const results = await mgr.handleTaskFinished(entry('task-1', 'Error'));
    expect(results).to.deep.equal([]);
    expect(fs.existsSync(path.join(dst, 'artefato.txt'))).to.equal(false);
    expect(mgr.getHistory()).to.have.lengthOf(0);
  });

  it('runs on failure too when TriggerOnFailure is set', async () => {
    write(src, 'artefato.txt', 'logs do erro');
    mgr.createProfile({ Name: 'Logs de erro', SourcePath: src, DestPath: dst, TriggerTaskId: 'task-1', TriggerOnFailure: true });

    const results = await mgr.handleTaskFinished(entry('task-1', 'Error'));
    expect(results).to.have.lengthOf(1);
    expect(results[0].success).to.equal(true);
  });

  it('ignores tasks with no sync attached', async () => {
    const results = await mgr.handleTaskFinished(entry('task-outro', 'Success'));
    expect(results).to.deep.equal([]);
  });

  it('skips disabled attached syncs', async () => {
    write(src, 'a.txt', 'aaa');
    mgr.createProfile({ Name: 'Off', SourcePath: src, DestPath: dst, TriggerTaskId: 'task-1', Enabled: false });
    const results = await mgr.handleTaskFinished(entry('task-1', 'Success'));
    expect(results).to.deep.equal([]);
  });

  it('keeps cron as a secondary schedule for task-triggered syncs', () => {
    mgr.createProfile({ Name: 'Por cron', SourcePath: src, DestPath: dst, CronExpression: '0 2 * * *' });
    mgr.createProfile({ Name: 'Por task + cron', SourcePath: src, DestPath: dst, CronExpression: '0 3 * * *', TriggerTaskId: 't1' });

    const due = mgr.getDueProfiles();
    expect(due.map(p => p.Name)).to.deep.equal(['Por cron', 'Por task + cron']);
  });

  it('maybeTriggerForTask fires the hook only when a sync is attached', async () => {
    write(src, 'a.txt', 'aaa');
    mgr.createProfile({ Name: 'Anexado', SourcePath: src, DestPath: dst, TriggerTaskId: 'task-1' });

    let fired = 0;
    mgr.onTaskFinished = async () => { fired++; };
    mgr.maybeTriggerForTask(entry('task-1', 'Success'));
    mgr.maybeTriggerForTask(entry('task-outro', 'Success'));
    // The hook is async; give the microtask queue a beat.
    await new Promise(r => setTimeout(r, 20));
    expect(fired).to.equal(1);
  });
});

describe('SyncManager: reload across processes', () => {
  it('picks up profiles created by another manager while running (service/GUI)', () => {
    const cfg = fakeConfig();
    // The service starts first, with nothing on disk.
    const service = new SyncManager(cfg, fakeLogger(), null);
    expect(service.getAllProfiles()).to.have.lengthOf(0);

    // The GUI saves a profile afterwards, sharing the data directory.
    const gui = new SyncManager(cfg, fakeLogger(), null);
    gui.createProfile({ Name: 'Do GUI', SourcePath: 'C:/a', DestPath: 'D:/b', CronExpression: '0 3 * * *' });

    // The running service does not see it until its scheduler tick reloads.
    expect(service.getAllProfiles()).to.have.lengthOf(0);
    service.reload();
    expect(service.getAllProfiles()).to.have.lengthOf(1);
    expect(service.getDueProfiles()).to.have.lengthOf(1);
    cfg.dispose();
  });
});

// ─── Whole-sync simulator (previewSyncPlan) ───
describe('SyncManager: previewSyncPlan (dry-run simulator)', () => {
  let mgr, src, dst;
  beforeEach(() => {
    mgr = newManager();
    src = tmpDir('sim-src');
    dst = tmpDir('sim-dst');
  });
  afterEach(() => {
    mgr.config.dispose();
    try { fs.rmSync(src, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(dst, { recursive: true, force: true }); } catch (e) {}
  });

  it('lists which files would be copied, skipped and removed — writing nothing', () => {
    write(src, 'keep.txt', 'same');
    write(src, 'new.txt', 'brand new');
    write(dst, 'keep.txt', 'same');
    write(dst, 'gone.txt', 'doomed by mirror');

    const out = mgr.previewSyncPlan({
      SourcePath: src, DestPath: dst, Engine: 'local',
      Mode: 'incremental', Mirror: true, Excludes: [],
      Retention: { Enabled: false },
    });

    return out.then(r => {
      expect(r.ok).to.equal(true);
      const copyRels = r.copy.map(f => f.rel);
      expect(copyRels).to.include('new.txt');
      expect(copyRels).to.not.include('keep.txt');
      expect(r.skipped.map(f => f.rel)).to.include('keep.txt');
      expect(r.delete.map(f => f.rel)).to.include('gone.txt');
      expect(r.retention).to.have.lengthOf(0);
      // The simulator must not touch the disk: the doomed file is still there
      // and the copy never happened.
      expect(fs.existsSync(path.join(dst, 'gone.txt'))).to.equal(true);
      expect(fs.existsSync(path.join(dst, 'new.txt'))).to.equal(false);
    });
  });

  it('simulates retention over the destination as it would be AFTER the copy', () => {
    // A fresh file at the source with a dated name: after the first sync it
    // would exist on the destination and be safe; an old dated file already
    // there would be evicted by the age rule.
    retention_day_setup(src, dst);

    return mgr.previewSyncPlan({
      SourcePath: src, DestPath: dst, Engine: 'local',
      Mode: 'incremental', Mirror: false, Excludes: [],
      Retention: { Enabled: true, FileExtensions: [], ByAge: true, KeepDays: 10, ByCount: false, BySize: false, MinKeep: 0 },
    }).then(r => {
      expect(r.ok).to.equal(true);
      expect(r.retention.map(f => f.rel)).to.include('2020-01-01/old.sql');
      expect(r.retention.map(f => f.rel)).to.not.include('2026-09-01/fresh.sql');
      expect(r.retentionDeletedBytes).to.be.above(0);
      // Nothing was deleted on disk.
      expect(fs.existsSync(path.join(dst, '2020-01-01', 'old.sql'))).to.equal(true);
    });
  });

  it('rejects an impossible source without throwing', () => {
    return mgr.previewSyncPlan({
      SourcePath: path.join(src, 'nao-existe'), DestPath: dst, Engine: 'local',
    }).then(r => {
      expect(r.ok).to.equal(false);
      expect(r.error).to.be.a('string');
    });
  });

  it('rejects a destination inside the source', () => {
    return mgr.previewSyncPlan({
      SourcePath: src, DestPath: path.join(src, 'dentro'), Engine: 'local',
    }).then(r => {
      expect(r.ok).to.equal(false);
      expect(r.error).to.be.a('string');
    });
  });

  // Helper: dated content on both sides, the old one only on the destination.
  function retention_day_setup(src, dst) {
    write(src, '2026-09-01/fresh.sql', 'fresh');
    write(dst, '2026-09-01/fresh.sql', 'stale copy');
    const oldDir = path.join(dst, '2020-01-01');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'old.sql'), 'ancient');
    const t = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(oldDir, 'old.sql'), t, t);
  }
});

// ─── Standalone retention runner (Retention screen engine) ───
describe('SyncManager: runRetentionNow', () => {
  let mgr, dir;
  beforeEach(() => { mgr = newManager(); dir = tmpDir('retenow'); });
  afterEach(() => {
    mgr.config.dispose();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  });

  it('deletes old dated snapshots and frees space, with audit trail', () => {
    const oldDir = path.join(dir, '2020-06-01');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'dump.sql'), 'x'.repeat(1000));
    const t = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(oldDir, 'dump.sql'), t, t);
    write(dir, '2026-09-01/fresh.sql', 'new');

    return mgr.runRetentionNow(dir, { Enabled: true, FileExtensions: [], ByAge: true, KeepDays: 365, ByCount: false, BySize: false, MinKeep: 0 }).then(r => {
      expect(r.ok).to.equal(true);
      expect(r.deleted).to.equal(1);
      expect(r.freed).to.equal(1000);
      expect(mgr.logger.audits.includes('RETENTION_FILE_DELETED')).to.equal(true);
      // Empty dated folder pruned by the local engine.
      expect(fs.existsSync(oldDir)).to.equal(false);
      expect(fs.existsSync(path.join(dir, '2026-09-01', 'fresh.sql'))).to.equal(true);
    });
  });

  it('refuses policies without criteria instead of deleting anything', () => {
    return mgr.runRetentionNow(dir, { Enabled: true }).then(r => {
      expect(r.ok).to.equal(false);
      expect(r.error).to.be.a('string');
      expect(fs.readdirSync(dir)).to.have.lengthOf(0);
    });
  });

  it('returns ok with zero deletions on an empty/missing folder', () => {
    return Promise.all([
      mgr.runRetentionNow(dir, { Enabled: true, ByAge: true, KeepDays: 1, MinKeep: 0 }),
      mgr.runRetentionNow('', null),
    ]).then(([empty, missing]) => {
      expect(empty.ok).to.equal(true);
      expect(empty.deleted).to.equal(0);
      expect(missing.ok).to.equal(false);
    });
  });
});
