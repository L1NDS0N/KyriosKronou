// kyrionService.js - Install/manage the Κύριος Χρόνος Windows service via NSSM.
//
// Why the service used to register but never run anything:
//
//  1. It was installed as `KyriosChronos.exe --service`, i.e. a full Electron
//     app. In session 0 there is no desktop or GPU, so Electron's startup could
//     stall before the scheduler ever began.
//  2. It stored config under the *calling user's* %APPDATA%. Running as
//     LocalSystem the service read a different, empty directory - zero tasks.
//
// Both are fixed here: the service runs the plain-Node scheduler through
// ELECTRON_RUN_AS_NODE, and points at the shared %ProgramData% data directory.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, execSync } = require('child_process');

const paths = require('./paths');

const SERVICE_NAME = 'KyriosChronos';
const SERVICE_DISPLAY_NAME = 'Kyrios Chronos Scheduler';
const SERVICE_DESCRIPTION = 'Kyrios Chronos - task scheduler and MySQL backup service. Runs headless in session 0, independent of any logged-in user.';

class KyrionService {
  constructor(logger, serviceManager) {
    this.logger = logger;
    this.serviceManager = serviceManager; // reused for NSSM path resolution
  }

  get serviceName() { return SERVICE_NAME; }

  _nssmPath() {
    const check = this.serviceManager.checkNssm();
    return check.installed ? check.path : null;
  }

