// apiServer.js - HTTP API + web interface for Kyrios Chronos.
//
// Runs in the desktop app and in the Windows service, so it must not require
// anything from electron.
//
// Access is gated by GitHub sign-in (see webAuth.js) and every mutating call is
// attributed to the signed-in account, which is the point: the audit log has to
// name a person, not just an IP.

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const WebAuth = require('./webAuth');
const SystemMetrics = require('./systemMetrics');

// Paths that must work before anyone is signed in.
const PUBLIC_PATHS = new Set(['/login', '/style.css', '/api/health', '/favicon.ico']);

class ApiServer {
  constructor(taskManager, config, logger, serviceManager, wrapperGenerator, backupManager) {
    this.taskManager = taskManager;
    this.config = config;
    this.logger = logger;
    this.serviceManager = serviceManager;
    this.wrapperGenerator = wrapperGenerator;
    this.backupManager = backupManager;

    this.app = express();
    this.server = null;
    this.port = config.getSetting('ApiPort', 7600);
    this.apiKey = config.getSetting('ApiKey', '');

    this.auth = new WebAuth(config, logger);
    this.metrics = new SystemMetrics(logger, {
      intervalMs: config.getSetting('MetricsIntervalMs', SystemMetrics.DEFAULT_INTERVAL_MS),
    });
    this.sseClients = new Set();
    // In-flight device-flow attempts: handle -> { deviceCode }. The device code
    // stays server-side; the browser only ever holds an opaque handle.
    this.deviceFlows = new Map();

    this.webRoot = this._resolveWebRoot();
    this.setupMiddleware();
    this.setupRoutes();
  }

  _resolveWebRoot() {
    const candidates = [
      path.join(__dirname, '..', 'web'),
      path.join(process.resourcesPath || '', 'app.asar', 'src', 'web'),
      path.join(process.resourcesPath || '', 'app', 'src', 'web'),
    ];
    for (const dir of candidates) {
      try { if (fs.existsSync(path.join(dir, 'index.html'))) return dir; } catch (e) {}
    }
    return candidates[0];
  }

  /**
   * Read a web asset. Files are read through fs rather than express.static
   * because they live inside app.asar in a packaged build, and reading them
   * directly is the one approach that works identically in both layouts.
   */
  _asset(name) {
    try { return fs.readFileSync(path.join(this.webRoot, name), 'utf8'); }
    catch (e) { return null; }
  }

  _sendAsset(res, name, type) {
    const body = this._asset(name);
    if (body == null) return res.status(500).type('text/plain').send(`Web asset missing: ${name}`);
    res.type(type).send(body);
  }

  /** The signed-in GitHub account for this request, as an audit actor. */
  _actor(req) {
    const user = req.kyriosUser;
    return {
      actor: user ? `${user.login} (github:${user.id})` : 'anonymous',
      actorLogin: user ? user.login : null,
      ip: req.ip || (req.socket && req.socket.remoteAddress) || 'unknown',
      via: 'web',
    };
  }

  _audit(req, action, details) {
    this.logger.audit(action, Object.assign({}, details, this._actor(req)));
  }

