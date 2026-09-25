const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');
const CronParser = require('./cronParser');
const retention = require('./sync/retention');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;
const RUN_LOCK_STALE_MS = 3600000;

function isPidAlive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function requireUuid(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new Error('ID de perfil de retenção inválido');
  return id;
}

function integerField(raw, key, fallback, min, label) {
  if (raw[key] === undefined || raw[key] === null || raw[key] === '') return fallback;
  const value = Number(raw[key]);
  if (!Number.isInteger(value) || value < min) throw new Error(`${label} inválido`);
  return value;
}

function decimalField(raw, key, fallback, min, label) {
  if (raw[key] === undefined || raw[key] === null || raw[key] === '') return fallback;
  const value = Number(raw[key]);
  if (!Number.isFinite(value) || value < min) throw new Error(`${label} inválido`);
  return value;
}

function normalizeRetention(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Política de retenção inválida');
  }
  const normalized = {
    Enabled: value.Enabled === true,
    DateSource: value.DateSource === 'names' ? 'names' : 'metadata',
    FileExtensions: retention.normalizeExtensions(value),
    ByAge: value.ByAge === true,
    KeepDays: integerField(value, 'KeepDays', 30, 1, 'KeepDays'),
    ByCount: value.ByCount === true,
    KeepCount: integerField(value, 'KeepCount', 10, 1, 'KeepCount'),
    BySize: value.BySize === true,
    FreeGb: decimalField(value, 'FreeGb', 0, 0, 'FreeGb'),
    ByWeekly: value.ByWeekly === true,
    WeeklyKeepWeeks: integerField(value, 'WeeklyKeepWeeks', 8, 1, 'WeeklyKeepWeeks'),
    ByBiweekly: value.ByBiweekly === true,
    BiweeklyKeepPeriods: integerField(value, 'BiweeklyKeepPeriods', 12, 1, 'BiweeklyKeepPeriods'),
    ByMonthly: value.ByMonthly === true,
    MonthlyKeepMonths: integerField(value, 'MonthlyKeepMonths', 12, 1, 'MonthlyKeepMonths'),
    MinKeep: integerField(value, 'MinKeep', 3, 0, 'MinKeep'),
  };
  const compiled = retention.compile(normalized);
  if (!compiled.ok) throw new Error(compiled.error);
  return normalized;
}

class RetentionManager {
  constructor(deps = {}) {
    this.syncManager = deps.syncManager || null;
    this.cronParser = deps.cronParser || new CronParser();
    this.logger = deps.logger || null;
    this.configDir = deps.configDir || paths.configDir();
    fs.mkdirSync(this.configDir, { recursive: true });
    this.profilesFile = path.join(this.configDir, 'retention-profiles.json');
    this.profilesLockFile = `${this.profilesFile}.lock`;
    this.runLockDir = path.join(this.configDir, 'retention-run-locks');
    this.runningProfiles = new Set();
    this.runningFolders = new Set();
    this.profiles = this.loadProfiles();
  }

  loadProfiles() {
    try {
      const data = JSON.parse(fs.readFileSync(this.profilesFile, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (err) {
      return [];
    }
  }

  reload() {
    this.profiles = this.loadProfiles();
    return this.getAllProfiles();
  }

  _atomicWrite(file, value) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, file);
    } finally {
      if (fd !== null && fd !== undefined) {
        try { fs.closeSync(fd); } catch (err) {}
      }
      try { fs.rmSync(temp, { force: true }); } catch (err) {}
    }
  }

  _lockIsStale(file, staleMs, breakLiveAfter = staleMs) {
    let stat;
    try { stat = fs.statSync(file); } catch (err) { return true; }
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { record = null; }
    if (record && record.pid && isPidAlive(record.pid) === false) return true;
    return Date.now() - stat.mtimeMs > (record ? breakLiveAfter : staleMs);
  }

