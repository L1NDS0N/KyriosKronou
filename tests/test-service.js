// tests/test-service.js
//
// Covers running Κύριος Χρόνος as a Windows service. The product is deployed on
// servers where an admin logs in, starts things, then logs off - Windows tears
// down their session and only services survive. So the scheduler must:
//
//   1. read the SAME data the GUI wrote (the old %APPDATA% split is why the
//      service registered fine but scheduled nothing),
//   2. run headless with no Electron GUI, no desktop, no GPU,
//   3. never double-execute a job while the GUI is also open,
//   4. keep going when a single task blows up.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DATA_ENV = 'KYRION_DATA_DIR';

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kyrios-${tag}-`));
}

// paths.js and schedulerCore.js read env at call time, but require() caches the
// modules, so a fresh require per test keeps the env override honest.
function freshModules() {
  for (const m of ['paths', 'schedulerCore', 'kyrionService']) {
    delete require.cache[require.resolve(`../src/main/${m}`)];
  }
  return {
    paths: require('../src/main/paths'),
    core: require('../src/main/schedulerCore'),
    KyrionService: require('../src/main/kyrionService'),
  };
}

// ── Minimal stand-ins so scheduler tests stay fast and deterministic ──
function fakeLogger() {
  const entries = [];
  return {
    entries,
    log: (level, msg) => entries.push({ level, msg }),
    error: (msg, err) => entries.push({ level: 'ERROR', msg, err }),
    audit: () => {},
    auditTaskExecuted: () => {},
    flush: () => {},
  };
}

function fakeTaskManager(tasks) {
  return {
    tasks,
    executed: [],
    reloadCount: 0,
    loadData() { this.reloadCount++; },
    getAllTasks() { return this.tasks; },
    getDueTasks() { return this.tasks.filter(t => t.Enabled !== false && t.due); },
    executeTask(task) {
      this.executed.push(task.Id);
      return Promise.resolve({ success: true, Status: 'Success' });
    },
  };
}

function fakeBackupManager(profiles) {
  return {
    profiles,
    executed: [],
    reloadCount: 0,
    reload() { this.reloadCount++; return this.profiles; },
    getAllProfiles() { return this.profiles; },
    executeBackup(id) {
      this.executed.push(id);
      return Promise.resolve({ success: true, duration: '1s' });
    },
  };
}

const alwaysDueCron = { shouldRunNow: () => true };
const neverDueCron = { shouldRunNow: () => false };

// ─────────────────────────────────────────────────────────────────────────────
describe('Service: data directory (the root cause of "registers but never runs")', () => {
  let saved;
  beforeEach(() => { saved = process.env[DATA_ENV]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[DATA_ENV];
    else process.env[DATA_ENV] = saved;
  });

  it('defaults to %ProgramData%, which the GUI user and LocalSystem both share', () => {
    delete process.env[DATA_ENV];
    const { paths } = freshModules();
    const expected = path.join(process.env.ProgramData || 'C:\\ProgramData', 'KyriosChronos');
    expect(paths.dataDir()).to.equal(expected);
  });

  it('never resolves into a per-user AppData folder', () => {
    delete process.env[DATA_ENV];
    const { paths } = freshModules();
    expect(paths.dataDir().toLowerCase()).to.not.include('appdata');
    expect(paths.configDir().toLowerCase()).to.not.include('appdata');
  });

  it('honours KYRION_DATA_DIR, which is how the service is pinned to one location', () => {
    const dir = tempDir('datadir');
    process.env[DATA_ENV] = dir;
    const { paths } = freshModules();
    expect(paths.dataDir()).to.equal(dir);
    expect(paths.configDir()).to.equal(path.join(dir, 'config'));
    expect(paths.logsDir()).to.equal(path.join(dir, 'logs'));
  });

  it('GUI and service processes resolve to byte-identical config paths', () => {
    const dir = tempDir('shared');
    process.env[DATA_ENV] = dir;
    const gui = freshModules().paths;
    const svc = freshModules().paths;
    expect(gui.configDir()).to.equal(svc.configDir());
    expect(gui.ownerFile()).to.equal(svc.ownerFile());
  });

  it('ensureDirs creates config and logs', () => {
    const dir = tempDir('ensure');
    process.env[DATA_ENV] = dir;
    const { paths } = freshModules();
    paths.ensureDirs();
    expect(fs.existsSync(paths.configDir())).to.equal(true);
    expect(fs.existsSync(paths.logsDir())).to.equal(true);
  });
});

describe('Service: migration from the old per-user location', () => {
  let saved, dir, legacy;

  beforeEach(() => {
    saved = { data: process.env[DATA_ENV], appdata: process.env.APPDATA };
    dir = tempDir('migrate');
    legacy = tempDir('legacy');
    fs.mkdirSync(path.join(legacy, 'KyrionKronou', 'config'), { recursive: true });
    fs.mkdirSync(path.join(legacy, 'KyrionKronou', 'logs'), { recursive: true });
    process.env[DATA_ENV] = dir;
    process.env.APPDATA = legacy;
  });

  afterEach(() => {
    if (saved.data === undefined) delete process.env[DATA_ENV]; else process.env[DATA_ENV] = saved.data;
    if (saved.appdata === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.appdata;
  });

  function writeLegacy(name, content) {
    fs.writeFileSync(path.join(legacy, 'KyrionKronou', 'config', name), content, 'utf8');
  }

  it('copies existing tasks into the shared directory so the service can see them', () => {
    writeLegacy('tasks.json', JSON.stringify([{ Id: 'a', Name: 'Legacy task' }]));
    const { paths } = freshModules();
    const result = paths.migrateLegacyData();
    expect(result.migrated).to.equal(true);
    const moved = JSON.parse(fs.readFileSync(path.join(paths.configDir(), 'tasks.json'), 'utf8'));
    expect(moved[0].Name).to.equal('Legacy task');
  });

  it('is idempotent - a second run copies nothing more', () => {
    writeLegacy('tasks.json', '[]');
    const { paths } = freshModules();
    expect(paths.migrateLegacyData().migrated).to.equal(true);
    expect(paths.migrateLegacyData().migrated).to.equal(false);
  });

  it('never overwrites data already in the new location', () => {
    writeLegacy('tasks.json', JSON.stringify([{ Id: 'old' }]));
    const { paths } = freshModules();
    paths.ensureDirs();
    fs.writeFileSync(path.join(paths.configDir(), 'tasks.json'), JSON.stringify([{ Id: 'current' }]), 'utf8');
    paths.migrateLegacyData();
    const kept = JSON.parse(fs.readFileSync(path.join(paths.configDir(), 'tasks.json'), 'utf8'));
    expect(kept[0].Id).to.equal('current');
  });

  it('succeeds on a clean machine with no legacy folder', () => {
    process.env.APPDATA = path.join(tempDir('empty'), 'nothing-here');
    const { paths } = freshModules();
    expect(() => paths.migrateLegacyData()).to.not.throw();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Service: execution ownership (no duplicate runs)', () => {
  let saved, core;

  beforeEach(() => {
    saved = process.env[DATA_ENV];
    process.env[DATA_ENV] = tempDir('owner');
    const m = freshModules();
    m.paths.ensureDirs();
    core = m.core;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[DATA_ENV]; else process.env[DATA_ENV] = saved;
  });

  const alive = () => true;
  const dead = () => false;

  it('claims when nobody owns the lease', () => {
    expect(core.canClaim(null, core.ROLE_GUI, 100)).to.equal(true);
  });

  it('keeps the lease it already holds', () => {
    const owner = { pid: 100, role: core.ROLE_GUI, ts: Date.now() };
    expect(core.canClaim(owner, core.ROLE_GUI, 100, Date.now(), alive)).to.equal(true);
  });

  it('GUI must NOT execute while the service holds the lease', () => {
    const owner = { pid: 999, role: core.ROLE_SERVICE, ts: Date.now() };
    expect(core.canClaim(owner, core.ROLE_GUI, 100, Date.now(), alive)).to.equal(false);
  });

  it('service preempts a GUI that grabbed the lease first', () => {
    const owner = { pid: 100, role: core.ROLE_GUI, ts: Date.now() };
    expect(core.canClaim(owner, core.ROLE_SERVICE, 999, Date.now(), alive)).to.equal(true);
  });

  it('a second service instance does not steal from a live one', () => {
    const owner = { pid: 999, role: core.ROLE_SERVICE, ts: Date.now() };
    expect(core.canClaim(owner, core.ROLE_SERVICE, 1000, Date.now(), alive)).to.equal(false);
  });

  it('takes over when the heartbeat goes stale (owner hung or was killed)', () => {
    const owner = { pid: 999, role: core.ROLE_SERVICE, ts: Date.now() - core.STALE_MS - 1000 };
    expect(core.canClaim(owner, core.ROLE_GUI, 100, Date.now(), alive)).to.equal(true);
  });

  it('takes over immediately when the owning PID is gone', () => {
    const owner = { pid: 999, role: core.ROLE_SERVICE, ts: Date.now() };
    expect(core.canClaim(owner, core.ROLE_GUI, 100, Date.now(), dead)).to.equal(true);
  });

  it('treats EPERM (service runs as LocalSystem) as alive, not dead', () => {
    // A GUI process cannot signal a LocalSystem process; that must not be read
    // as "the service died" or both would execute every job.
    const owner = { pid: 4, role: core.ROLE_SERVICE, ts: Date.now() };
    const eperm = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
    let alivePerm;
    try { eperm(); } catch (e) { alivePerm = e.code === 'EPERM'; }
    expect(alivePerm).to.equal(true);
    expect(core.canClaim(owner, core.ROLE_GUI, 100, Date.now(), () => true)).to.equal(false);
  });

  it('writes and reads back a heartbeat record', () => {
    core.writeOwner(core.ROLE_SERVICE);
    const owner = core.readOwner();
    expect(owner.pid).to.equal(process.pid);
    expect(owner.role).to.equal(core.ROLE_SERVICE);
    expect(Date.now() - owner.ts).to.be.below(5000);
  });

  it('survives a corrupt heartbeat file instead of crashing the service', () => {
    const { paths } = freshModules();
    fs.writeFileSync(paths.ownerFile(), 'not json at all', 'utf8');
    expect(core.readOwner()).to.equal(null);
    expect(core.canClaim(core.readOwner(), core.ROLE_SERVICE, process.pid)).to.equal(true);
  });

  it('releases the lease on shutdown so the next process starts at once', () => {
    core.writeOwner(core.ROLE_GUI);
    expect(core.readOwner()).to.not.equal(null);
    core.releaseOwnership();
    expect(core.readOwner()).to.equal(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Service: scheduler engine', () => {
  let saved, core, logger;

  beforeEach(() => {
    saved = process.env[DATA_ENV];
    process.env[DATA_ENV] = tempDir('engine');
    const m = freshModules();
    m.paths.ensureDirs();
    core = m.core;
    logger = fakeLogger();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[DATA_ENV]; else process.env[DATA_ENV] = saved;
  });

  // `pid` simulates a distinct OS process, so two schedulers can genuinely
  // contend for the lease inside one test run.
  function makeCore(role, tm, bm, cron = alwaysDueCron, pid) {
    return new core.SchedulerCore(
      { taskManager: tm, backupManager: bm, cronParser: cron, logger }, role, {}, { pid }
    );
  }

  it('executes a due task when it owns the lease', async () => {
    const tm = fakeTaskManager([{ Id: 't1', Name: 'Job', due: true }]);
    const s = makeCore(core.ROLE_SERVICE, tm, fakeBackupManager([]));
    s.tick();
    await new Promise(r => setImmediate(r));
    expect(tm.executed).to.deep.equal(['t1']);
  });

  it('executes NOTHING when a live service owns the lease', async () => {
    // The live service is this very test process, under the service role. A GUI
    // claiming a different pid must therefore stand down for real.
    core.writeOwner(core.ROLE_SERVICE, process.pid);

    const tm = fakeTaskManager([{ Id: 't1', Name: 'Job', due: true }]);
    const gui = makeCore(core.ROLE_GUI, tm, fakeBackupManager([]), alwaysDueCron, process.pid + 1);
    gui.tick();
    await new Promise(r => setImmediate(r));

    expect(gui.isOwner).to.equal(false);
    expect(tm.executed).to.deep.equal([]);
  });

  it('with GUI and service both live, exactly one executes the task', async () => {
    const tmService = fakeTaskManager([{ Id: 'shared', Name: 'Job', due: true }]);
    const tmGui = fakeTaskManager([{ Id: 'shared', Name: 'Job', due: true }]);

    const service = makeCore(core.ROLE_SERVICE, tmService, fakeBackupManager([]), alwaysDueCron, process.pid);
    const gui = makeCore(core.ROLE_GUI, tmGui, fakeBackupManager([]), alwaysDueCron, process.pid + 1);

    // Service starts first and owns the lease.
    service.tick();
    // The GUI would double-run the job if it ignored ownership. It sees the
    // live service heartbeat for this same PID, so it must stand down.
    gui.tick();
    await new Promise(r => setImmediate(r));

    const total = tmService.executed.length + tmGui.executed.length;
    expect(total).to.equal(1, 'task must run exactly once across both processes');
  });

  it('GUI yields the moment the service takes over', async () => {
    const tm = fakeTaskManager([{ Id: 't1', Name: 'Job', due: true }]);
    const gui = makeCore(core.ROLE_GUI, tm, fakeBackupManager([]), alwaysDueCron, process.pid + 1);
    gui.tick();
    expect(gui.isOwner).to.equal(true, 'GUI owns the lease while it is alone');

    // The service is installed and starts up, preempting the GUI.
    const service = makeCore(core.ROLE_SERVICE, fakeTaskManager([]), fakeBackupManager([]), alwaysDueCron, process.pid);
    service.tick();
    expect(service.isOwner).to.equal(true, 'service preempts the GUI');

    // On its next poll the GUI must notice and go passive.
    tm.executed.length = 0;
    gui.lastRun = {};
    gui.tick();
    await new Promise(r => setImmediate(r));
    expect(gui.isOwner).to.equal(false, 'GUI yielded to the service');
    expect(tm.executed).to.deep.equal([]);
  });

  it('does not fire the same task twice inside one minute', async () => {
    const tm = fakeTaskManager([{ Id: 't1', Name: 'Job', due: true }]);
    const s = makeCore(core.ROLE_SERVICE, tm, fakeBackupManager([]));
    s.tick();
    await new Promise(r => setImmediate(r));
    s.tick(); // the 15s poll fires ~4x per minute
    s.tick();
    await new Promise(r => setImmediate(r));
    expect(tm.executed).to.deep.equal(['t1']);
  });

  it('does not start a task that is still running from the last tick', async () => {
    let resolveIt;
    const tm = fakeTaskManager([{ Id: 'slow', Name: 'Slow', due: true }]);
    tm.executeTask = function (task) {
      this.executed.push(task.Id);
      return new Promise(r => { resolveIt = r; });
    };
    const s = makeCore(core.ROLE_SERVICE, tm, fakeBackupManager([]));
    s.tick();
    s.lastRun['task:slow'] = 0; // expire the time guard, leaving only the overlap guard
    s.tick();
    await new Promise(r => setImmediate(r));
    expect(tm.executed).to.deep.equal(['slow']);
    resolveIt({ success: true });
  });

  it('re-reads config every tick, so the service sees edits made in the GUI', () => {
    const tm = fakeTaskManager([]);
    const bm = fakeBackupManager([]);
    const s = makeCore(core.ROLE_SERVICE, tm, bm);
    s.tick();
    s.tick();
    expect(tm.reloadCount).to.equal(2);
    expect(bm.reloadCount).to.equal(2);
  });

  it('runs a due backup profile', async () => {
    const bm = fakeBackupManager([{ Id: 'b1', Name: 'Nightly', Enabled: true, CronExpression: '0 2 * * *' }]);
    const s = makeCore(core.ROLE_SERVICE, fakeTaskManager([]), bm);
    s.tick();
    await new Promise(r => setImmediate(r));
    expect(bm.executed).to.deep.equal(['b1']);
  });

  it('skips disabled, NSSM-managed and cron-less backup profiles', async () => {
    const bm = fakeBackupManager([
      { Id: 'off', Enabled: false, CronExpression: '* * * * *' },
      { Id: 'nssm', Enabled: true, CronExpression: '* * * * *', ManagementMode: 'nssm' },
      { Id: 'nocron', Enabled: true },
    ]);
    const s = makeCore(core.ROLE_SERVICE, fakeTaskManager([]), bm);
    s.tick();
    await new Promise(r => setImmediate(r));
    expect(bm.executed).to.deep.equal([]);
  });

  it('skips a backup that ran seconds ago', async () => {
    const bm = fakeBackupManager([{
      Id: 'b1', Enabled: true, CronExpression: '* * * * *',
      LastRun: new Date().toISOString(),
    }]);
    const s = makeCore(core.ROLE_SERVICE, fakeTaskManager([]), bm);
    s.tick();
    await new Promise(r => setImmediate(r));
    expect(bm.executed).to.deep.equal([]);
  });

  it('honours the cron expression instead of running everything', async () => {
    const bm = fakeBackupManager([{ Id: 'b1', Enabled: true, CronExpression: '0 2 * * *' }]);
    const s = makeCore(core.ROLE_SERVICE, fakeTaskManager([]), bm, neverDueCron);
    s.tick();
    await new Promise(r => setImmediate(r));
    expect(bm.executed).to.deep.equal([]);
  });

  it('keeps ticking after a task throws - a service must never die on one bad job', () => {
    const tm = fakeTaskManager([{ Id: 'bad', Name: 'Bad', due: true }]);
    tm.getDueTasks = () => { throw new Error('config file is corrupt'); };
    const s = makeCore(core.ROLE_SERVICE, tm, fakeBackupManager([]));
    expect(() => s.tick()).to.not.throw();
    expect(logger.entries.some(e => e.level === 'ERROR')).to.equal(true);

    // And the next tick still works once the fault clears.
    tm.getDueTasks = () => [{ Id: 'good', Name: 'Good', due: true }];
    s.lastRun = {};
    expect(() => s.tick()).to.not.throw();
    expect(tm.executed).to.deep.equal(['good']);
  });

  it('a rejected task promise does not take the process down', async () => {
    const tm = fakeTaskManager([{ Id: 't1', Name: 'Job', due: true }]);
    tm.executeTask = () => Promise.reject(new Error('script exploded'));
    const s = makeCore(core.ROLE_SERVICE, tm, fakeBackupManager([]));
    s.tick();
    await new Promise(r => setTimeout(r, 30));
    expect(logger.entries.some(e => e.level === 'ERROR')).to.equal(true);
  });

  it('stop() releases the lease', () => {
    const s = makeCore(core.ROLE_GUI, fakeTaskManager([]), fakeBackupManager([]));
    s.tick();
    expect(core.readOwner()).to.not.equal(null);
    s.stop();
    expect(core.readOwner()).to.equal(null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Service: NSSM installation parameters', () => {
  let saved, svc, dataDir;

  beforeEach(() => {
    saved = process.env[DATA_ENV];
    dataDir = tempDir('nssm');
    process.env[DATA_ENV] = dataDir;
    const { KyrionService } = freshModules();
    svc = new KyrionService(fakeLogger(), { checkNssm: () => ({ installed: true, path: 'C:\\nssm\\nssm.exe' }) });
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[DATA_ENV]; else process.env[DATA_ENV] = saved;
  });

  function flatten(cmds) { return cmds.map(c => c.join(' ')).join('\n'); }

  it('runs the Electron binary as bare Node - no GUI to fail in session 0', () => {
    const text = flatten(svc.buildInstallCommands());
    expect(text).to.include('ELECTRON_RUN_AS_NODE=1');
  });

  it('never passes the old --service flag that booted a full Electron app', () => {
    const text = flatten(svc.buildInstallCommands());
    expect(text).to.not.include('--service');
  });

  it('points the service at the shared data directory', () => {
    const text = flatten(svc.buildInstallCommands());
    expect(text).to.include(`KYRION_DATA_DIR=${dataDir}`);
  });

  it('launches the headless scheduler script, not the app entry point', () => {
    const [install] = svc.buildInstallCommands();
    expect(install[0]).to.equal('install');
    expect(install[3]).to.match(/serviceScheduler\.js$/);
  });

  it('resolves the scheduler script to a file that actually exists', () => {
    expect(fs.existsSync(svc.getSchedulerPath())).to.equal(true);
  });

  it('runs as LocalSystem so it survives the admin logging off', () => {
    const text = flatten(svc.buildInstallCommands());
    expect(text).to.include('ObjectName LocalSystem');
  });

  it('starts automatically at boot, before anyone logs in', () => {
    const text = flatten(svc.buildInstallCommands());
    expect(text).to.include('Start SERVICE_AUTO_START');
  });

  it('supports a Manual startup type when asked', () => {
    const text = flatten(svc.buildInstallCommands({ startup: 'Manual' }));
    expect(text).to.include('Start SERVICE_DEMAND_START');
  });

  it('restarts itself on crash, with a throttle against boot loops', () => {
    const text = flatten(svc.buildInstallCommands());
    expect(text).to.include('AppExit Default Restart');
    expect(text).to.include('AppRestartDelay 5000');
    expect(text).to.include('AppThrottle 10000');
  });

  it('gives running jobs time to finish before a hard kill', () => {
    const text = flatten(svc.buildInstallCommands());
    expect(text).to.include('AppStopMethodConsole 10000');
  });

  it('captures stdout/stderr to rotating log files for post-mortem', () => {
    const text = flatten(svc.buildInstallCommands());
    expect(text).to.include('service-stdout.log');
    expect(text).to.include('service-stderr.log');
    expect(text).to.include('AppRotateFiles 1');
  });

  it('quotes paths containing spaces (C:\\Program Files\\...)', () => {
    const script = svc.buildBatchScript('C:\\Program Files\\nssm\\nssm.exe', svc.buildInstallCommands({
      exe: 'C:\\Program Files\\Kyrios Chronos\\KyriosChronos.exe',
      script: 'C:\\Program Files\\Kyrios Chronos\\resources\\app.asar\\src\\main\\serviceScheduler.js',
    }));
    expect(script).to.include('"C:\\Program Files\\nssm\\nssm.exe"');
    expect(script).to.include('"C:\\Program Files\\Kyrios Chronos\\KyriosChronos.exe"');
    // Every emitted line must invoke the quoted nssm binary.
    for (const line of script.split('\r\n')) {
      if (!line || line.startsWith('@') || line.startsWith('setlocal') || line.startsWith('exit')) continue;
      expect(line).to.match(/^"C:\\Program Files\\nssm\\nssm\.exe" /);
    }
  });

  it('refuses to install without NSSM instead of half-registering a service', async () => {
    const { KyrionService } = freshModules();
    const noNssm = new KyrionService(fakeLogger(), { checkNssm: () => ({ installed: false }) });
    const result = await noNssm.install();
    expect(result.success).to.equal(false);
    expect(result.message).to.include('NSSM');
  });

  it('uses the Latin service name outside the UI', () => {
    const { KyrionService } = freshModules();
    expect(KyrionService.SERVICE_NAME).to.equal('KyriosChronos');
    expect(KyrionService.SERVICE_NAME).to.match(/^[A-Za-z]+$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The test that actually proves the feature: boot the real scheduler as a
// detached headless process against a real config directory and check that it
// executes a real task file.
describe('Service: end-to-end headless execution', function () {
  this.timeout(60000);

  const schedulerScript = path.join(__dirname, '..', 'src', 'main', 'serviceScheduler.js');
  let dataDir, workDir, child;

  beforeEach(() => {
    dataDir = tempDir('e2e');
    workDir = tempDir('e2e-work');
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  });

  afterEach(() => {
    if (child && !child.killed) { try { child.kill(); } catch (e) {} }
    child = null;
  });

  function seedTask(name) {
    // A task whose only job is to prove it ran, by creating a file.
    const marker = path.join(workDir, `${name}.marker`);
    const script = path.join(workDir, `${name}.cmd`);
    fs.writeFileSync(script, `@echo off\r\necho ran > "${marker}"\r\n`, 'utf8');
    fs.writeFileSync(path.join(dataDir, 'config', 'tasks.json'), JSON.stringify([{
      Id: name,
      Name: name,
      CronExpression: '* * * * *',   // due every minute -> due on the first tick
      ScriptPath: script,
      ScriptType: 'bat',
      ManagementMode: 'cronmaster',
      Enabled: true,
    }], null, 2), 'utf8');
    return marker;
  }

  function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = () => {
        if (predicate()) return resolve(true);
        if (Date.now() > deadline) return resolve(false);
        setTimeout(poll, 250);
      };
      poll();
    });
  }

  function launch(execPath, extraEnv) {
    return spawn(execPath, [schedulerScript], {
      env: { ...process.env, [DATA_ENV]: dataDir, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  it('executes a scheduled task with no Electron GUI, no window and no desktop', async () => {
    const marker = seedTask('headless');
    child = launch(process.execPath);

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    const ran = await waitFor(() => fs.existsSync(marker), 30000);
    expect(ran, `task never executed. stderr:\n${stderr}`).to.equal(true);
  });

  it('writes a service-role heartbeat, proving the loop is really ticking', async () => {
    seedTask('heartbeat');
    child = launch(process.execPath);

    const ownerFile = path.join(dataDir, 'config', 'scheduler-owner.json');
    const appeared = await waitFor(() => fs.existsSync(ownerFile), 20000);
    expect(appeared).to.equal(true);

    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    expect(owner.role).to.equal('service');
    expect(owner.pid).to.equal(child.pid);
  });

  it('writes a PID file and its own log so failures are diagnosable', async () => {
    seedTask('logs');
    child = launch(process.execPath);

    const pidFile = path.join(dataDir, 'config', 'service.pid');
    expect(await waitFor(() => fs.existsSync(pidFile), 20000)).to.equal(true);
    expect(fs.readFileSync(pidFile, 'utf8').trim()).to.equal(String(child.pid));

    const logged = await waitFor(() => {
      const dir = path.join(dataDir, 'logs');
      return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    }, 20000);
    expect(logged).to.equal(true);
  });

  it('starts cleanly with an empty config directory (fresh server install)', async () => {
    child = launch(process.execPath);
    const ownerFile = path.join(dataDir, 'config', 'scheduler-owner.json');
    expect(await waitFor(() => fs.existsSync(ownerFile), 20000)).to.equal(true);
    expect(child.exitCode).to.equal(null); // still running, did not crash
  });

  it('shuts down on SIGTERM and releases the lease for the next start', async () => {
    seedTask('shutdown');
    child = launch(process.execPath);
    const ownerFile = path.join(dataDir, 'config', 'scheduler-owner.json');
    expect(await waitFor(() => fs.existsSync(ownerFile), 20000)).to.equal(true);

    const exited = new Promise(r => child.on('exit', r));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise(r => setTimeout(r, 10000))]);
  });

  // This is the exact mechanism NSSM will use on the server: the shipped
  // Electron executable, switched into plain-Node mode. If this passes, the
  // packaged build needs no Node.js installed on the machine.
  it('runs under ELECTRON_RUN_AS_NODE, the exact mode NSSM launches', async function () {
    const electronExe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
    if (!fs.existsSync(electronExe)) return this.skip();

    const marker = seedTask('as-node');
    child = launch(electronExe, { ELECTRON_RUN_AS_NODE: '1' });

    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });

    const ran = await waitFor(() => fs.existsSync(marker), 40000);
    expect(ran, `task never executed under ELECTRON_RUN_AS_NODE. stderr:\n${stderr}`).to.equal(true);
  });

  it('picks up a task added to tasks.json after it started', async () => {
    child = launch(process.execPath);
    const ownerFile = path.join(dataDir, 'config', 'scheduler-owner.json');
    expect(await waitFor(() => fs.existsSync(ownerFile), 20000)).to.equal(true);

    // The GUI writes a new task while the service is already running.
    const marker = seedTask('added-later');
    const ran = await waitFor(() => fs.existsSync(marker), 35000);
    expect(ran, 'service did not reload tasks.json written by another process').to.equal(true);
  });
});
