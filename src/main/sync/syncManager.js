// sync/syncManager.js - Sync profiles: CRUD, execution, history.
//
// A sync profile is "backups, but for folders": same shape as a backup
// profile (connection, schedule, upload targets, history), executed under the
// same scheduler ownership rules, tracked in the same run registry. The
// destination work is delegated to a sync engine (local, SMB, FTP, SFTP).
//
// Electron-free, so the Windows service can load it too.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engines = require('./engines');
const planner = require('./filePlanner');
const retention = require('./retention');

/** Fill a profile's Retention block with safe defaults. */
function normalizeRetention(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    Enabled: r.Enabled === true,
    // Where snapshot dates come from: 'metadata' (mtime, the historical
    // default) or 'names' (falls back to mtime when a name has no date).
    DateSource: r.DateSource === 'names' ? 'names' : 'metadata',
    ByAge: r.ByAge === true,
    KeepDays: parseInt(r.KeepDays, 10) || 30,
    ByCount: r.ByCount === true,
    KeepCount: parseInt(r.KeepCount, 10) || 10,
    BySize: r.BySize === true,
    FreeGb: parseFloat(r.FreeGb) || 0,
    // Periodic history: keep one snapshot per week / fortnight / month for
    // the last N periods, protected from every delete rule.
    ByWeekly: r.ByWeekly === true,
    WeeklyKeepWeeks: parseInt(r.WeeklyKeepWeeks, 10) || 8,
    ByBiweekly: r.ByBiweekly === true,
    BiweeklyKeepPeriods: parseInt(r.BiweeklyKeepPeriods, 10) || 12,
    ByMonthly: r.ByMonthly === true,
    MonthlyKeepMonths: parseInt(r.MonthlyKeepMonths, 10) || 12,
    MinKeep: r.MinKeep === undefined ? 3 : Math.max(0, parseInt(r.MinKeep, 10) || 0),
  };
}

class SyncManager {
  constructor(config, logger, runRegistry) {
    this.config = config;
    this.logger = logger;
    // Optional: reports live progress and output for the UI.
    this.runs = runRegistry || null;
    this.profilesFile = path.join(config.configDir, 'sync-profiles.json');
    this.historyFile = path.join(config.configDir, 'sync-history.json');
    this.profiles = this.loadProfiles();
    this.history = this.loadHistory();
    this.watchers = new Map();
    this.onWatchExecuted = null;
    // Task run just finished -> run the syncs attached to it, if it succeeded.
    this.onTaskFinished = null;
  }