  _ownsLock(file, token) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')).token === token;
    } catch (err) {
      return false;
    }
  }

  _acquireFileLock(file, staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS, breakLiveAfter = staleMs) {
    const token = crypto.randomUUID();
    const deadline = Date.now() + waitMs;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    while (true) {
      let fd;
      try {
        fd = fs.openSync(file, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        return token;
      } catch (err) {
        if (fd !== null && fd !== undefined) {
          try { fs.closeSync(fd); } catch (closeErr) {}
        }
        if (err.code !== 'EEXIST') throw err;
        if (this._lockIsStale(file, staleMs, breakLiveAfter)) {
          try { fs.unlinkSync(file); } catch (unlinkErr) {}
          continue;
        }
        if (waitMs <= 0) return null;
        if (Date.now() >= deadline) throw new Error('Não foi possível bloquear os perfis de retenção');
        pause(20);
      }
    }
  }

  _releaseFileLock(file, token) {
    if (!this._ownsLock(file, token)) return;
    try { fs.unlinkSync(file); } catch (err) {}
  }

  _withProfilesLock(callback) {
    const token = this._acquireFileLock(this.profilesLockFile);
    try {
      const fresh = this.loadProfiles();
      const result = callback(fresh);
      this._atomicWrite(this.profilesFile, fresh);
      this.profiles = fresh;
      return result;
    } finally {
      this._releaseFileLock(this.profilesLockFile, token);
    }
  }

  _validateProfile(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Perfil de retenção inválido');
    const name = typeof data.Name === 'string' ? data.Name.trim() : '';
    if (!name) throw new Error('Nome é obrigatório');
    if (name.length > 200) throw new Error('Nome deve ter no máximo 200 caracteres');

    const rawFolder = typeof data.FolderPath === 'string' ? data.FolderPath.trim() : '';
    if (!rawFolder || !path.isAbsolute(rawFolder)) throw new Error('FolderPath deve ser absoluto');
    const folderPath = path.normalize(rawFolder);
    let stat;
    try { stat = fs.statSync(folderPath); } catch (err) { throw new Error('FolderPath não existe'); }
    if (!stat.isDirectory()) throw new Error('FolderPath não é um diretório');

    const cronExpression = typeof data.CronExpression === 'string' ? data.CronExpression.trim().replace(/\s+/g, ' ') : '';
    if (!this.cronParser.validate(cronExpression)) throw new Error('CronExpression deve ter cinco campos válidos');

    return {
      Id: data.Id,
      Name: name,
      Description: typeof data.Description === 'string' ? data.Description.trim() : '',
      FolderPath: folderPath,
      Retention: normalizeRetention(data.Retention === undefined ? {} : data.Retention),
      CronExpression: cronExpression,
      Enabled: data.Enabled !== false,
    };
  }

  createProfile(data) {
    const now = new Date().toISOString();
    const profile = this._validateProfile({ ...data, Id: crypto.randomUUID() });
    const created = this._withProfilesLock((profiles) => {
      const record = {
        ...profile,
        CreatedAt: now,
        UpdatedAt: now,
        LastRun: null,
        LastStatus: null,
        LastResult: null,
      };
      profiles.push(record);
      return { ...record };
    });
    if (this.logger && this.logger.audit) {
      this.logger.audit('RETENTION_PROFILE_CREATED', { targetType: 'retention-profile', target: created.Id, after: { Name: created.Name } });
    }
    return created;
  }

  updateProfile(data) {
    if (!data || typeof data !== 'object') return null;
    const id = requireUuid(data.Id);
    const updated = this._withProfilesLock((profiles) => {
      const index = profiles.findIndex(profile => profile.Id === id);
      if (index === -1) return null;
      const current = profiles[index];
      const normalized = this._validateProfile({ ...current, ...data, Id: id });
      const record = {
        ...current,
        ...normalized,
        CreatedAt: current.CreatedAt,
        UpdatedAt: new Date().toISOString(),
        LastRun: current.LastRun,
        LastStatus: current.LastStatus,
        LastResult: current.LastResult,
      };
      profiles[index] = record;
      return { ...record };
    });
    if (updated && this.logger && this.logger.audit) {
      this.logger.audit('RETENTION_PROFILE_UPDATED', { targetType: 'retention-profile', target: id, after: { Name: updated.Name } });
    }
    return updated;
  }

  deleteProfile(id) {
    requireUuid(id);
    const deleted = this._withProfilesLock((profiles) => {
      const index = profiles.findIndex(profile => profile.Id === id);
      if (index === -1) return null;
      const [profile] = profiles.splice(index, 1);
      return { ...profile };
    });
    if (deleted && this.logger && this.logger.audit) {
      this.logger.audit('RETENTION_PROFILE_DELETED', { targetType: 'retention-profile', target: id, before: { Name: deleted.Name } });
    }
    return Boolean(deleted);
  }

  getProfile(id) {
    const profile = this.profiles.find(item => item.Id === id);
    return profile ? { ...profile } : null;
  }

  getAllProfiles() {
    return this.profiles.map(profile => ({ ...profile }));
  }

  getDueProfiles() {
    return this.profiles.filter(profile => profile.Enabled !== false && profile.CronExpression);
  }

  _runLockFile(id, folderPath) {
    const folderKey = crypto.createHash('sha256').update(path.resolve(folderPath).toLowerCase()).digest('hex');
    return path.join(this.runLockDir, `${folderKey}.lock`);
  }

  _acquireRunLock(id, folderPath) {
    if (this.runningProfiles.has(id) || this.runningFolders.has(folderPath)) return null;
    const file = this._runLockFile(id, folderPath);
    const token = this._acquireFileLock(file, RUN_LOCK_STALE_MS, 0, Infinity);
    if (!token) return null;
    this.runningProfiles.add(id);
    this.runningFolders.add(folderPath);
    return { file, token };
  }

  _saveRunResult(id, result) {
    this._withProfilesLock((profiles) => {
      const profile = profiles.find(item => item.Id === id);
      if (!profile) return;
      let status = 'Error';
      if (result && result.ok === true) {
        status = Array.isArray(result.failed) && result.failed.length ? 'Partial' : 'Success';
      }
      profile.LastRun = new Date().toISOString();
      profile.LastStatus = status;
      profile.LastResult = result;
    });
  }

  async runProfile(profileId) {
    let id;
    try {
      id = requireUuid(profileId);
    } catch (err) {
      return { ok: false, deleted: 0, error: err.message };
    }
    const profile = this.getProfile(id);
    if (!profile) return { ok: false, deleted: 0, error: 'Perfil de retenção não encontrado' };
    if (!this.syncManager || typeof this.syncManager.runRetentionNow !== 'function') {
      return { ok: false, deleted: 0, error: 'Executor de retenção indisponível' };
    }

    let runLock;
    try {
      runLock = this._acquireRunLock(id, profile.FolderPath);
    } catch (err) {
      return { ok: false, deleted: 0, error: err.message };
    }
    if (!runLock) return { ok: false, deleted: 0, error: 'Perfil de retenção já está em execução' };

    let result;
    try {
      result = await this.syncManager.runRetentionNow(profile.FolderPath, profile.Retention);
      if (!result || typeof result !== 'object') {
        result = { ok: false, deleted: 0, error: 'Executor de retenção não retornou resultado' };
      }
    } catch (err) {
      result = { ok: false, deleted: 0, error: err.message };
    }

    try {
      this._saveRunResult(id, result);
    } catch (err) {
      if (this.logger && this.logger.error) this.logger.error(`Retention profile result persistence failed: ${id}`, err);
    } finally {
      this.runningProfiles.delete(id);
      this.runningFolders.delete(profile.FolderPath);
      this._releaseFileLock(runLock.file, runLock.token);
    }

    if (this.logger && this.logger.audit) {
      this.logger.audit('RETENTION_PROFILE_EXECUTED', {
        targetType: 'retention-profile', target: id,
        after: { profile: profile.Name, status: this.getProfile(id) ? this.getProfile(id).LastStatus : 'Error' },
      });
    }
    return result;
  }
}

module.exports = RetentionManager;
module.exports.UUID_RE = UUID_RE;
