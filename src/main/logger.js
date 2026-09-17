// logger.js - Enhanced Logging Module
// Separate log streams: app, error, audit
// Structured JSON entries for machine parsing + human-readable format
const fs = require('fs');
const path = require('path');

class Logger {
  constructor(logDir) {
    this.logDir = logDir;
    this.buffer = [];
    this.errorBuffer = [];
    this.auditBuffer = [];
    this.maxBufferSize = 50;
    this.maxErrorBuffer = 20;
    this.maxAuditBuffer = 30;
    this.inMemoryLogs = [];
    this.inMemoryErrors = [];
    this.inMemoryAudit = [];
    this.maxInMemory = 2000;

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
  }

  // ─── General App Log ───
  log(level, message, meta = null) {
    const timestamp = new Date();
    const entry = this._formatEntry(timestamp, level, message, meta);

    this.buffer.push(entry);
    this.inMemoryLogs.push({ timestamp, level, message, meta });

    if (this.inMemoryLogs.length > this.maxInMemory) {
      this.inMemoryLogs = this.inMemoryLogs.slice(-this.maxInMemory);
    }
    if (this.buffer.length >= this.maxBufferSize) {
      this.flush();
    }
  }

  info(message, meta) { this.log('INFO', message, meta); }
  warn(message, meta) { this.log('WARN', message, meta); }

  // ─── Error Log ───
  error(message, error = null, context = null) {
    const timestamp = new Date();
    const errorData = error ? {
      name: error.name || 'Error',
      message: error.message || String(error),
      stack: error.stack || null,
      code: error.code || null
    } : null;

    const entry = this._formatEntry(timestamp, 'ERROR', message, { error: errorData, context });
    this.errorBuffer.push(entry);

    this.inMemoryErrors.push({
      timestamp,
      level: 'ERROR',
      message,
      error: errorData,
      context
    });

    if (this.inMemoryErrors.length > this.maxInMemory) {
      this.inMemoryErrors = this.inMemoryErrors.slice(-this.maxInMemory);
    }
    if (this.errorBuffer.length >= this.maxErrorBuffer) {
      this.flushErrors();
    }

    // Also log to general log
    this.log('ERROR', message);
  }

  // ─── Audit Log ───
  audit(action, details = {}) {
    const timestamp = new Date();
    const entry = {
      timestamp: timestamp.toISOString(),
      action,
      user: details.user || 'system',
      target: details.target || null,
      targetType: details.targetType || null,
      actor: details.actor || null,
      via: details.via || null,
      before: details.before || null,
      after: details.after || null,
      result: details.result || 'success',
      ipAddress: details.ipAddress || details.ip || null,
      metadata: details.metadata || null
    };

    const formatted = this._formatAuditEntry(entry);
    this.auditBuffer.push(formatted);

    this.inMemoryAudit.push(entry);

    if (this.inMemoryAudit.length > this.maxInMemory) {
      this.inMemoryAudit = this.inMemoryAudit.slice(-this.maxInMemory);
    }
    if (this.auditBuffer.length >= this.maxAuditBuffer) {
      this.flushAudit();
    }
  }

  // Audit helpers
  auditTaskCreated(task) {
    this.audit('TASK_CREATED', {
      target: task.Id,
      targetType: 'task',
      after: { name: task.Name, cron: task.CronExpression, script: task.ScriptPath }
    });
  }

  auditTaskUpdated(taskId, before, after) {
    this.audit('TASK_UPDATED', {
      target: taskId,
      targetType: 'task',
      before,
      after
    });
  }

  auditTaskDeleted(taskId, taskName) {
    this.audit('TASK_DELETED', {
      target: taskId,
      targetType: 'task',
      before: { name: taskName }
    });
  }

  auditTaskExecuted(taskId, taskName, result) {
    this.audit('TASK_EXECUTED', {
      target: taskId,
      targetType: 'task',
      after: { name: taskName, status: result.success ? 'success' : 'error', duration: result.Duration },
      result: result.success ? 'success' : 'error'
    });
  }