  /**
   * Absolute path to the headless scheduler script.
   * Packaged builds keep it inside app.asar; Electron resolves asar paths fine
   * in ELECTRON_RUN_AS_NODE mode.
   */
  getSchedulerPath() {
    const local = path.join(__dirname, 'serviceScheduler.js');
    if (fs.existsSync(local)) return local;
    const resources = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources');
    for (const candidate of [
      path.join(resources, 'app.asar', 'src', 'main', 'serviceScheduler.js'),
      path.join(resources, 'app', 'src', 'main', 'serviceScheduler.js'),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return local;
  }

  /**
   * The executable that hosts the scheduler. In a packaged build this is
   * KyriosChronos.exe (Electron); running from source it is electron.exe.
   * Either way ELECTRON_RUN_AS_NODE makes it behave as `node`.
   */
  getHostExecutable() {
    return process.execPath;
  }

  /**
   * Build the full NSSM command list for a fresh install.
   * Returned as an array of argv arrays so it can be asserted in tests without
   * touching the real service control manager.
   */
  buildInstallCommands(opts = {}) {
    const exe = opts.exe || this.getHostExecutable();
    const script = opts.script || this.getSchedulerPath();
    const dataDir = opts.dataDir || paths.dataDir();
    const logsDir = opts.logsDir || paths.logsDir();
    const workDir = opts.workDir || path.dirname(exe);
    const startup = opts.startup === 'Manual' ? 'SERVICE_DEMAND_START' : 'SERVICE_AUTO_START';

    return [
      ['install', SERVICE_NAME, exe, script],
      // The critical switch: run the Electron binary as a bare Node runtime.
      ['set', SERVICE_NAME, 'AppEnvironmentExtra', 'ELECTRON_RUN_AS_NODE=1', `KYRION_DATA_DIR=${dataDir}`, 'NODE_ENV=production'],
      ['set', SERVICE_NAME, 'AppDirectory', workDir],
      ['set', SERVICE_NAME, 'DisplayName', SERVICE_DISPLAY_NAME],
      ['set', SERVICE_NAME, 'Description', SERVICE_DESCRIPTION],
      ['set', SERVICE_NAME, 'Start', startup],
      // LocalSystem survives user logoff - the whole reason this is a service.
      ['set', SERVICE_NAME, 'ObjectName', 'LocalSystem'],
      ['set', SERVICE_NAME, 'AppStdout', path.join(logsDir, 'service-stdout.log')],
      ['set', SERVICE_NAME, 'AppStderr', path.join(logsDir, 'service-stderr.log')],
      ['set', SERVICE_NAME, 'AppRotateFiles', '1'],
      ['set', SERVICE_NAME, 'AppRotateBytes', '10485760'],
      // Restart on crash, with a delay so a boot loop cannot pin the CPU.
      ['set', SERVICE_NAME, 'AppExit', 'Default', 'Restart'],
      ['set', SERVICE_NAME, 'AppRestartDelay', '5000'],
      ['set', SERVICE_NAME, 'AppThrottle', '10000'],
      // Give running jobs time to finish before a hard kill on stop.
      ['set', SERVICE_NAME, 'AppStopMethodConsole', '10000'],
      ['set', SERVICE_NAME, 'AppStopMethodWindow', '5000'],
      ['set', SERVICE_NAME, 'AppStopMethodThreads', '5000'],
      ['start', SERVICE_NAME],
    ];
  }

  /**
   * Render NSSM argv arrays into a batch script.
   * Installing needs ~18 elevated calls; batching them into one script means a
   * single UAC prompt and avoids fragile nested PowerShell quoting.
   */
  buildBatchScript(nssmPath, commands) {
    const lines = ['@echo off', 'setlocal'];
    for (const argv of commands) {
      const quoted = argv.map(a => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a));
      lines.push(`"${nssmPath}" ${quoted.join(' ')}`);
    }
    lines.push('exit /b 0');
    return lines.join('\r\n') + '\r\n';
  }

  /** Run a batch script elevated, waiting for it to finish. */
  _runElevatedBatch(script, timeoutMs = 120000) {
    const file = path.join(os.tmpdir(), `kyrios-service-${Date.now()}.cmd`);
    fs.writeFileSync(file, script, 'utf8');
    try {
      const ps = `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','"${file}"' -Verb RunAs -Wait -WindowStyle Hidden`;
      execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
        encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
      });
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    } finally {
      try { fs.unlinkSync(file); } catch (e) {}
    }
  }

  async install(opts = {}) {
    const nssm = this._nssmPath();
    if (!nssm) {
      return { success: false, message: 'NSSM not found. Install NSSM (choco install nssm) or set its path in Settings.' };
    }

    // The data directory must exist and be readable by LocalSystem before the
    // service starts, otherwise its first tick finds nothing.
    paths.ensureDirs();
    paths.migrateLegacyData();

    const existing = await this.getStatus();
    const commands = [];
    if (existing.installed) {
      this.logger.log('INFO', `Reinstalling service ${SERVICE_NAME} (was ${existing.status})`);
      commands.push(['stop', SERVICE_NAME], ['remove', SERVICE_NAME, 'confirm']);
    }
    commands.push(...this.buildInstallCommands(opts));

    const script = this.buildBatchScript(nssm, commands);
    this.logger.log('INFO', `Installing service ${SERVICE_NAME}: ${this.getHostExecutable()} -> ${this.getSchedulerPath()}`);

    const run = this._runElevatedBatch(script);
    if (!run.success) {
      return { success: false, message: `Service install failed (elevation denied?): ${run.message}` };
    }

    // NSSM's `start` is asynchronous - poll until the SCM reports RUNNING.
    const status = await this.waitForStatus('Running', 20000);
    if (!status.running) {
      return {
        success: false,
        message: `Service installed but did not reach Running (status: ${status.status || 'unknown'}). Check logs in ${paths.logsDir()}.`,
        status,
      };
    }

    this.logger.audit('KYRION_SERVICE_INSTALLED', {
      targetType: 'service',
      after: { serviceName: SERVICE_NAME, dataDir: paths.dataDir() },
    });
    return { success: true, message: `Service ${SERVICE_NAME} installed and running`, status };
  }

  async uninstall() {
    const nssm = this._nssmPath();
    if (!nssm) return { success: false, message: 'NSSM not found' };
    const script = this.buildBatchScript(nssm, [
      ['stop', SERVICE_NAME],
      ['remove', SERVICE_NAME, 'confirm'],
    ]);
    const run = this._runElevatedBatch(script, 60000);
    if (!run.success) return { success: false, message: run.message };
    this.logger.audit('KYRION_SERVICE_UNINSTALLED', { targetType: 'service', before: { serviceName: SERVICE_NAME } });
    return { success: true, message: `Service ${SERVICE_NAME} removed` };
  }

  async start() {
    const nssm = this._nssmPath();
    if (!nssm) return { success: false, message: 'NSSM not found' };
    const run = this._runElevatedBatch(this.buildBatchScript(nssm, [['start', SERVICE_NAME]]), 60000);
    if (!run.success) return { success: false, message: run.message };
    const status = await this.waitForStatus('Running', 20000);
    return { success: status.running, message: status.running ? 'Service started' : `Service did not start (${status.status})`, status };
  }

  async stop() {
    const nssm = this._nssmPath();
    if (!nssm) return { success: false, message: 'NSSM not found' };
    const run = this._runElevatedBatch(this.buildBatchScript(nssm, [['stop', SERVICE_NAME]]), 60000);
    if (!run.success) return { success: false, message: run.message };
    const status = await this.waitForStatus('Stopped', 20000);
    return { success: !status.running, message: !status.running ? 'Service stopped' : 'Service still running', status };
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  /** Query the SCM directly - authoritative and does not need elevation. */
  getStatus() {
    return new Promise((resolve) => {
      exec(`sc query "${SERVICE_NAME}"`, { timeout: 10000, windowsHide: true }, (error, stdout) => {
        if (error || !stdout) {
          resolve({ installed: false, running: false, status: null });
          return;
        }
        let status = 'Unknown';
        if (stdout.includes('RUNNING')) status = 'Running';
        else if (stdout.includes('STOPPED')) status = 'Stopped';
        else if (stdout.includes('START_PENDING')) status = 'Starting';
        else if (stdout.includes('STOP_PENDING')) status = 'Stopping';
        else if (stdout.includes('PAUSED')) status = 'Paused';
        resolve({ installed: true, running: status === 'Running', status, serviceName: SERVICE_NAME });
      });
    });
  }

  async waitForStatus(target, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let status = await this.getStatus();
    while (Date.now() < deadline && status.status !== target) {
      await new Promise(r => setTimeout(r, 1000));
      status = await this.getStatus();
    }
    return status;
  }

  /**
   * Health beyond "the SCM says RUNNING": is the scheduler actually ticking?
   * Reads the ownership heartbeat the service rewrites every 15 seconds.
   */
  async getHealth() {
    const status = await this.getStatus();
    const { readOwner, STALE_MS } = require('./schedulerCore');
    const owner = readOwner();
    const age = owner ? Date.now() - (owner.ts || 0) : null;

    return {
      ...status,
      dataDir: paths.dataDir(),
      schedulerOwner: owner ? { pid: owner.pid, role: owner.role, ageMs: age } : null,
      // The real signal: a fresh heartbeat written by a `service` role process.
      schedulerAlive: !!(owner && owner.role === 'service' && age !== null && age < STALE_MS),
      heartbeatStale: !!(owner && age !== null && age >= STALE_MS),
    };
  }
}

module.exports = KyrionService;
module.exports.SERVICE_NAME = SERVICE_NAME;
module.exports.SERVICE_DISPLAY_NAME = SERVICE_DISPLAY_NAME;
