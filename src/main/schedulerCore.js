// schedulerCore.js - The one scheduler engine, shared by the GUI and the service.
//
// Two processes can be alive at once (the user has the window open while the
// service runs in session 0). Only ONE of them may execute tasks, or every job
// fires twice. Ownership is arbitrated through a heartbeat file:
//
//   - The owner rewrites the file every tick.
//   - A claimant may take over when the file is missing, stale, or its PID is
//     dead.
//   - The service always outranks the GUI: it preempts a GUI owner on sight,
//     and the GUI never takes ownership back while the service is alive. That
//     is what makes the GUI go passive the moment the service is installed.
//
// Electron-free by design: the service loads this as plain Node.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const TICK_MS = 15000;
// Three missed heartbeats before a claimant is allowed to assume the owner died.
const STALE_MS = TICK_MS * 3;
const ROLE_SERVICE = 'service';
const ROLE_GUI = 'gui';

function isPidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, does not kill
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user (the service
    // runs as LocalSystem) - that still counts as alive.
    return err.code === 'EPERM';
  }
}

function readOwner() {
  try {
    const raw = fs.readFileSync(paths.ownerFile(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.pid !== 'number') return null;
    return data;
  } catch (e) {
    return null;
  }
}

function writeOwner(role, pid = process.pid) {
  const record = {
    pid,
    role,
    host: require('os').hostname(),
    ts: Date.now(),
    updatedAt: new Date().toISOString(),
  };
  try {
    if (!fs.existsSync(paths.configDir())) fs.mkdirSync(paths.configDir(), { recursive: true });
    fs.writeFileSync(paths.ownerFile(), JSON.stringify(record, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Decide whether `role` (running as `pid`) may execute tasks right now.
 * Pure function over the current owner record so it can be unit-tested.
 */
function canClaim(owner, role, pid, now = Date.now(), pidAlive = isPidAlive) {
  if (!owner) return true;                       // nobody holds it
  if (owner.pid === pid) return true;            // we already hold it
  if ((now - (owner.ts || 0)) > STALE_MS) return true; // owner stopped heartbeating
  if (!pidAlive(owner.pid)) return true;         // owner died without cleaning up
  // Live owner: only the service may preempt, and only a GUI owner.
  if (role === ROLE_SERVICE && owner.role === ROLE_GUI) return true;
  return false;
}

function releaseOwnership(pid = process.pid) {
  try {
    const owner = readOwner();
    if (owner && owner.pid === pid) fs.unlinkSync(paths.ownerFile());
  } catch (e) { /* best effort */ }
}

/**
 * The scheduler engine.
 *
 * @param {object} deps - { taskManager, backupManager, cronParser, logger }
 * @param {string} role - ROLE_SERVICE or ROLE_GUI
 * @param {object} hooks - optional { onTaskExecuted, onBackupExecuted, onOwnershipChange }
 */
class SchedulerCore {
  constructor(deps, role, hooks = {}, options = {}) {
    // Identity of this scheduler. Overridable so tests can simulate two
    // separate OS processes contending for the lease inside one test run.
    this.pid = options.pid || process.pid;
    this.taskManager = deps.taskManager;
    this.backupManager = deps.backupManager;
    this.syncManager = deps.syncManager || null;
    this.cronParser = deps.cronParser;
    this.logger = deps.logger;
    this.role = role;
    this.hooks = hooks;
    this.timer = null;
    this.isOwner = false;
    this.lastRun = {};   // { key: timestamp } - guards against double-fire inside a minute
    this.running = new Set(); // keys currently executing, so a slow job never overlaps itself
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Do not hold the event loop open on the GUI side.
    if (this.timer.unref && this.role === ROLE_GUI) this.timer.unref();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    releaseOwnership(this.pid);
    this.isOwner = false;
  }

  /** Refresh or acquire the execution lease. Returns true when we may execute. */
  refreshOwnership() {
    const owner = readOwner();
    const allowed = canClaim(owner, this.role, this.pid);

    if (allowed) {
      writeOwner(this.role, this.pid);
      if (!this.isOwner) {
        this.isOwner = true;
        this.logger.log('INFO', `[${this.role}] Scheduler ownership acquired (pid ${this.pid})`);
        if (this.hooks.onOwnershipChange) this.hooks.onOwnershipChange(true);
      }
    } else if (this.isOwner) {
      this.isOwner = false;
      this.logger.log('INFO', `[${this.role}] Scheduler ownership yielded to ${owner.role} (pid ${owner.pid})`);
      if (this.hooks.onOwnershipChange) this.hooks.onOwnershipChange(false);
    }

    return allowed;
  }

  /** Re-read config from disk so the service sees edits made in the GUI. */
  reload() {
    try { if (this.taskManager.loadData) this.taskManager.loadData(); } catch (e) {}
    try { if (this.backupManager && this.backupManager.reload) this.backupManager.reload(); } catch (e) {}
    try { if (this.syncManager && this.syncManager.reload) this.syncManager.reload(); } catch (e) {}
  }

  _guard(key) {
    if (this.running.has(key)) return false;
    const last = this.lastRun[key];
    if (last && (Date.now() - last) < 55000) return false;
    this.lastRun[key] = Date.now();
    this.running.add(key);
    return true;
  }

  tick() {
    let owns;
    try {
      owns = this.refreshOwnership();
    } catch (err) {
      this.logger.error(`[${this.role}] Ownership check failed`, err);
      return;
    }
    if (!owns) return; // another process is executing; stay passive

    try {
      this.reload();
      this.runDueTasks();
      this.runDueBackups();
      this.runDueSyncs();
    } catch (err) {
      this.logger.error(`[${this.role}] Scheduler tick error`, err);
    }
  }

  runDueTasks() {
    const due = this.taskManager.getDueTasks();
    if (!Array.isArray(due)) return;
    for (const task of due) {
      const key = `task:${task.Id}`;
      if (!this._guard(key)) continue;
      this.logger.log('INFO', `[${this.role}] Executing task: ${task.Name}`);
      Promise.resolve(this.taskManager.executeTask(task))
        .then((result) => {
          this.logger.auditTaskExecuted(task.Id, task.Name, result);
          if (this.hooks.onTaskExecuted) this.hooks.onTaskExecuted(task, result);
        })
        .catch((err) => this.logger.error(`[${this.role}] Task failed: ${task.Name}`, err))
        .finally(() => this.running.delete(key));
    }
  }

  runDueBackups() {
    if (!this.backupManager) return;
    const profiles = this.backupManager.getAllProfiles();
    if (!Array.isArray(profiles)) return;
    const now = Date.now();

    for (const profile of profiles) {
      if (!profile.Enabled) continue;
      if (profile.ManagementMode === 'nssm') continue; // runs as its own service
      if (!profile.CronExpression) continue;
      if (!this.cronParser.shouldRunNow(profile.CronExpression)) continue;
      if (profile.LastRun && (now - new Date(profile.LastRun).getTime()) < 55000) continue;

      const key = `backup:${profile.Id}`;
      if (!this._guard(key)) continue;
      this.logger.log('INFO', `[${this.role}] Executing backup: ${profile.Name}`);
      Promise.resolve(this.backupManager.executeBackup(profile.Id))
        .then((result) => {
          this.logger.log('INFO', `[${this.role}] Backup ${profile.Name}: ${result && result.success ? 'completed' : 'failed'} ${(result && result.duration) || ''}`);
          if (this.hooks.onBackupExecuted) this.hooks.onBackupExecuted(profile, result);
        })
        .catch((err) => this.logger.error(`[${this.role}] Backup failed: ${profile.Name}`, err))
        .finally(() => this.running.delete(key));
    }
  }

  /** Sync profiles on a cron: same guard rules, one engine per destination. */
  runDueSyncs() {
    if (!this.syncManager) return;
    let due;
    try { due = this.syncManager.getDueProfiles(); } catch (e) { return; }
    if (!Array.isArray(due)) return;
    const now = Date.now();

    for (const profile of due) {
      if (!this.cronParser.shouldRunNow(profile.CronExpression)) continue;
      if (profile.LastRun && (now - new Date(profile.LastRun).getTime()) < 55000) continue;

      const key = `sync:${profile.Id}`;
      if (!this._guard(key)) continue;
      this.logger.log('INFO', `[${this.role}] Executing sync: ${profile.Name}`);
      Promise.resolve(this.syncManager.executeSync(profile.Id))
        .then((result) => {
          this.logger.log('INFO', `[${this.role}] Sync ${profile.Name}: ${result && result.success ? 'completed' : 'failed'} ${(result && result.duration) || ''}`);
          if (this.hooks.onSyncExecuted) this.hooks.onSyncExecuted(profile, result);
        })
        .catch((err) => this.logger.error(`[${this.role}] Sync failed: ${profile.Name}`, err))
        .finally(() => this.running.delete(key));
    }
  }
}

module.exports = {
  SchedulerCore,
  ROLE_SERVICE,
  ROLE_GUI,
  TICK_MS,
  STALE_MS,
  canClaim,
  readOwner,
  writeOwner,
  releaseOwnership,
  isPidAlive,
};