  // ─── Profile Management ───
  loadProfiles() {
    try {
      if (fs.existsSync(this.profilesFile)) {
        const data = JSON.parse(fs.readFileSync(this.profilesFile, 'utf8'));
        return Array.isArray(data) ? data : [];
      }
    } catch (e) { /* corrupted file: start empty rather than crash */ }
    return [];
  }

  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        const data = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
        return Array.isArray(data) ? data : [];
      }
    } catch (e) {}
    return [];
  }

  saveProfiles() {
    fs.writeFileSync(this.profilesFile, JSON.stringify(this.profiles, null, 2), 'utf8');
  }

  saveHistory() {
    fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2), 'utf8');
  }

  /** Re-read from disk so the service picks up edits made in the GUI process. */
  reload() {
    this.profiles = this.loadProfiles();
    return this.profiles;
  }

  createProfile(data) {
    const profile = {
      Id: data.Id || crypto.randomUUID(),
      Name: data.Name,
      Description: data.Description || '',
      SourcePath: data.SourcePath || '',
      // Destination: type + connection. Same idea as a backup UploadTarget.
      Engine: data.Engine || 'local',
      DestPath: data.DestPath || '',
      Host: data.Host || '',
      Port: data.Port || null,
      User: data.User || '',
      Password: data.Password || '',
      // What to copy
      Mode: data.Mode || 'incremental', // 'incremental' | 'full'
      Mirror: data.Mirror !== false,
      Excludes: data.Excludes || [],
      // Old-content cleanup on the destination. Disabled until the user
      // (or the folder analysis) turns it on - sync never deletes on its own.
      Retention: normalizeRetention(data.Retention),
      // When to run
      CronExpression: data.CronExpression || '',
      Enabled: data.Enabled !== false,
      // Optional local source watcher. It is independent from cron/task
      // triggers, so a profile can react to a change immediately.
      WatchEnabled: data.WatchEnabled === true,
      WatchDebounceMs: Math.max(250, parseInt(data.WatchDebounceMs, 10) || 1500),
      // Run automatically after a task finishes successfully
      TriggerTaskId: data.TriggerTaskId || '',
      TriggerOnFailure: data.TriggerOnFailure === true, // default: only on success
      // Metadata
      CreatedAt: data.CreatedAt || new Date().toISOString(),
      UpdatedAt: data.UpdatedAt || new Date().toISOString(),
      LastRun: null,
      LastStatus: null,
    };
    this.profiles.push(profile);
    this.saveProfiles();
    this.logger.audit('SYNC_PROFILE_CREATED', { targetType: 'sync', target: profile.Id, after: { Name: profile.Name } });
    return profile;
  }

  updateProfile(data) {
    const idx = this.profiles.findIndex(p => p.Id === data.Id);
    if (idx === -1) return null;
    this.profiles[idx] = { ...this.profiles[idx], ...data, UpdatedAt: new Date().toISOString() };
    this.saveProfiles();
    return this.profiles[idx];
  }

  deleteProfile(id) {
    const idx = this.profiles.findIndex(p => p.Id === id);
    if (idx === -1) return false;
    const name = this.profiles[idx].Name;
    this.profiles.splice(idx, 1);
    this.saveProfiles();
    this.logger.audit('SYNC_PROFILE_DELETED', { targetType: 'sync', target: id, before: { Name: name } });
    return true;
  }

  getProfile(id) {
    return this.profiles.find(p => p.Id === id) || null;
  }

  getAllProfiles() {
    return [...this.profiles];
  }

  // ─── Source watchers ───
  // fs.watch is intentionally kept here, next to the profile execution code,
  // so GUI and Windows-service schedulers share the exact same behaviour.
  reconcileWatchers(shouldRun) {
    if (!shouldRun) return this.stopWatchers();
    const desired = this.profiles.filter(p => p.Enabled && p.WatchEnabled && p.SourcePath);
    const desiredById = new Map(desired.map(p => [p.Id, p]));

    for (const [id, entry] of this.watchers) {
      const profile = desiredById.get(id);
      if (!profile || entry.sourcePath !== profile.SourcePath) this._removeWatcher(id);
    }
    for (const profile of desired) {
      if (this.watchers.has(profile.Id)) continue;
      if (!fs.existsSync(profile.SourcePath)) {
        this.logger.log('WARN', `Sync watcher skipped (source not found): ${profile.SourcePath}`);
        continue;
      }
      try {
        const watcher = fs.watch(profile.SourcePath, { recursive: true }, () => this._watchChanged(profile.Id));
        watcher.on('error', (err) => {
          this.logger.log('WARN', `Sync watcher error for ${profile.Name}: ${err.message}`);
          this._removeWatcher(profile.Id);
        });
        this.watchers.set(profile.Id, { watcher, timer: null, profileId: profile.Id, sourcePath: profile.SourcePath });
        this.logger.log('INFO', `Sync watcher enabled: ${profile.Name} (${profile.SourcePath})`);
      } catch (e) {
        this.logger.log('WARN', `Sync watcher unavailable for ${profile.Name}: ${e.message}`);
      }
    }
  }

  _removeWatcher(id) {
    const entry = this.watchers && this.watchers.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    try { entry.watcher.close(); } catch (e) {}
    if (this.watchers) this.watchers.delete(id);
  }

  stopWatchers() {
    if (!this.watchers) return;
    for (const id of [...this.watchers.keys()]) this._removeWatcher(id);
  }

  async _watchChanged(profileId) {
    const entry = this.watchers && this.watchers.get(profileId);
    const profile = this.getProfile(profileId);
    if (!entry || !profile || !profile.Enabled || !profile.WatchEnabled) return;
    if (entry.timer) clearTimeout(entry.timer);
    const delay = Math.max(250, parseInt(profile.WatchDebounceMs, 10) || 1500);
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      if (!profile.Enabled || !profile.WatchEnabled) return;
      if (entry.running) return;
      entry.running = true;
      try {
        this.logger.log('INFO', `Sync watcher triggered: ${profile.Name}`);
        const result = await this.executeSync(profileId, { triggeredBy: 'watch' });
        if (this.onWatchExecuted) this.onWatchExecuted(profile, result);
      } catch (e) {
        this.logger.error(`Sync watcher failed: ${profile.Name}: ${e.message}`);
      } finally {
        entry.running = false;
      }
    }, delay);
    if (entry.timer.unref) entry.timer.unref();
  }

  /** Syncs attached to a task, with attachment direction and name for the UI. */
  getSyncsForTask(taskId) {
    return this.profiles.filter(p => p.TriggerTaskId === taskId);
  }

  /** Enabled syncs with a cron expression. A task trigger is the primary
   * trigger, but cron remains available as a secondary schedule. */
  getDueProfiles() {
    return this.profiles.filter(p => p.Enabled && p.CronExpression);
  }

  // ─── History ───
  addHistoryEntry(profileId, entry) {
    this.history.unshift({
      Id: crypto.randomUUID(),
      ProfileId: profileId,
      Timestamp: new Date().toISOString(),
      ...entry,
    });
    if (this.history.length > 500) this.history = this.history.slice(0, 500);
    this.saveHistory();
  }

  getHistory(profileId) {
    if (profileId) return this.history.filter(h => h.ProfileId === profileId);
    return this.history;
  }

  getHistoryStats(profileId) {
    const entries = profileId ? this.history.filter(h => h.ProfileId === profileId) : this.history;
    const total = entries.length;
    const success = entries.filter(h => h.Status === 'Success').length;
    const failed = entries.filter(h => h.Status === 'Error' || h.Status === 'Partial').length;
    const lastRun = entries.length > 0 ? entries[0].Timestamp : null;
    return { total, success, failed, lastRun };
  }

  // ─── Execution ───
  async executeSync(profileId, options = {}) {
    const profile = this.getProfile(profileId);
    if (!profile) return { success: false, message: 'Perfil de sincronismo não encontrado' };
    if (!profile.SourcePath) return { success: false, message: 'Perfil sem pasta de origem' };

    const engine = engines.get(profile.Engine);
    const dest = {
      path: profile.DestPath,
      host: profile.Host,
      port: profile.Port,
      user: profile.User,
      password: profile.Password,
    };

    const startTime = Date.now();
    const stepLabels = ['Planejando', engine.id === 'local' || engine.id === 'smb' ? 'Copiando' : 'Transferindo', 'Finalizando'];
    const runId = this.runs ? this.runs.start({
      kind: 'sync', targetId: profileId, name: profile.Name, steps: stepLabels,
    }) : null;
    const step = (i, detail) => { if (this.runs && runId) this.runs.setStep(runId, i, detail); };

    try {
      // Step 1: plan.
      step(0);
      const planned = planner.plan({
        sourceDir: profile.SourcePath,
        destDir: profile.DestPath,
        mode: profile.Mode,
        excludes: profile.Excludes || [],
        mirror: profile.Mirror,
      });
      if (!planned.ok) {
        throw new Error(planned.error);
      }

      if (this.runs && runId) {
        this.runs.appendOutput(runId,
          `${planned.copy.length} arquivo(s) para copiar, ${planned.delete.length} para remover, ${planned.skipped} inalterado(s)`, 'stdout');
      }

      if (planned.copy.length === 0 && planned.delete.length === 0) {
        // Nothing to copy, but retention may still evict old content.
        let retentionResult = { ok: true, deleted: 0 };
        if (profile.Retention && profile.Retention.Enabled) {
          step(1, 'Retenção');
          retentionResult = await this._runRetention(profile, dest, runId);
        }
        const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
        this._finish(profileId, profile, runId, true, duration, planned, [], '', retentionResult);
        const note = retentionResult.deleted > 0 ? `, ${retentionResult.deleted} antigo(s) removido(s)` : '';
        if (this.runs && runId) this.runs.finish(runId, { success: true, message: `Nada a copiar${note} (${duration})` });
        return { success: true, duration, planned, results: [], retention: retentionResult };
      }

      // Step 2: connect, then copy/delete.
      step(1);
      const test = await engine.testConnection(dest);
      if (!test.success) {
        throw new Error(`Destino inacessível: ${test.message || engine.label}`);
      }

      const results = [];
      const total = planned.copy.length + planned.delete.length;

      for (let i = 0; i < planned.copy.length; i++) {
        const item = planned.copy[i];
        if (this.runs && runId) {
          this.runs.setPercent(runId, Math.round((i / total) * 100), item.rel);
        }
        const localPath = path.join(profile.SourcePath, item.rel.replace(/\//g, path.sep));
        const r = await engine.copyFile(localPath, dest, item.rel);
        results.push({ rel: item.rel, op: 'copy', success: r.success, message: r.message || '' });
        if (this.runs && runId && !r.success) this.runs.appendOutput(runId, `${item.rel}: ${r.message}`, 'stderr');
      }

      for (let i = 0; i < planned.delete.length; i++) {
        const rel = planned.delete[i];
        if (this.runs && runId) {
          this.runs.setPercent(runId, Math.round(((planned.copy.length + i) / total) * 100), rel);
        }
        const r = await engine.deleteFile(dest, rel);
        results.push({ rel, op: 'delete', success: r.success, message: r.message || '' });
        if (this.runs && runId && !r.success) this.runs.appendOutput(runId, `${rel}: ${r.message}`, 'stderr');
      }

      step(2);

      // Step 3: retention - delete old content the sync just refreshed.
      // Runs after the copy so freshly-copied files are never re-deleted by
      // a mirror in the same run.
      let retentionResult = { ok: true, deleted: 0 };
      if (profile.Retention && profile.Retention.Enabled) {
        step(2, 'Retenção');
        retentionResult = await this._runRetention(profile, dest, runId);
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
      const copied = results.filter(r => r.op === 'copy' && r.success).length;
      const removed = results.filter(r => r.op === 'delete' && r.success).length;
      const failedOps = results.filter(r => !r.success);
      const success = failedOps.length === 0;

      this._finish(profileId, profile, runId, success, duration, planned, results, '', retentionResult);
      if (this.runs && runId) {
        const retentionNote = retentionResult.deleted > 0 ? `, ${retentionResult.deleted} antigo(s) removido(s)` : '';
        this.runs.finish(runId, {
          success,
          message: success
            ? `${copied} copiado(s), ${removed} removido(s)${retentionNote} em ${duration}`
            : `${failedOps.length} operação(ões) falharam`,
        });
      }
      return { success, duration, planned, results, retention: retentionResult };
    } catch (e) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
      this._finish(profileId, profile, runId, false, duration, null, [], e.message);
      if (this.runs && runId) {
        this.runs.appendOutput(runId, e.message, 'stderr');
        this.runs.failStep(runId, 1, e.message);
        this.runs.finish(runId, { success: false, message: e.message });
      }
      return { success: false, duration, message: e.message };
    }
  }

  /**
   * Retention pass over the destination: list what is there, compile the
   * profile's policy, delete what the rules condemn. A policy that cannot
   * be compiled aborts the pass without touching files.
   */
  async _runRetention(profile, dest, runId) {
    const compiled = retention.compile(profile.Retention);
    if (!compiled.ok) {
      if (this.runs && runId) this.runs.appendOutput(runId, `Retenção ignorada: ${compiled.error}`, 'stderr');
      this.logger.log('WARN', `Retention for ${profile.Name}: ${compiled.error}`);
      return { ok: false, deleted: 0, error: compiled.error };
    }

    let files;
    try {
      files = await engines.listFiles(dest, profile.Engine);
    } catch (e) {
      return { ok: false, deleted: 0, error: e.message };
    }
    if (!files.length) return { ok: true, deleted: 0 };

    const plan = retention.planDeletion(files, compiled);
    if (!plan.ok) return { ok: false, deleted: 0, error: plan.error };
    if (!plan.delete.length) return { ok: true, deleted: 0 };

    if (this.runs && runId) {
      this.runs.appendOutput(runId, `Retenção: ${plan.delete.length} arquivo(s) antigo(s) a remover`, 'stdout');
    }

    const engine = engines.get(profile.Engine);
    let deleted = 0;
    for (const item of plan.delete) {
      const r = await engine.deleteFile(dest, item.rel);
      if (r.success) {
        deleted++;
      } else {
        this.logger.log('WARN', `Retention delete failed: ${profile.Name} - ${item.rel}: ${r.message || '?'}`);
        if (this.runs && runId) this.runs.appendOutput(runId, `${item.rel}: ${r.message}`, 'stderr');
      }
    }
    this.logger.audit('SYNC_RETENTION_DELETED', {
      targetType: 'sync', target: profile.Id,
      after: { profile: profile.Name, deleted, planned: plan.delete.length },
    });
    return { ok: true, deleted, planned: plan.delete.length };
  }

  /**
   * Analyze a folder's content pattern and propose a retention policy.
   * Powers the wizard's "identify the pattern" step - read-only, never
   * deletes anything.
   *
   * @param {string} dir - folder to inspect
   * @param {object} [options] - { useNames: true, useMetadata: false }
   *   the toggles choose WHERE the dates come from: file names, file
   *   metadata (mtime), or both (names win per file).
   */
  analyzeFolder(dir, options = {}) {
    if (!dir) return { ok: false, error: 'Pasta não informada' };
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) return { ok: false, error: `Pasta não encontrada: ${dir}` };
    return retention.analyze(resolved, {
      useNames: options.useNames !== false,
      useMetadata: options.useMetadata === true,
    });
  }

  /**
   * One-shot retention over a plain local folder: compile the policy, list
   * the folder, delete what the rules condemn. This is the engine behind the
   * dedicated Retention screen - it does NOT need a sync profile, it only
   * needs a folder and rules. Every deletion is audited.
   *
   * @param {string} dir - absolute folder path
   * @param {object} retentionCfg - same shape as a profile's Retention block
   * @param {object} [hooks] - { now } injection for tests
   */
  async runRetentionNow(dir, retentionCfg, hooks = {}) {
    if (!dir) return { ok: false, deleted: 0, error: 'Pasta não informada' };
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) return { ok: false, deleted: 0, error: `Pasta não encontrada: ${dir}` };

    const cfg = normalizeRetention(retentionCfg);
    const compiled = retention.compile(cfg);
    if (!compiled.ok) return { ok: false, deleted: 0, error: compiled.error };

    const files = retention.scanDest(resolved);
    if (!files.length) return { ok: true, deleted: 0, freed: 0, planned: 0 };

    const plan = retention.planDeletion(files, compiled, { now: hooks.now });
    if (!plan.ok) return { ok: false, deleted: 0, error: plan.error };
    if (!plan.delete.length) return { ok: true, deleted: 0, freed: 0, planned: 0 };

    // Local engine deleteFile also prunes the empty parent folders a dead
    // snapshot would leave behind - exactly what a dated-folder archive wants.
    // planDeletion reports rel/reason only; sizes come from the scan.
    const sizeOf = new Map(files.map(f => [f.rel, f.size || 0]));
    const engine = engines.get('local');
    const dest = { path: resolved };
    let deleted = 0;
    let freed = 0;
    const failures = [];
    for (const item of plan.delete) {
      const r = await engine.deleteFile(dest, item.rel);
      if (r.success) {
        deleted++;
        freed += sizeOf.get(item.rel) || 0;
        this.logger.audit('RETENTION_FILE_DELETED', {
          targetType: 'retention', target: resolved,
          before: { rel: item.rel, size: sizeOf.get(item.rel) || 0 },
          after: { reason: item.reason, detail: item.detail || '' },
        });
      } else {
        failures.push({ rel: item.rel, message: r.message || '?' });
        this.logger.log('WARN', `Retention delete failed: ${item.rel}: ${r.message || '?'}`);
      }
    }
    this.logger.audit('RETENTION_RUN', {
      targetType: 'retention', target: resolved,
      after: { deleted, freed, planned: plan.delete.length, failed: failures.length },
    });
    return { ok: true, deleted, freed, planned: plan.delete.length, failed: failures };
  }

  /**
   * Preview which destination files a policy would delete, without touching
   * anything. The wizard shows this list before the user confirms.
   */
  previewRetention(dir, retentionCfg, hooks = {}) {
    const compiled = retention.compile(normalizeRetention(retentionCfg));
    if (!compiled.ok) return { ok: false, error: compiled.error };
    const files = retention.scanDest(dir);
    const plan = retention.planDeletion(files, compiled, { now: hooks.now });
    if (!plan.ok) return { ok: false, error: plan.error };
    // Everything the UI needs to show the rules and every single file:
    // what goes, and what a keep rule rescued from a delete rule.
    return {
      ok: true,
      delete: plan.delete,
      kept: plan.kept,
      rules: plan.rules,
      minKeep: plan.minKeep,
      dateSource: plan.dateSource,
      totalFiles: files.length,
      totalSnapshots: plan.totalSnapshots,
      deleteBytes: plan.delete.reduce((s, d) => s + (d.size || 0), 0),
    };
  }

  /**
   * Dry-run of the whole sync: the exact planner the execution uses, plus a
   * retention pass simulated over the destination as it would look after the
   * copy. Reads nothing but the filesystem; writes nothing. The wizard's
   * simulator renders this so the user sees precisely which files will be
   * copied, skipped or deleted - "simulated", never "executed".
   *
   * @param {object} like - { SourcePath, DestPath, Engine, Mode, Mirror,
   *                         Excludes, Retention } - a draft profile
   */
  async previewSyncPlan(like) {
    const p = like || {};
    const base = {
      copy: [], delete: [], skipped: [], totalSource: 0, totalBytes: 0,
      retention: [], retentionDeletedBytes: 0,
    };

    let planned;
    try {
      planned = planner.plan({
        sourceDir: p.SourcePath,
        destDir: p.DestPath,
        mode: p.Mode,
        excludes: p.Excludes || [],
        mirror: p.Mirror,
      });
    } catch (e) {
      return { ok: false, error: e.message, ...base };
    }
    if (!planned.ok) return { ok: false, error: planned.error, ...base };

    // The planner reports rels; the simulator re-attaches sizes and mtimes
    // so the UI can show WHEN a file would age out and how much each
    // operation moves.
    const srcDir = path.resolve(p.SourcePath);
    const byRel = (files) => new Map(files.map(f => [f.rel, f]));
    const withMeta = (rels, files, reason) => rels.map(rel => {
      const f = files.get(rel);
      return { rel, reason, size: f ? f.size : 0, mtimeMs: f ? f.mtimeMs : 0 };
    });

    const sourceFiles = planner.scan(srcDir).filter(f =>
      !(p.Excludes || []).some(pat => { const re = planner.compileExclude(pat); return re && re.test(f.rel); }));
    const sourceMap = byRel(sourceFiles);

    // Skipped = source files the incremental planner left alone.
    const copyRels = new Set(planned.copy.map(c => c.rel));
    const skipped = sourceFiles.filter(f => !copyRels.has(f.rel));

    const retCfg = normalizeRetention(p.Retention);
    let retentionDoomed = new Map();
    let postCopyMap = new Map(); // destination as it would be after the copy
    if (retCfg.Enabled) {
      const compiled = retention.compile(retCfg);
      if (!compiled.ok) {
        return { ok: false, error: compiled.error, ...base, copy: planned.copy, delete: planned.delete, skipped, totalSource: planned.totalSource, totalBytes: planned.totalBytes };
      }
      // Retention looks at the destination AS IT WOULD BE after the copy:
      // what is there now, minus what the mirror would remove, plus what the
      // copy would add (stamped with the source's mtimes).
      const destFiles = await engines.listFiles(
        { path: p.DestPath, host: p.Host, port: p.Port, user: p.User, password: p.Password },
        p.Engine || 'local');
      postCopyMap = byRel(destFiles.filter(f => !planned.delete.includes(f.rel)));
      for (const c of planned.copy) {
        const f = sourceMap.get(c.rel);
        if (f) postCopyMap.set(c.rel, { rel: c.rel, size: f.size, mtimeMs: f.mtimeMs });
      }
      const verdict = retention.planDeletion([...postCopyMap.values()], compiled);
      if (verdict.ok) {
        retentionDoomed = new Map(verdict.delete.map(d => [d.rel, d]));
      }
    }

    // Retention sizes come from the post-copy destination map.
    const destSize = (rel) => (postCopyMap.get(rel) || {}).size || 0;

    return {
      ok: true,
      copy: planned.copy.map(c => {
        const f = sourceMap.get(c.rel);
        return { rel: c.rel, reason: c.reason, size: f ? f.size : 0, mtimeMs: f ? f.mtimeMs : 0 };
      }),
      delete: planned.delete.map(rel => ({ rel, size: destSize(rel) })),
      skipped: skipped.map(f => ({ rel: f.rel, size: f.size, mtimeMs: f.mtimeMs })),
      totalSource: planned.totalSource,
      totalBytes: planned.totalBytes,
      retention: [...retentionDoomed.values()].map(d => ({ ...d, size: destSize(d.rel) })),
      retentionDeletedBytes: [...retentionDoomed.values()].reduce((s, d) => s + destSize(d.rel), 0),
    };
  }

  /** Persist the outcome: profile status, history entry, audit log. */
  _finish(profileId, profile, runId, success, duration, planned, results, message, retentionResult) {
    this.updateProfile({
      Id: profileId,
      LastRun: new Date().toISOString(),
      LastStatus: success ? 'Success' : 'Error',
    });
    this.addHistoryEntry(profileId, {
      ProfileName: profile.Name,
      Status: success ? 'Success' : 'Error',
      Duration: duration,
      Copied: results.filter(r => r.op === 'copy' && r.success).length,
      Deleted: results.filter(r => r.op === 'delete' && r.success).length,
      Failed: results.filter(r => !r.success).length,
      TotalSource: planned ? planned.totalSource : 0,
      TotalBytes: planned ? planned.totalBytes : 0,
      Message: message || (success ? 'Sincronismo concluído' : 'Falhou'),
      Results: results.slice(0, 100),
      RetentionDeleted: retentionResult ? retentionResult.deleted : 0,
    });
    this.logger.audit('SYNC_EXECUTED', {
      targetType: 'sync', target: profileId,
      after: { profile: profile.Name, success, duration },
    });
  }

  // ─── Task trigger wiring ───
  /**
   * Called with a finished task's history entry. Syncs attached to the task
   * run only when the task succeeded (unless TriggerOnFailure is set), so a
   * failed build never overwrites good artifacts with bad ones.
   */
  async handleTaskFinished(entry) {
    if (!entry || !entry.TaskId) return [];
    const attached = this.getSyncsForTask(entry.TaskId);
    if (!attached.length) return [];

    const results = [];
    for (const profile of attached) {
      if (!profile.Enabled) continue;
      const taskSucceeded = entry.Status === 'Success';
      if (!taskSucceeded && !profile.TriggerOnFailure) {
        this.logger.log('INFO', `Sync ${profile.Name} skipped: task failed`);
        continue;
      }
      this.logger.log('INFO', `Running task-triggered sync: ${profile.Name}`);
      const r = await this.executeSync(profile.Id, { triggeredBy: 'task', taskEntry: entry });
      results.push({ profileId: profile.Id, name: profile.Name, ...r });
    }
    return results;
  }

  /**
   * Fire the hook if the task that just finished has syncs attached.
   * Cheap on purpose: called from the scheduler for every task execution.
   */
  maybeTriggerForTask(entry) {
    if (!entry || !entry.TaskId) return;
    if (!this.getSyncsForTask(entry.TaskId).length) return;
    if (this.onTaskFinished) {
      Promise.resolve(this.onTaskFinished(entry)).catch((err) => {
        this.logger.error('Task-triggered sync failed', err);
      });
    }
  }
}

module.exports = SyncManager;