  auditServiceInstalled(serviceName, appPath) {
    this.audit('SERVICE_INSTALLED', {
      target: serviceName,
      targetType: 'service',
      after: { appPath }
    });
  }

  auditServiceStarted(serviceName) {
    this.audit('SERVICE_STARTED', { target: serviceName, targetType: 'service' });
  }

  auditServiceStopped(serviceName) {
    this.audit('SERVICE_STOPPED', { target: serviceName, targetType: 'service' });
  }

  auditServiceUninstalled(serviceName) {
    this.audit('SERVICE_UNINSTALLED', { target: serviceName, targetType: 'service' });
  }

  auditSettingsChanged(key, oldValue, newValue) {
    this.audit('SETTINGS_CHANGED', {
      target: key,
      targetType: 'setting',
      before: { value: oldValue },
      after: { value: newValue }
    });
  }

  auditProfileSwitched(fromProfile, toProfile) {
    this.audit('PROFILE_SWITCHED', {
      target: toProfile,
      targetType: 'profile',
      before: { profile: fromProfile },
      after: { profile: toProfile }
    });
  }

  auditImport(count) {
    this.audit('TASKS_IMPORTED', {
      targetType: 'task',
      after: { count }
    });
  }

  auditExport(format, count) {
    this.audit('TASKS_EXPORTED', {
      targetType: 'task',
      after: { format, count }
    });
  }

  auditServiceDeployed(taskId, serviceName) {
    this.audit('SERVICE_DEPLOYED', {
      target: taskId,
      targetType: 'task',
      after: { serviceName }
    });
  }

  auditServiceUndeployed(taskId, serviceName) {
    this.audit('SERVICE_UNDEPLOYED', {
      target: taskId,
      targetType: 'task',
      after: { serviceName }
    });
  }

  auditNssmInstalled(manager, success) {
    this.audit('NSSM_INSTALLED', {
      target: 'nssm',
      targetType: 'tool',
      after: { manager, success }
    });
  }

  // ─── Flush Methods ───
  flush() {
    this._flushTo(this.buffer, this._logFilePath());
    this.flushErrors();
    this.flushAudit();
  }

  flushErrors() {
    this._flushTo(this.errorBuffer, this._errorFilePath());
  }

  flushAudit() {
    this._flushTo(this.auditBuffer, this._auditFilePath());
  }

  _flushTo(buffer, filePath) {
    if (buffer.length === 0) return;
    const content = buffer.join('\n') + '\n';
    buffer.length = 0;
    try {
      fs.appendFileSync(filePath, content, 'utf8');
    } catch (e) {
      console.error('Failed to flush log:', e.message);
    }
  }

  // ─── File Paths ───
  _dateStr(date) { return (date || new Date()).toISOString().substring(0, 10); }
  _logFilePath() { return path.join(this.logDir, `kyrion-${this._dateStr()}.log`); }
  _errorFilePath() { return path.join(this.logDir, `kyrion-errors-${this._dateStr()}.log`); }
  _auditFilePath() { return path.join(this.logDir, `kyrion-audit-${this._dateStr()}.log`); }

  // ─── Formatting ───
  _formatEntry(timestamp, level, message, meta) {
    const ts = timestamp.toISOString().replace('T', ' ').substring(0, 19);
    let line = `[${ts}] [${level}] ${message}`;
    if (meta) {
      try { line += ` | ${JSON.stringify(meta)}`; } catch (e) { line += ` | [meta]`; }
    }
    return line;
  }

