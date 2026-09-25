const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const RetentionManager = require('../src/main/retentionManager');
const SyncManager = require('../src/main/sync/syncManager');
const CronParser = require('../src/main/cronParser');
const { SchedulerCore } = require('../src/main/schedulerCore');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kyrios-retention-${label}-`));
}

function fakeLogger() {
  return {
    logs: [],
    audits: [],
    log(level, message) { this.logs.push([level, message]); },
    error(message, error) { this.logs.push(['ERROR', error || message]); },
    audit(action, details) { this.audits.push({ action, details }); },
  };
}

function makeManager(syncManager, root) {
  return new RetentionManager({
    syncManager,
    cronParser: new CronParser(),
    logger: fakeLogger(),
    configDir: path.join(root, 'config'),
  });
}

function validData(root, overrides = {}) {
  return {
    Name: 'Arquivos antigos',
    FolderPath: root,
    Retention: { Enabled: true, ByAge: true, KeepDays: 30, MinKeep: 1 },
    CronExpression: '0 2 * * *',
    ...overrides,
  };
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`child exited ${code}: ${stderr}`));
    });
  });
}

describe('RetentionManager: scheduled profile persistence and CRUD', () => {
  let root;
  beforeEach(() => { root = tmpDir('manager'); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) {} });

  it('creates UUID profiles in retention-profiles.json and reloads them', () => {
    const manager = makeManager(null, root);
    const profile = manager.createProfile(validData(root));

    expect(profile.Id).to.match(RetentionManager.UUID_RE);
    expect(profile.Name).to.equal('Arquivos antigos');
    expect(profile.Retention).to.include({ Enabled: true, ByAge: true, KeepDays: 30, MinKeep: 1 });
    expect(fs.existsSync(path.join(root, 'config', 'retention-profiles.json'))).to.equal(true);

    const service = makeManager(null, root);
    expect(service.getProfile(profile.Id)).to.include({ Id: profile.Id, Name: profile.Name });
  });

  it('normalizes a missing retention policy and trims profile fields', () => {
    const manager = makeManager(null, root);
    const profile = manager.createProfile({
      Name: '  Arquivos  ', FolderPath: root, CronExpression: '  15   3 * * 1-5 ', Retention: undefined,
    });
    expect(profile.Name).to.equal('Arquivos');
    expect(profile.CronExpression).to.equal('15 3 * * 1-5');
    expect(profile.Retention).to.include({ Enabled: false, DateSource: 'metadata', KeepDays: 30, MinKeep: 3 });
  });

  it('updates and deletes profiles without changing their UUID', () => {
    const manager = makeManager(null, root);
    const profile = manager.createProfile(validData(root));
    const updated = manager.updateProfile({
      Id: profile.Id,
      Name: 'Retenção mensal',
      FolderPath: root,
      Retention: { Enabled: true, ByCount: true, KeepCount: 5, MinKeep: 0 },
      CronExpression: '30 1 * * *',
    });

    expect(updated.Id).to.equal(profile.Id);
    expect(updated.Name).to.equal('Retenção mensal');
    expect(updated.Retention.KeepCount).to.equal(5);
    expect(manager.deleteProfile(profile.Id)).to.equal(true);
    expect(manager.getProfile(profile.Id)).to.equal(null);
    expect(manager.deleteProfile(profile.Id)).to.equal(false);
  });

  it('validates name, folder, retention and five-field cron', () => {
    const manager = makeManager(null, root);
    expect(() => manager.createProfile(validData(root, { Name: ' ' }))).to.throw('Nome');
    expect(() => manager.createProfile(validData(root, { FolderPath: 'relative/path' }))).to.throw('absoluto');
    expect(() => manager.createProfile(validData(root, { FolderPath: path.join(root, 'missing') }))).to.throw('não existe');

    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'x');
    expect(() => manager.createProfile(validData(root, { FolderPath: file }))).to.throw('diretório');
    expect(() => manager.createProfile(validData(root, { CronExpression: '0 2 * *' }))).to.throw('cinco campos');
    expect(() => manager.createProfile(validData(root, {
      Retention: { Enabled: true, ByAge: false, MinKeep: 0 },
    }))).to.throw('nenhum critério');
  });

  it('returns only enabled profiles with a schedule as due', () => {
    const manager = makeManager(null, root);
    manager.createProfile(validData(root, { Name: 'Ativo' }));
    manager.createProfile(validData(root, { Name: 'Desativado', Enabled: false }));
    expect(manager.getDueProfiles().map(profile => profile.Name)).to.deep.equal(['Ativo']);
  });
});

describe('RetentionManager: execution delegates to manual retention', () => {
  let root;
  beforeEach(() => { root = tmpDir('execution'); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) {} });

  it('passes folder and normalized retention to runRetentionNow and stores Success', async () => {
    const calls = [];
    const syncManager = {
      runRetentionNow(folder, retentionCfg) {
        calls.push({ folder, retentionCfg });
        return { ok: true, deleted: 2, freed: 10, planned: 2, failed: [] };
      },
    };
    const manager = makeManager(syncManager, root);
    const profile = manager.createProfile(validData(root));
    const result = await manager.runProfile(profile.Id);

    expect(result.ok).to.equal(true);
    expect(calls).to.have.lengthOf(1);
    expect(calls[0].folder).to.equal(root);
    expect(calls[0].retentionCfg).to.deep.equal(profile.Retention);
    expect(manager.getProfile(profile.Id)).to.include({ LastStatus: 'Success' });
    expect(manager.getProfile(profile.Id).LastResult.deleted).to.equal(2);
  });

  it('uses the real manual retention flow to delete aged content', async () => {
    const syncManager = new SyncManager({ configDir: path.join(root, 'sync-config') }, fakeLogger(), null);
    const manager = makeManager(syncManager, root);
    const oldFile = path.join(root, 'old.7z');
    fs.writeFileSync(oldFile, 'old');
    const oldTime = new Date(Date.now() - 40 * 86400000);
    fs.utimesSync(oldFile, oldTime, oldTime);
    const profile = manager.createProfile(validData(root, {
      Retention: { Enabled: true, ByAge: true, KeepDays: 7, MinKeep: 0 },
    }));

    const result = await manager.runProfile(profile.Id);
    expect(result.ok).to.equal(true);
    expect(result.deleted).to.equal(1);
    expect(fs.existsSync(oldFile)).to.equal(false);
    expect(manager.getProfile(profile.Id).LastStatus).to.equal('Success');
  });

  it('stores Partial when deletion reports failures', async () => {
    const syncManager = { runRetentionNow: async () => ({ ok: true, deleted: 1, planned: 2, failed: [{ rel: 'locked.db', message: 'locked' }] }) };
    const manager = makeManager(syncManager, root);
    const profile = manager.createProfile(validData(root));
    await manager.runProfile(profile.Id);
    expect(manager.getProfile(profile.Id).LastStatus).to.equal('Partial');
  });

  it('stores Error for an engine error or exception', async () => {
    const syncManager = { runRetentionNow: async () => { throw new Error('engine failed'); } };
    const manager = makeManager(syncManager, root);
    const profile = manager.createProfile(validData(root));
    const result = await manager.runProfile(profile.Id);

    expect(result).to.include({ ok: false, error: 'engine failed' });
    expect(manager.getProfile(profile.Id).LastStatus).to.equal('Error');
  });

  it('preserves execution metadata when the profile is updated', async () => {
    const syncManager = { runRetentionNow: async () => ({ ok: true, deleted: 1, planned: 1, failed: [] }) };
    const manager = makeManager(syncManager, root);
    const profile = manager.createProfile(validData(root));
    await manager.runProfile(profile.Id);
    const before = manager.getProfile(profile.Id);
    const updated = manager.updateProfile({
      Id: profile.Id, Name: 'Renomeado', FolderPath: root,
      Retention: before.Retention, CronExpression: before.CronExpression,
      LastRun: null, LastStatus: 'Error', LastResult: { forced: true },
    });

    expect(updated.LastRun).to.equal(before.LastRun);
    expect(updated.LastStatus).to.equal('Success');
    expect(updated.LastResult).to.deep.equal(before.LastResult);
  });

  it('accepts only an ID and prevents concurrent execution of the same profile', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const syncManager = { runRetentionNow: () => pending };
    const manager = makeManager(syncManager, root);
    const otherManager = makeManager(syncManager, root);
    const profile = manager.createProfile(validData(root));
    const first = manager.runProfile(profile.Id);
    otherManager.reload();
    const second = await otherManager.runProfile(profile.Id);

    expect(second.error).to.include('já está em execução');
    finish({ ok: true, deleted: 0, planned: 0, failed: [] });
    expect((await first).ok).to.equal(true);
    expect((await manager.runProfile({ Id: profile.Id })).ok).to.equal(false);
  });

  it('prevents concurrent executions from different profiles on the same folder', async () => {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const syncManager = { runRetentionNow: () => pending };
    const manager = makeManager(syncManager, root);
    const firstProfile = manager.createProfile(validData(root, { Name: 'Perfil A' }));
    const secondProfile = manager.createProfile(validData(root, { Name: 'Perfil B' }));
    const first = manager.runProfile(firstProfile.Id);
    const second = await manager.runProfile(secondProfile.Id);

    expect(second.error).to.include('já está em execução');
    finish({ ok: true, deleted: 0, planned: 0, failed: [] });
    expect((await first).ok).to.equal(true);
  });
});

describe('RetentionManager: cross-process locked writes', () => {
  let root;
  beforeEach(() => { root = tmpDir('locking'); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (err) {} });

  it('keeps both profiles when two processes create at the same time', async () => {
    const configDir = path.join(root, 'config');
    const managerPath = path.resolve(__dirname, '..', 'src', 'main', 'retentionManager.js');
    const cronPath = path.resolve(__dirname, '..', 'src', 'main', 'cronParser.js');
    const script = `
      const RetentionManager = require(process.argv[1]);
      const CronParser = require(process.argv[2]);
      const manager = new RetentionManager({
        configDir: process.argv[3],
        cronParser: new CronParser(),
        syncManager: null,
        logger: null
      });
      manager.createProfile({
        Name: process.argv[5],
        FolderPath: process.argv[4],
        Retention: { Enabled: true, ByAge: true, KeepDays: 10, MinKeep: 0 },
        CronExpression: '0 1 * * *'
      });
    `;
    const args = [managerPath, cronPath, configDir, root];
    const children = ['Processo A', 'Processo B'].map(name => spawn(process.execPath, ['-e', script, ...args, name], { cwd: path.resolve(__dirname, '..') }));
    await Promise.all(children.map(waitForChild));

    const profiles = makeManager(null, root).getAllProfiles();
    expect(profiles.map(profile => profile.Name).sort()).to.deep.equal(['Processo A', 'Processo B']);
    expect(fs.readdirSync(configDir).some(file => file.endsWith('.tmp'))).to.equal(false);
    expect(fs.existsSync(`${path.join(configDir, 'retention-profiles.json')}.lock`)).to.equal(false);
  });
});

describe('SchedulerCore: retention profiles', () => {
  function logger() {
    return { log() {}, error() {} };
  }

  it('reloads, runs due profiles with the guard, and releases it in finally', async () => {
    let reloads = 0;
    let runs = 0;
    const profile = { Id: 'b82b06d9-f0d7-4a1a-9d0f-1c778a2b1a11', Name: 'Diária', CronExpression: '* * * * *', LastRun: null };
    const retentionManager = {
      reload() { reloads++; },
      getDueProfiles() { return [profile]; },
      getProfile() { return { LastStatus: 'Success' }; },
      async runProfile() { runs++; return { ok: true }; },
    };
    const scheduler = new SchedulerCore({
      taskManager: { getDueTasks: () => [] },
      backupManager: null,
      retentionManager,
      cronParser: { shouldRunNow: () => true },
      logger: logger(),
    }, 'service');

    scheduler.reload();
    scheduler.runDueRetentionProfiles();
    scheduler.runDueRetentionProfiles();
    await new Promise(resolve => setImmediate(resolve));

    expect(reloads).to.equal(1);
    expect(runs).to.equal(1);
    expect(scheduler.running.size).to.equal(0);
  });

  it('releases the in-process guard when runProfile rejects', async () => {
    const profile = { Id: '4e96b0dc-70f0-47a1-8b41-d10b184ef1fc', Name: 'Falha', CronExpression: '* * * * *', LastRun: null };
    const scheduler = new SchedulerCore({
      taskManager: { getDueTasks: () => [] },
      backupManager: null,
      retentionManager: {
        getDueProfiles: () => [profile],
        getProfile: () => null,
        runProfile: async () => { throw new Error('failed'); },
      },
      cronParser: { shouldRunNow: () => true },
      logger: logger(),
    }, 'service');

    scheduler.runDueRetentionProfiles();
    await new Promise(resolve => setImmediate(resolve));
    expect(scheduler.running.has(`retention:${profile.Id}`)).to.equal(false);
  });
});

describe('RetentionManager: desktop and service wiring', () => {
  it('exposes CRUD and ID-only execution through the desktop IPC bridge', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
    expect(mainSource).to.include("ipcMain.handle('run-retention-profile', (e, id) => retentionManager.runProfile(id))");
    expect(preloadSource).to.include("runRetentionProfile: (id) => ipcRenderer.invoke('run-retention-profile', id)");
    for (const channel of ['get-retention-profiles', 'create-retention-profile', 'update-retention-profile', 'delete-retention-profile']) {
      expect(mainSource).to.include(`ipcMain.handle('${channel}'`);
      expect(preloadSource).to.include(channel);
    }
  });

  it('constructs the same manager in the GUI and headless service', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    const serviceSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'serviceScheduler.js'), 'utf8');
    expect(mainSource).to.include('new RetentionManager({ syncManager, cronParser, logger })');
    expect(serviceSource).to.include('new RetentionManager({ syncManager, cronParser, logger })');
    expect(serviceSource).to.include('retentionManager, cronParser');
  });
});