  setupMiddleware() {
    this.app.set('trust proxy', true);
    this.app.use(cors({ origin: false, credentials: true }));
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - start;
        const who = req.kyriosUser ? ` [${req.kyriosUser.login}]` : '';
        this.logger.log('API', `${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)${who}`);
      });
      next();
    });

    // ─── Authentication gate ───
    this.app.use((req, res, next) => {
      const routePath = req.path;
      if (PUBLIC_PATHS.has(routePath) || routePath.startsWith('/auth/')) return next();

      // A machine-to-machine caller may still use the API key, so existing
      // integrations keep working without a browser.
      if (this.apiKey && req.headers['x-api-key'] === this.apiKey) {
        req.kyriosUser = { login: 'api-key', id: 0, name: 'API key client' };
        return next();
      }

      const user = this.auth.authenticate(req);
      if (user) { req.kyriosUser = user; return next(); }

      if (routePath.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Sign in with GitHub, or send a valid X-API-Key header.' });
      }
      return res.redirect('/login');
    });
  }

  setupRoutes() {
    this._authRoutes();
    this._webRoutes();
    this._metricsRoutes();
    this._taskRoutes();
    this._backupRoutes();
    this._miscRoutes();
  }

  // ─── GitHub sign-in ───
  _authRoutes() {
    const callbackUrl = (req) => {
      const configured = (this.config.getSetting('WebBaseUrl', '') || '').trim();
      const base = configured || `${req.protocol}://${req.get('host')}`;
      return `${base.replace(/\/+$/, '')}/auth/github/callback`;
    };

    this.app.get('/login', (req, res) => {
      if (this.auth.authenticate(req)) return res.redirect('/');
      // Redirect once to surface the configuration problem. Without the
      // req.query.problem check this redirects to itself forever and the
      // browser gives up with ERR_TOO_MANY_REDIRECTS.
      const problem = this.auth.configurationProblem();
      if (problem && !req.query.problem && !req.query.error && !req.query.notice) {
        return res.redirect('/login?problem=' + encodeURIComponent(problem));
      }
      this._sendAsset(res, 'login.html', 'html');
    });

    // ─── Device flow (default: no client secret involved) ───
    this.app.post('/auth/device/start', async (req, res) => {
      if (this.auth.flow !== 'device') return res.status(400).json({ error: 'Device flow is not in use' });
      try {
        const info = await this.auth.startDeviceFlow();
        // The device code is the credential; only the user code reaches the page.
        const handle = require('crypto').randomBytes(16).toString('hex');
        this.deviceFlows.set(handle, { deviceCode: info.deviceCode, createdAt: Date.now(), interval: info.interval });
        res.json({
          handle,
          userCode: info.userCode,
          verificationUri: info.verificationUri,
          interval: info.interval,
          expiresIn: info.expiresIn,
        });
      } catch (err) {
        this.logger.log('WARN', `Device flow could not start: ${err.message}`);
        res.status(502).json({ error: err.message });
      }
    });

    this.app.post('/auth/device/poll', async (req, res) => {
      const entry = this.deviceFlows.get(req.body && req.body.handle);
      if (!entry) return res.status(400).json({ status: 'error', message: 'This sign-in attempt is no longer valid. Start again.' });

      try {
        const result = await this.auth.pollDeviceFlow(entry.deviceCode);
        if (result.status !== 'token') {
          if (result.status === 'error') this.deviceFlows.delete(req.body.handle);
          return res.json(result);
        }

        this.deviceFlows.delete(req.body.handle);
        const user = await this.auth.fetchGithubUser(result.token);
        const ip = req.ip || 'unknown';

        if (!this.auth.isAllowed(user.login)) {
          this.logger.audit('WEB_LOGIN_DENIED', {
            targetType: 'web', target: user.login,
            after: { login: user.login, id: user.id },
            actor: `${user.login} (github:${user.id})`, ip, via: 'web-device',
          });
          this.logger.log('WARN', `Web sign-in refused for GitHub user "${user.login}" from ${ip} (not on the allowed list)`);
          return res.json({ status: 'denied', login: user.login });
        }

        const sid = this.auth.createSession(user, ip);
        this.auth.setSessionCookie(res, sid);
        this.logger.audit('WEB_LOGIN', {
          targetType: 'web', target: user.login,
          after: { login: user.login, id: user.id },
          actor: `${user.login} (github:${user.id})`, ip, via: 'web-device',
        });
        this.logger.log('INFO', `Web sign-in: ${user.login} from ${ip} (device flow)`);
        res.json({ status: 'ok', login: user.login });
      } catch (err) {
        this.logger.error('Device flow sign-in failed', err);
        res.status(502).json({ status: 'error', message: err.message });
      }
    });

    this.app.get('/auth/mode', (req, res) => {
      res.json({ flow: this.auth.flow, problem: this.auth.configurationProblem() });
    });

    this.app.get('/auth/github', (req, res) => {
      if (!this.auth.isConfigured()) {
        return res.redirect('/login?problem=' + encodeURIComponent(this.auth.configurationProblem()));
      }
      res.redirect(this.auth.buildAuthorizeUrl(callbackUrl(req), req.query.next || '/'));
    });

    this.app.get('/auth/github/callback', async (req, res) => {
      const { code, state } = req.query;
      const entry = this.auth.consumeState(state);
      if (!entry) return res.redirect('/login?error=state');
      if (!code) return res.redirect('/login?error=failed');

      try {
        const token = await this.auth.exchangeCodeForToken(code, callbackUrl(req));
        const user = await this.auth.fetchGithubUser(token);
        const ip = req.ip || 'unknown';

        if (!this.auth.isAllowed(user.login)) {
          // A refused attempt is exactly the kind of thing an audit log is for.
          this.logger.audit('WEB_LOGIN_DENIED', {
            targetType: 'web', target: user.login,
            after: { login: user.login, id: user.id }, actor: `${user.login} (github:${user.id})`, ip, via: 'web',
          });
          this.logger.log('WARN', `Web sign-in refused for GitHub user "${user.login}" from ${ip} (not on the allowed list)`);
          return res.redirect('/login?error=denied&login=' + encodeURIComponent(user.login));
        }

        const sid = this.auth.createSession(user, ip);
        this.auth.setSessionCookie(res, sid);
        this.logger.audit('WEB_LOGIN', {
          targetType: 'web', target: user.login,
          after: { login: user.login, id: user.id }, actor: `${user.login} (github:${user.id})`, ip, via: 'web',
        });
        this.logger.log('INFO', `Web sign-in: ${user.login} from ${ip}`);
        res.redirect(entry.redirectTo || '/');
      } catch (err) {
        this.logger.error('GitHub sign-in failed', err);
        res.redirect('/login?error=failed');
      }
    });

    this.app.post('/auth/logout', (req, res) => {
      const user = this.auth.authenticate(req);
      if (user) {
        this.auth.destroySession(user.sid);
        this.logger.audit('WEB_LOGOUT', {
          targetType: 'web', target: user.login,
          actor: `${user.login} (github:${user.id})`, ip: req.ip, via: 'web',
        });
      }
      this.auth.clearSessionCookie(res);
      res.json({ success: true });
    });
  }

  // ─── Static web interface ───
  _webRoutes() {
    this.app.get('/style.css', (req, res) => this._sendAsset(res, 'style.css', 'css'));
    this.app.get('/app.js', (req, res) => this._sendAsset(res, 'app.js', 'application/javascript'));
    this.app.get('/', (req, res) => this._sendAsset(res, 'index.html', 'html'));
    this.app.get('/dashboard', (req, res) => res.redirect('/'));

    this.app.get('/api/me', (req, res) => {
      const u = req.kyriosUser;
      res.json({ login: u.login, id: u.id, name: u.name, avatar: u.avatar || '' });
    });
  }

  // ─── Resource monitor ───
  _metricsRoutes() {
    this.app.get('/api/metrics', (req, res) => {
      const limit = parseInt(req.query.limit, 10) || 300;
      const current = this.metrics.current();
      res.json(Object.assign({ history: this.metrics.getHistory(limit) }, current));
    });

    // Server-sent events: one long-lived connection per viewer, pushed from the
    // single sampler rather than polled per client.
    this.app.get('/api/metrics/stream', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 5000\n\n');

      const send = (sample) => {
        try { res.write(`event: sample\ndata: ${JSON.stringify(sample)}\n\n`); } catch (e) {}
      };
      if (this.metrics.latest) send(this.metrics.latest);

      this.metrics.on('sample', send);
      this.sseClients.add(res);

      // Keep intermediaries from closing an idle connection.
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);

      const cleanup = () => {
        clearInterval(ping);
        this.metrics.removeListener('sample', send);
        this.sseClients.delete(res);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
    });
  }

  // ─── Tasks ───
  _taskRoutes() {
    this.app.get('/api/health', (req, res) => {
      res.json({
        status: 'ok',
        version: require('../../package.json').version,
        uptime: process.uptime(),
        tasks: this.taskManager.getAllTasks().length,
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get('/api/tasks', (req, res) => {
      let tasks = this.taskManager.getAllTasks();
      if (req.query.enabled !== undefined) {
        const enabled = req.query.enabled === 'true';
        tasks = tasks.filter(t => t.Enabled === enabled);
      }
      if (req.query.search) {
        const q = req.query.search.toLowerCase();
        tasks = tasks.filter(t =>
          (t.Name || '').toLowerCase().includes(q) ||
          (t.CronExpression || '').toLowerCase().includes(q) ||
          (t.ScriptPath || '').toLowerCase().includes(q));
      }
      res.json({ success: true, data: tasks, count: tasks.length });
    });

    this.app.get('/api/tasks/:id', (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({ success: true, data: task });
    });

    this.app.post('/api/tasks', (req, res) => {
      const { Name, CronExpression, ScriptPath, Arguments, WorkingDirectory, Description, Enabled } = req.body;
      if (!Name || !CronExpression || !ScriptPath) {
        return res.status(400).json({ error: 'Missing required fields: Name, CronExpression, ScriptPath' });
      }
      const result = this.taskManager.addTask({
        Name, CronExpression, ScriptPath,
        Arguments: Arguments || '',
        WorkingDirectory: WorkingDirectory || '',
        Description: Description || '',
        Enabled: Enabled !== false,
      });
      if (result.success === false) return res.status(400).json({ error: result.message || 'Failed to create task' });
      this._audit(req, 'TASK_CREATED_WEB', { targetType: 'task', target: result.Id, before: null, after: { Name, CronExpression } });
      res.status(201).json({ success: true, data: result });
    });

    this.app.put('/api/tasks/:id', (req, res) => {
      const existing = this.taskManager.getTask(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      const data = Object.assign({}, existing, req.body, { Id: req.params.id });
      const result = this.taskManager.updateTask(data);
      if (result.success === false) return res.status(400).json({ error: result.message || 'Failed to update task' });
      this._audit(req, 'TASK_UPDATED_WEB', {
        targetType: 'task', target: req.params.id,
        before: { Name: existing.Name, CronExpression: existing.CronExpression, Enabled: existing.Enabled },
        after: { Name: data.Name, CronExpression: data.CronExpression, Enabled: data.Enabled },
      });
      res.json({ success: true, data: result });
    });

    this.app.delete('/api/tasks/:id', (req, res) => {
      const existing = this.taskManager.getTask(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      this.taskManager.deleteTask(req.params.id);
      this._audit(req, 'TASK_DELETED_WEB', { targetType: 'task', target: req.params.id, before: { Name: existing.Name }, after: null });
      res.json({ success: true, message: `Task "${existing.Name}" deleted` });
    });

    this.app.post('/api/tasks/:id/run', async (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      try {
        const result = await this.taskManager.executeTask(task);
        this._audit(req, 'TASK_EXECUTED_WEB', { targetType: 'task', target: req.params.id, after: { Status: result.Status, Duration: result.Duration } });
        res.json({ success: true, data: result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.get('/api/history', (req, res) => {
      let history = this.taskManager.history || [];
      if (req.query.taskId) history = history.filter(h => h.TaskId === req.query.taskId);
      const limit = parseInt(req.query.limit, 10);
      if (limit) history = history.slice(0, limit);
      res.json({ success: true, data: history, count: history.length });
    });

    this.app.post('/api/tasks/:id/attach', (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      const { ScriptPath, Arguments, WorkingDirectory } = req.body;
      if (!ScriptPath) return res.status(400).json({ error: 'ScriptPath is required' });
      const result = this.taskManager.updateTask(Object.assign({}, task, {
        ScriptPath,
        Arguments: Arguments || task.Arguments,
        WorkingDirectory: WorkingDirectory || task.WorkingDirectory,
      }));
      this._audit(req, 'SCRIPT_ATTACHED_WEB', { targetType: 'task', target: task.Id, before: { ScriptPath: task.ScriptPath }, after: { ScriptPath } });
      res.json({ success: true, data: result, message: `Script attached: ${ScriptPath}` });
    });

    this.app.delete('/api/tasks/:id/attach', (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      this.taskManager.updateTask(Object.assign({}, task, { ScriptPath: '', Arguments: '', WorkingDirectory: '' }));
      this._audit(req, 'SCRIPT_DETACHED_WEB', { targetType: 'task', target: task.Id, before: { ScriptPath: task.ScriptPath }, after: { ScriptPath: '' } });
      res.json({ success: true, message: `Script detached from "${task.Name}"` });
    });

    this.app.get('/api/tasks/:id/script', (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({
        success: true,
        data: {
          taskId: task.Id, taskName: task.Name, scriptPath: task.ScriptPath,
          arguments: task.Arguments, workingDirectory: task.WorkingDirectory,
          exists: task.ScriptPath ? fs.existsSync(task.ScriptPath) : false,
        },
      });
    });
  }

  // ─── Backups ───
  _backupRoutes() {
    const guard = (res) => {
      if (!this.backupManager) { res.status(503).json({ error: 'Backup manager unavailable' }); return false; }
      return true;
    };

    this.app.get('/api/backups', (req, res) => {
      if (!guard(res)) return;
      // Passwords never leave the machine through this API.
      const data = this.backupManager.getAllProfiles().map(p => Object.assign({}, p, { Password: undefined }));
      res.json({ success: true, data, count: data.length });
    });

    this.app.get('/api/backups/history', (req, res) => {
      if (!guard(res)) return;
      const limit = parseInt(req.query.limit, 10) || 100;
      const history = (this.backupManager.history || []).slice(0, limit);
      res.json({ success: true, data: history, count: history.length });
    });

    this.app.post('/api/backups/:id/run', async (req, res) => {
      if (!guard(res)) return;
      const profile = this.backupManager.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: 'Backup profile not found' });
      try {
        const result = await this.backupManager.executeBackup(req.params.id);
        this._audit(req, 'BACKUP_EXECUTED_WEB', {
          targetType: 'backup', target: req.params.id,
          after: { profile: profile.Name, success: result.success, duration: result.duration },
        });
        res.json({ success: true, data: result });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  // ─── Everything else ───
  _miscRoutes() {
    this.app.get('/api/logs', (req, res) => {
      const limit = parseInt(req.query.limit, 10) || 200;
      // From disk, so the web UI also sees what the service did.
      const logs = this.logger.getRecentLogsFromDisk
        ? this.logger.getRecentLogsFromDisk(limit)
        : this.logger.getRecentLogs(limit);
      res.json({ success: true, data: logs, count: logs.length });
    });

    this.app.get('/api/services', (req, res) => {
      const services = this.serviceManager ? this.serviceManager.getAllServices() : [];
      res.json({ success: true, data: services, count: services.length });
    });

    this.app.get('/api/config', (req, res) => {
      res.json({
        success: true,
        data: {
          profiles: this.config.getProfileList(),
          activeProfile: this.config.getSetting('_activeProfile', 'default'),
          settings: { notifications: this.config.getSetting('Notifications', true), apiPort: this.port },
        },
      });
    });

    // API reference page, kept from the previous server.
    this.app.get('/docs', (req, res) => res.type('html').send(this.getDocsHTML()));

    this.app.post('/api/validate-cron', (req, res) => {
      const { expression } = req.body;
      if (!expression) return res.status(400).json({ error: 'expression is required' });
      try {
        const cronParser = this.taskManager.cronParser;
        const result = cronParser.validate(expression);
        res.json({
          success: true, valid: result.valid,
          description: cronParser.getDescription(expression),
          nextRun: (cronParser.getNextRunTime(expression) || {}).toISOString
            ? cronParser.getNextRunTime(expression).toISOString() : null,
          errors: result.errors || [],
        });
      } catch (e) {
        res.json({ success: true, valid: false, description: 'Invalid', errors: [e.message] });
      }
    });

    this.app.use((req, res) => {
      if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
      res.redirect('/');
    });
  }

  start(port) {
    return new Promise((resolve, reject) => {
      try {
        this.port = port || this.port;
        // Loopback-only unless explicitly opened up: a scheduler that can run
        // arbitrary scripts should not be reachable from the whole network by
        // accident.
        const host = this.config.getSetting('ApiBindAll', false) ? '0.0.0.0' : '127.0.0.1';

        this.server = this.app.listen(this.port, host, () => {
          this.metrics.start();
          this.logger.log('API', `Web interface on http://${host === '0.0.0.0' ? 'localhost' : host}:${this.port}/`);
          const problem = this.auth.configurationProblem();
          if (problem) this.logger.log('WARN', `Web interface: ${problem}`);
          resolve({ success: true, port: this.port, host, url: `http://localhost:${this.port}` });
        });

        this.server.on('error', (err) => {
          if (err.code === 'EADDRINUSE') reject(new Error(`Port ${this.port} is already in use`));
          else reject(err);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.metrics.stop();
      this.auth.dispose();
      for (const client of this.sseClients) { try { client.end(); } catch (e) {} }
      this.sseClients.clear();

      if (this.server) {
        this.server.close(() => {
          this.logger.log('API', 'Web interface stopped');
          this.server = null;
          resolve({ success: true });
        });
      } else {
        resolve({ success: true });
      }
    });
  }

  isRunning() {
    return !!(this.server && this.server.listening);
  }

  getDocsHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kyrios Chronos API Docs</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#08080c;--card:#0f0f14;--border:rgba(255,255,255,.06);--text:#c0c0d0;--text2:#808094;--primary:#6a5acd;--green:#6a8a6e;--red:#8a5a5a;--amber:#8a7a5a}
body{font-family:'Inter',-apple-system,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
.container{max-width:800px;margin:0 auto;padding:24px}
h1{font-size:22px;font-weight:600;margin-bottom:8px;background:linear-gradient(135deg,var(--primary),#8a7acd);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.subtitle{color:var(--text2);margin-bottom:24px;font-size:14px}
h2{font-size:16px;font-weight:600;margin:24px 0 12px;color:var(--text);border-bottom:1px solid var(--border);padding-bottom:8px}
h3{font-size:13px;font-weight:600;margin:12px 0 6px}
.method{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;font-family:monospace;margin-right:6px}
.get{background:rgba(106,138,110,.15);color:var(--green)}
.post{background:rgba(106,90,173,.15);color:var(--primary)}
.put{background:rgba(138,122,90,.15);color:var(--amber)}
.delete{background:rgba(138,90,90,.15);color:var(--red)}
.endpoint{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:16px;margin:12px 0}
.endpoint-header{display:flex;align-items:center;margin-bottom:8px}
.endpoint-path{font-family:monospace;font-size:13px;color:var(--text)}
.endpoint-desc{font-size:13px;color:var(--text2);margin-bottom:8px}
pre{background:rgba(0,0,0,.3);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;color:var(--text);margin:8px 0}
code{background:rgba(255,255,255,.06);padding:1px 4px;border-radius:3px;font-size:12px}
table{width:100%;border-collapse:collapse;margin:8px 0}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px}
th{color:var(--text2);text-transform:uppercase;font-size:10px;letter-spacing:.5px}
.note{background:rgba(106,90,173,.08);border:1px solid rgba(106,90,173,.15);border-radius:8px;padding:12px;font-size:13px;margin:12px 0}
.nav{position:sticky;top:0;background:var(--bg);padding:12px 0;border-bottom:1px solid var(--border);margin-bottom:16px;z-index:10}
.nav a{color:var(--primary);text-decoration:none;font-size:12px;margin-right:12px}
.nav a:hover{text-decoration:underline}
</style>
</head>
<body>
<div class="container">
  <h1>Kyrios Chronos API</h1>
  <p class="subtitle">REST API for managing scheduled tasks, services, and scripts</p>
  <div class="nav">
    <a href="#auth">Auth</a><a href="#tasks">Tasks</a><a href="#scripts">Scripts</a>
    <a href="#services">Services</a><a href="#history">History</a><a href="#utils">Utilities</a>
    <a href="/">Dashboard</a>
  </div>

  <div class="note">
    <strong>Base URL:</strong> <code>http://localhost:${this.port}/api</code><br>
    <strong>Auth:</strong> Optional API key via <code>X-API-Key</code> header (configure in Settings)
  </div>

  <h2 id="auth">Authentication</h2>
  <p style="font-size:13px;color:var(--text2)">If an API key is configured in the desktop app (Settings → API Key), include it in every request:</p>
  <pre>curl -H "X-API-Key: YOUR_KEY" http://localhost:${this.port}/api/tasks</pre>

  <h2 id="tasks">Tasks</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/tasks</span></div>
    <div class="endpoint-desc">List all tasks. Optional: <code>?enabled=true</code> <code>?search=keyword</code></div>
    <pre>curl http://localhost:${this.port}/api/tasks</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/tasks/:id</span></div>
    <div class="endpoint-desc">Get a single task by ID</div>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method post">POST</span><span class="endpoint-path">/api/tasks</span></div>
    <div class="endpoint-desc">Create a new task</div>
    <h3>Body</h3>
    <table><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>
    <tr><td><code>Name</code></td><td>string</td><td>✓</td><td>Task name</td></tr>
    <tr><td><code>CronExpression</code></td><td>string</td><td>✓</td><td>Cron expression (e.g. <code>0 5 * * *</code>)</td></tr>
    <tr><td><code>ScriptPath</code></td><td>string</td><td>✓</td><td>Full path to script/executable</td></tr>
    <tr><td><code>Arguments</code></td><td>string</td><td></td><td>Script arguments</td></tr>
    <tr><td><code>WorkingDirectory</code></td><td>string</td><td></td><td>Working directory</td></tr>
    <tr><td><code>Description</code></td><td>string</td><td></td><td>Task description</td></tr>
    <tr><td><code>Enabled</code></td><td>boolean</td><td></td><td>Default: true</td></tr>
    </tbody></table>
    <pre>curl -X POST http://localhost:${this.port}/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"Name":"Daily Backup","CronExpression":"0 2 * * *","ScriptPath":"C:\\\\Scripts\\\\backup.ps1"}'</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method put">PUT</span><span class="endpoint-path">/api/tasks/:id</span></div>
    <div class="endpoint-desc">Update an existing task (partial update supported)</div>
    <pre>curl -X PUT http://localhost:${this.port}/api/tasks/TASK_ID \\
  -H "Content-Type: application/json" \\
  -d '{"CronExpression":"0 3 * * *"}'</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method delete">DELETE</span><span class="endpoint-path">/api/tasks/:id</span></div>
    <div class="endpoint-desc">Delete a task</div>
    <pre>curl -X DELETE http://localhost:${this.port}/api/tasks/TASK_ID</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method post">POST</span><span class="endpoint-path">/api/tasks/:id/run</span></div>
    <div class="endpoint-desc">Execute a task immediately</div>
    <pre>curl -X POST http://localhost:${this.port}/api/tasks/TASK_ID/run</pre>
  </div>

  <h2 id="scripts">Scripts</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method post">POST</span><span class="endpoint-path">/api/tasks/:id/attach</span></div>
    <div class="endpoint-desc">Attach (or re-attach) a script to a task</div>
    <pre>curl -X POST http://localhost:${this.port}/api/tasks/TASK_ID/attach \\
  -H "Content-Type: application/json" \\
  -d '{"ScriptPath":"C:\\\\NewScript.ps1","Arguments":"-Verbose"}'</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method delete">DELETE</span><span class="endpoint-path">/api/tasks/:id/attach</span></div>
    <div class="endpoint-desc">Detach the script from a task (keeps the task, removes script reference)</div>
    <pre>curl -X DELETE http://localhost:${this.port}/api/tasks/TASK_ID/attach</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/tasks/:id/script</span></div>
    <div class="endpoint-desc">Get script info for a task (path, args, exists check)</div>
  </div>

  <h2 id="services">Services</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/services</span></div>
    <div class="endpoint-desc">List all NSSM-managed services</div>
  </div>

  <h2 id="history">History</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/history</span></div>
    <div class="endpoint-desc">Execution history. Optional: <code>?taskId=ID</code> <code>?limit=50</code></div>
  </div>

  <h2 id="utils">Utilities</h2>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/health</span></div>
    <div class="endpoint-desc">Server health check</div>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method post">POST</span><span class="endpoint-path">/api/validate-cron</span></div>
    <div class="endpoint-desc">Validate a cron expression</div>
    <pre>curl -X POST http://localhost:${this.port}/api/validate-cron \\
  -H "Content-Type: application/json" \\
  -d '{"expression":"0 5 * * *"}'</pre>
  </div>

  <div class="endpoint">
    <div class="endpoint-header"><span class="method get">GET</span><span class="endpoint-path">/api/config</span></div>
    <div class="endpoint-desc">Current configuration (profiles, settings)</div>
  </div>

  <h2>Quick Examples</h2>
  <h3>Create + Attach + Run</h3>
  <pre># 1. Create task
curl -X POST http://localhost:${this.port}/api/tasks \\
  -H "Content-Type: application/json" \\
  -d '{"Name":"Ping Test","CronExpression":"*/5 * * * *","ScriptPath":"ping.exe"}'

# 2. Attach a different script
curl -X POST http://localhost:${this.port}/api/tasks/TASK_ID/attach \\
  -H "Content-Type: application/json" \\
  -d '{"ScriptPath":"C:\\\\Scripts\\\\ping-test.bat","Arguments":"-n 10 google.com"}'

# 3. Run it now
curl -X POST http://localhost:${this.port}/api/tasks/TASK_ID/run

# 4. Check history
curl http://localhost:${this.port}/api/history?taskId=TASK_ID&limit=5</pre>
</div>
</body></html>`;
  }
}

module.exports = ApiServer;