  _formatAuditEntry(entry) {
    const parts = [
      `[${entry.timestamp}] [AUDIT]`,
      `action=${entry.action}`,
      `target=${entry.target || '-'}`
    ];
    if (entry.result !== 'success') parts.push(`result=${entry.result}`);
    // Who did it, and from where. Without these the audit trail on disk can
    // only say that something changed, not who changed it.
    if (entry.actor) parts.push(`actor=${entry.actor}`);
    if (entry.via) parts.push(`via=${entry.via}`);
    if (entry.ipAddress) parts.push(`ip=${entry.ipAddress}`);
    if (entry.before) parts.push(`before=${JSON.stringify(entry.before)}`);
    if (entry.after) parts.push(`after=${JSON.stringify(entry.after)}`);
    return parts.join(' ');
  }

  // ─── Query Methods ───
  getRecentLogs(count = 50) {
    return this.inMemoryLogs.slice(-count);
  }

  /**
   * Recent log lines from every process that writes to this log directory.
   *
   * inMemoryLogs only holds what THIS process logged. Tasks and backups run in
   * the service process, so reading memory alone showed the GUI nothing about
   * them. The log files on disk are the shared record, so read those and merge
   * in whatever this process has buffered but not yet flushed.
   */
  getRecentLogsFromDisk(count = 200, days = 2) {
    const entries = [];

    for (let i = 0; i < days; i++) {
      const day = new Date(Date.now() - i * 86400000);
      const file = path.join(this.logDir, `kyrion-${this._dateStr(day)}.log`);
      let content;
      try {
        if (!fs.existsSync(file)) continue;
        content = fs.readFileSync(file, 'utf8');
      } catch (e) { continue; }

      for (const line of content.split('\n')) {
        const parsed = this._parseLogLine(line);
        if (parsed) entries.push(parsed);
      }
    }

    // Lines this process logged since the last flush are not on disk yet.
    const onDisk = new Set(entries.map(e => `${e.timestamp.getTime()}|${e.message}`));
    for (const mem of this.inMemoryLogs) {
      const key = `${new Date(mem.timestamp).setMilliseconds(0)}|${mem.message}`;
      if (!onDisk.has(key)) {
        entries.push({ timestamp: new Date(mem.timestamp), level: mem.level, message: mem.message, meta: mem.meta });
      }
    }

    entries.sort((a, b) => a.timestamp - b.timestamp);
    return entries.slice(-count);
  }


  /**
   * Recent ERROR entries from every process that writes here.
   *
   * inMemoryErrors only holds what THIS process logged, so nothing the Windows
   * service recorded ever reached the Logs screen - the same gap that was fixed
   * for the application log.
   */
  getRecentErrorsFromDisk(count = 200, days = 3) {
    const entries = [];

    for (let i = 0; i < days; i++) {
      const day = new Date(Date.now() - i * 86400000);
      const file = path.join(this.logDir, `kyrion-errors-${this._dateStr(day)}.log`);
      for (const line of this._readTail(file)) {
        const parsed = this._parseLogLine(line);
        if (!parsed) continue;
        // The error log stores { error, context } as the meta blob.
        const meta = parsed.meta || {};
        entries.push({
          timestamp: parsed.timestamp,
          level: parsed.level || 'ERROR',
          message: parsed.message,
          error: meta.error || null,
          context: meta.context || null,
        });
      }
    }

    for (const mem of this.inMemoryErrors) {
      entries.push(mem);
    }

    return this._dedupeSort(entries, count);
  }

  /** Recent AUDIT entries from every process that writes here. */
  getRecentAuditFromDisk(count = 200, days = 7) {
    const entries = [];

    for (let i = 0; i < days; i++) {
      const day = new Date(Date.now() - i * 86400000);
      const file = path.join(this.logDir, `kyrion-audit-${this._dateStr(day)}.log`);
      for (const line of this._readTail(file)) {
        const parsed = this._parseAuditLine(line);
        if (parsed) entries.push(parsed);
      }
    }

    for (const mem of this.inMemoryAudit) {
      entries.push(Object.assign({}, mem, { timestamp: new Date(mem.timestamp) }));
    }

    return this._dedupeSort(entries, count);
  }

  /** Parse a line written by _formatAuditEntry. */
  _parseAuditLine(line) {
    const head = /^\[([^\]]+)\] \[AUDIT\] (.*)$/.exec(line.trim());
    if (!head) return null;

    const timestamp = new Date(head[1]);
    if (isNaN(timestamp.getTime())) return null;

    const rest = head[2];
    const entry = { timestamp, action: '', target: null, result: 'success', before: null, after: null };

    const action = /(?:^|\s)action=(\S+)/.exec(rest);
    if (action) entry.action = action[1];
    const target = /(?:^|\s)target=(\S+)/.exec(rest);
    if (target && target[1] !== '-') entry.target = target[1];
    const result = /(?:^|\s)result=(\S+)/.exec(rest);
    if (result) entry.result = result[1];

    // before= and after= hold JSON; take each up to the next " key=" boundary.
    for (const key of ['before', 'after']) {
      const at = rest.indexOf(` ${key}=`);
      if (at === -1) continue;
      let json = rest.slice(at + key.length + 2);
      const next = json.search(/\s(?:before|after)=/);
      if (next !== -1) json = json.slice(0, next);
      try { entry[key] = JSON.parse(json); } catch (e) { entry[key] = json; }
    }

    // The web interface records who did it; surface that rather than burying it.
    const actor = /(?:^|\s)actor=([^\s]+(?: \([^)]*\))?)/.exec(rest);
    if (actor) entry.actor = actor[1];
    const via = /(?:^|\s)via=(\S+)/.exec(rest);
    if (via) entry.via = via[1];
    const ip = /(?:^|\s)ip=(\S+)/.exec(rest);
    if (ip) entry.ipAddress = ip[1];

    return entry;
  }

  /**
   * Last N KB of a log file, as lines.
   * Reading a whole day of a busy service meant parsing megabytes on every
   * refresh; only the tail is ever shown.
   */
  _readTail(file, maxBytes = 512 * 1024) {
    let handle;
    try {
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      if (length <= 0) return [];

      const buffer = Buffer.alloc(length);
      handle = fs.openSync(file, 'r');
      fs.readSync(handle, buffer, 0, length, start);

      const text = buffer.toString('utf8');
      const lines = text.split('\n');
      // A partial first line when the file was truncated mid-entry.
      if (start > 0) lines.shift();
      return lines.filter(Boolean);
    } catch (e) {
      return [];
    } finally {
      if (handle !== undefined) { try { fs.closeSync(handle); } catch (e) {} }
    }
  }

  /** Drop duplicates (a line can be both on disk and still in memory), newest last. */
  _dedupeSort(entries, count) {
    const seen = new Set();
    const unique = [];
    for (const entry of entries) {
      const key = `${new Date(entry.timestamp).setMilliseconds(0)}|${entry.action || entry.message || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(entry);
    }
    unique.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    return count ? unique.slice(-count) : unique;
  }

  /** Parse a line written by _formatEntry: "[ts] [LEVEL] message | {meta}" */
  _parseLogLine(line) {
    const match = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([A-Z]+)\] ([\s\S]*)$/.exec(line.trim());
    if (!match) return null;

    const [, ts, level, rest] = match;
    let message = rest;
    let meta = null;

    // Meta is appended as " | {json}". Split on the LAST such separator so a
    // pipe inside the message itself does not truncate it.
    const sep = rest.lastIndexOf(' | {');
    if (sep !== -1) {
      try {
        meta = JSON.parse(rest.slice(sep + 3));
        message = rest.slice(0, sep);
      } catch (e) { /* not meta after all - keep the whole line as the message */ }
    }

    const timestamp = new Date(ts.replace(' ', 'T') + 'Z');
    if (isNaN(timestamp.getTime())) return null;
    return { timestamp, level, message, meta };
  }

  getRecentErrors(count = 50) {
    return this.inMemoryErrors.slice(-count);
  }

  getRecentAudit(count = 50) {
    return this.inMemoryAudit.slice(-count);
  }

  getLogsFromDate(date) {
    const target = date instanceof Date ? date : new Date(date);
    const dayStr = target.toISOString().substring(0, 10);
    return this.inMemoryLogs.filter(log => log.timestamp.toISOString().startsWith(dayStr));
  }

  getErrorsFromDate(date) {
    const target = date instanceof Date ? date : new Date(date);
    const dayStr = target.toISOString().substring(0, 10);
    return this.inMemoryErrors.filter(log => log.timestamp.toISOString().startsWith(dayStr));
  }

  getAuditFromDate(date) {
    const target = date instanceof Date ? date : new Date(date);
    const dayStr = target.toISOString().substring(0, 10);
    return this.inMemoryAudit.filter(entry => entry.timestamp.startsWith(dayStr));
  }

  // Filter audit by action type
  getAuditByAction(action, count = 50) {
    return this.inMemoryAudit
      .filter(entry => entry.action === action)
      .slice(-count);
  }

  // Filter audit by target
  getAuditByTarget(target, count = 50) {
    return this.inMemoryAudit
      .filter(entry => entry.target === target)
      .slice(-count);
  }

  // Get log statistics
  getStats() {
    return {
      totalLogs: this.inMemoryLogs.length,
      totalErrors: this.inMemoryErrors.length,
      totalAudit: this.inMemoryAudit.length,
      errorRate: this.inMemoryLogs.length > 0
        ? ((this.inMemoryErrors.length / this.inMemoryLogs.length) * 100).toFixed(1) + '%'
        : '0%',
      recentErrors: this.inMemoryErrors.slice(-5).map(e => e.message),
      recentAudit: this.inMemoryAudit.slice(-5).map(a => `${a.action}: ${a.target || '-'}`)
    };
  }

  // ─── Export Methods ───
  exportLogs(filePath, format = 'text') {
    return this._exportData(this.inMemoryLogs, filePath, format, (l) => ({
      timestamp: l.timestamp.toISOString(),
      level: l.level,
      message: l.message,
      meta: l.meta
    }));
  }

  exportErrors(filePath, format = 'text') {
    return this._exportData(this.inMemoryErrors, filePath, format, (e) => ({
      timestamp: e.timestamp.toISOString(),
      message: e.message,
      errorName: e.error?.name,
      errorMessage: e.error?.message,
      stack: e.error?.stack,
      context: e.context
    }));
  }

  exportAudit(filePath, format = 'text') {
    return this._exportData(this.inMemoryAudit, filePath, format, (a) => ({
      timestamp: a.timestamp,
      action: a.action,
      target: a.target,
      targetType: a.targetType,
      before: a.before,
      after: a.after,
      result: a.result,
      user: a.user
    }));
  }

  _exportData(data, filePath, format, mapper) {
    const mapped = data.map(mapper);

    if (format === 'csv') {
      if (mapped.length === 0) return { success: true, message: 'No data to export' };
      const headers = Object.keys(mapped[0]);
      let csv = headers.join(',') + '\n';
      mapped.forEach(row => {
        csv += headers.map(h => {
          const val = row[h];
          if (val === null || val === undefined) return '';
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
          return `"${str.replace(/"/g, '""')}"`;
        }).join(',') + '\n';
      });
      fs.writeFileSync(filePath, csv, 'utf8');
    } else if (format === 'json') {
      fs.writeFileSync(filePath, JSON.stringify(mapped, null, 2), 'utf8');
    } else {
      const content = data.map(l =>
        `[${l.timestamp.toISOString()}] [${l.level || 'AUDIT'}] ${l.message || l.action} ${l.meta ? JSON.stringify(l.meta) : ''}`
      ).join('\n');
      fs.writeFileSync(filePath, content, 'utf8');
    }

    return { success: true, count: data.length };
  }
}

module.exports = Logger;
