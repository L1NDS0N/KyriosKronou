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
const WebPermissions = require('./webPermissions');
const SystemMetrics = require('./systemMetrics');
const security = require('./webSecurity');

// Paths that must work before anyone is signed in.
const PUBLIC_PATHS = new Set([
  '/login', '/login.js', '/style.css', '/api/health', '/favicon.ico',
  '/assets/logo.png', '/assets/logo-24.png', '/assets/bg.png',
]);

class ApiServer {
  constructor(taskManager, config, logger, serviceManager, wrapperGenerator, backupManager, extras) {
    const opts = extras || {};
    this.runRegistry = opts.runRegistry || (taskManager && taskManager.runs) || null;
    this.cronParser = opts.cronParser || (taskManager && taskManager.cronParser) || null;
    this.taskManager = taskManager;
    this.config = config;
    this.logger = logger;
    this.serviceManager = serviceManager;
    this.wrapperGenerator = wrapperGenerator;
    this.backupManager = backupManager;
    // Sync e retenção são opcionalmente injetados: o painel serve as telas
    // mesmo sem eles, e cada rota responde 503 em vez de derrubar o servidor.
    this.syncManager = opts.syncManager || null;
    this.retentionManager = opts.retentionManager || null;
    this.syncNetwork = opts.syncNetwork || null;

    this.app = express();
    this.server = null;
    this.port = config.getSetting('ApiPort', 7600);
    this.apiKey = config.getSetting('ApiKey', '');

    this.auth = new WebAuth(config, logger);
    // Quem entra é webAuth; o que a pessoa faz depois é webPermissions. Sem o
    // setting WebUserPermissions configurado, todo login permitido faz tudo.
    this.permissions = opts.permissions || new WebPermissions(config, logger);
    this.metrics = new SystemMetrics(logger, {
      intervalMs: config.getSetting('MetricsIntervalMs', SystemMetrics.DEFAULT_INTERVAL_MS),
    });
    this.sseClients = new Set();

    // Tetos por IP. O de autenticação é apertado de propósito: é o único
    // endpoint que um desconhecido alcança.
    this.authLimiter = new security.RateLimiter(
      config.getSetting('WebAuthRateLimit', 20), 5 * 60 * 1000);
    this.apiLimiter = new security.RateLimiter(
      config.getSetting('WebApiRateLimit', 600), 60 * 1000);

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

  /**
   * Middleware de escopo por tela (ver webPermissions.js).
   *
   * Registrado na rota, ele roda depois da autenticação e do CSRF - os dois
   * são middlewares globais em setupMiddleware - então o 403 só responde a quem
   * já entrou, e a chave de API continua passando direto.
   */
  _need(scope) {
    return this.permissions.requireScope(scope);
  }

  setupMiddleware() {
    // trust proxy só quando há proxy declarado: com ele ligado sem proxy, o
    // X-Forwarded-For do atacante vira o req.ip e ele escapa do limitador.
    this.app.set('trust proxy', !!this.config.getSetting('WebTrustProxy', false));
    this.app.disable('x-powered-by');
    this.app.use(security.securityHeaders({ https: !!this.config.getSetting('WebHttps', false) }));
    this.app.use(cors({ origin: false, credentials: true }));
    // 10MB era o limite de tudo; só o upload de script precisa de corpo grande.
    // O parser global tem que sair da frente dele: rodando primeiro, rejeitaria
    // o upload com 413 antes de a rota com o limite maior ser alcançada.
    const jsonPadrao = express.json({ limit: '1mb' });
    this.app.use((req, res, next) => {
      if (req.path === '/api/scripts' && req.method === 'POST') return next();
      jsonPadrao(req, res, next);
    });
    this.app.use(express.urlencoded({ extended: true, limit: '1mb' }));

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

    // ─── Rate limiting ───
    // O login é o alvo óbvio; o resto da API leva um teto generoso só para que
    // um script solto não consiga martelar o agendador.
    this.app.use((req, res, next) => {
      const key = this._clientKey(req);
      const limiter = req.path.startsWith('/auth/') ? this.authLimiter : this.apiLimiter;
      const verdict = limiter.check(key);
      if (verdict.ok) return next();

      res.setHeader('Retry-After', String(verdict.retryAfter));
      this.logger.log('WARN', `Rate limit hit by ${key} on ${req.method} ${req.path}`);
      return res.status(429).json({ error: 'Too many requests', retryAfter: verdict.retryAfter });
    });

    // ─── Authentication gate ───
    this.app.use((req, res, next) => {
      const routePath = req.path;
      if (PUBLIC_PATHS.has(routePath) || routePath.startsWith('/auth/')) return next();

      // A machine-to-machine caller may still use the API key, so existing
      // integrations keep working without a browser.
      if (this.apiKey && security.safeEqual(req.headers['x-api-key'], this.apiKey)) {
        req.kyriosUser = { login: 'api-key', id: 0, name: 'API key client' };
        req.kyriosViaApiKey = true;
        return next();
      }

      const user = this.auth.authenticate(req);
      if (user) { req.kyriosUser = user; return next(); }

      if (routePath.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Sign in with GitHub, or send a valid X-API-Key header.' });
      }
      return res.redirect('/login');
    });

    // ─── CSRF ───
    //
    // Depois da autenticação: só faz sentido para quem tem sessão de cookie.
    // Um cliente com X-API-Key não é vulnerável a CSRF - o navegador de uma
    // vítima não anexa a chave sozinho, como faz com o cookie.
    this.app.use((req, res, next) => {
      if (security.SAFE_METHODS.has(req.method)) return next();
      if (req.kyriosViaApiKey) return next();
      if (!req.kyriosUser) return next(); // rotas públicas de login têm o próprio limite

      const origem = security.sameOrigin(req);
      if (origem === false) {
        this.logger.log('WARN', `Cross-origin write refused: ${req.method} ${req.path} from ${req.headers.origin || req.headers.referer}`);
        return res.status(403).json({ error: 'Cross-origin request refused' });
      }

      if (!security.csrfValid(this.auth.secret, req.kyriosUser.sid, req.get('X-CSRF-Token'))) {
        this.logger.log('WARN', `Missing or invalid CSRF token: ${req.method} ${req.path} (${req.kyriosUser.login})`);
        return res.status(403).json({ error: 'Invalid CSRF token', message: 'Reload the page and try again.' });
      }
      next();
    });
  }

  /** Chave do limitador: o IP, que é o que temos antes de haver sessão. */
  _clientKey(req) {
    return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  }

  setupRoutes() {
    this._authRoutes();
    this._webRoutes();
    this._metricsRoutes();
    this._taskRoutes();
    this._backupRoutes();
    this._syncRoutes();
    this._retentionRoutes();
    this._networkRoutes();
    this._serviceRoutes();
    this._runRoutes();
    this._scriptRoutes();
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

  /**
   * Imagens da marca. Ficam em src/renderer/assets, que e onde o app desktop ja
   * as tem - duplica-las em src/web faria as duas copias divergirem na proxima
   * troca de logo.
   *
   * A lista e fechada: o nome vem da URL, e servir "o que o nome pedir" a
   * partir de uma pasta e como se le arquivo arbitrario do disco.
   */
  _brandAssets() {
    const dirs = [
      path.join(__dirname, '..', 'renderer', 'assets'),
      path.join(process.resourcesPath || '', 'app.asar', 'src', 'renderer', 'assets'),
      path.join(process.resourcesPath || '', 'app', 'src', 'renderer', 'assets'),
    ];
    const ARQUIVOS = {
      '/favicon.ico': { file: 'favicon-32.png', type: 'image/png' },
      '/assets/logo.png': { file: 'fav.png', type: 'image/png' },
      '/assets/logo-24.png': { file: 'logo-24.png', type: 'image/png' },
      '/assets/bg.png': { file: 'bg-render.png', type: 'image/png' },
    };

    for (const [rota, info] of Object.entries(ARQUIVOS)) {
      this.app.get(rota, (req, res) => {
        for (const dir of dirs) {
          const full = path.join(dir, info.file);
          try {
            if (fs.existsSync(full)) {
              res.type(info.type);
              // A marca nao muda entre deploys; e a unica coisa aqui que vale cache.
              res.setHeader('Cache-Control', 'public, max-age=86400');
              return res.send(fs.readFileSync(full));
            }
          } catch (e) {}
        }
        res.status(404).end();
      });
    }
  }

  // ─── Static web interface ───
  _webRoutes() {
    this.app.get('/style.css', (req, res) => this._sendAsset(res, 'style.css', 'css'));
    this.app.get('/app.js', (req, res) => this._sendAsset(res, 'app.js', 'application/javascript'));
    this.app.get('/login.js', (req, res) => this._sendAsset(res, 'login.js', 'application/javascript'));
    this._brandAssets();
    this.app.get('/', (req, res) => this._sendAsset(res, 'index.html', 'html'));
    this.app.get('/dashboard', (req, res) => res.redirect('/'));

    this.app.get('/api/me', (req, res) => {
      const u = req.kyriosUser;
      res.json({
        login: u.login, id: u.id, name: u.name, avatar: u.avatar || '',
        // O token acompanha o /api/me porque é a primeira chamada da página:
        // uma ida a menos antes de poder escrever qualquer coisa.
        csrfToken: u.sid ? security.csrfToken(this.auth.secret, u.sid) : null,
        // Aditivo: o painel esconde o que esta pessoa não pode fazer, mas quem
        // decide é o servidor - esconder botão não é controle de acesso.
        permissions: this.permissions.summarize(u.login),
      });
    });
  }

  // ─── Resource monitor ───
  _metricsRoutes() {
    this.app.get('/api/metrics', this._need('monitor:view'), (req, res) => {
      const limit = parseInt(req.query.limit, 10) || 300;
      const current = this.metrics.current();
      res.json(Object.assign({ history: this.metrics.getHistory(limit) }, current));
    });

    // Server-sent events: one long-lived connection per viewer, pushed from the
    // single sampler rather than polled per client.
    this.app.get('/api/metrics/stream', this._need('monitor:view'), (req, res) => {
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

    this.app.get('/api/tasks', this._need('tasks:view'), (req, res) => {
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

    this.app.get('/api/tasks/:id', this._need('tasks:view'), (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      res.json({ success: true, data: task });
    });

    this.app.post('/api/tasks', this._need('tasks:write'), (req, res) => {
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

    this.app.put('/api/tasks/:id', this._need('tasks:write'), (req, res) => {
      const existing = this.taskManager.getTask(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      const data = Object.assign({}, existing, req.body, { Id: req.params.id });
      if (Object.prototype.hasOwnProperty.call(req.body, 'Description')) data.DescriptionHtml = '';
      const result = this.taskManager.updateTask(data);
      if (result.success === false) return res.status(400).json({ error: result.message || 'Failed to update task' });
      this._audit(req, 'TASK_UPDATED_WEB', {
        targetType: 'task', target: req.params.id,
        before: { Name: existing.Name, CronExpression: existing.CronExpression, Enabled: existing.Enabled },
        after: { Name: data.Name, CronExpression: data.CronExpression, Enabled: data.Enabled },
      });
      res.json({ success: true, data: result });
    });

    this.app.delete('/api/tasks/:id', this._need('tasks:delete'), (req, res) => {
      const existing = this.taskManager.getTask(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Task not found' });
      this.taskManager.deleteTask(req.params.id);
      this._audit(req, 'TASK_DELETED_WEB', { targetType: 'task', target: req.params.id, before: { Name: existing.Name }, after: null });
      res.json({ success: true, message: `Task "${existing.Name}" deleted` });
    });

    this.app.post('/api/tasks/:id/run', this._need('tasks:run'), async (req, res) => {
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

    this.app.get('/api/history', this._need('history:view'), (req, res) => {
      let history = this.taskManager.history || [];
      if (req.query.taskId) history = history.filter(h => h.TaskId === req.query.taskId);
      const limit = parseInt(req.query.limit, 10);
      if (limit) history = history.slice(0, limit);
      res.json({ success: true, data: history, count: history.length });
    });

    this.app.post('/api/tasks/:id/attach', this._need('tasks:write'), (req, res) => {
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

    // Desvincular é remover, não editar: quem não pode apagar nada também não
    // desliga o script de uma tarefa.
    this.app.delete('/api/tasks/:id/attach', this._need('tasks:delete'), (req, res) => {
      const task = this.taskManager.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: 'Task not found' });
      this.taskManager.updateTask(Object.assign({}, task, { ScriptPath: '', Arguments: '', WorkingDirectory: '' }));
      this._audit(req, 'SCRIPT_DETACHED_WEB', { targetType: 'task', target: task.Id, before: { ScriptPath: task.ScriptPath }, after: { ScriptPath: '' } });
      res.json({ success: true, message: `Script detached from "${task.Name}"` });
    });

    this.app.get('/api/tasks/:id/script', this._need('tasks:view'), (req, res) => {
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

    this.app.get('/api/backups', this._need('backups:view'), (req, res) => {
      if (!guard(res)) return;
      // Passwords never leave the machine through this API.
      const data = this.backupManager.getAllProfiles().map(p => Object.assign({}, p, { Password: undefined }));
      res.json({ success: true, data, count: data.length });
    });

    this.app.get('/api/backups/history', this._need('backups:view'), (req, res) => {
      if (!guard(res)) return;
      const limit = parseInt(req.query.limit, 10) || 100;
      const history = (this.backupManager.history || []).slice(0, limit);
      res.json({ success: true, data: history, count: history.length });
    });

    this.app.get('/api/backups/:id', this._need('backups:view'), (req, res) => {
      if (!guard(res)) return;
      const profile = this.backupManager.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: 'Backup profile not found' });
      res.json({ success: true, data: Object.assign({}, profile, { Password: undefined }) });
    });

    this.app.post('/api/backups', this._need('backups:write'), (req, res) => {
      if (!guard(res)) return;
      const { Name } = req.body || {};
      if (!Name) return res.status(400).json({ error: 'Name is required' });

      const result = this.backupManager.createProfile(req.body);
      if (result && result.success === false) return res.status(400).json({ error: result.message });
      this._audit(req, 'BACKUP_PROFILE_CREATED_WEB', {
        targetType: 'backup', target: (result && result.Id) || Name,
        before: null, after: { Name, Host: req.body.Host, CronExpression: req.body.CronExpression },
      });
      res.status(201).json({ success: true, data: Object.assign({}, result, { Password: undefined }) });
    });

    this.app.put('/api/backups/:id', this._need('backups:write'), (req, res) => {
      if (!guard(res)) return;
      const existing = this.backupManager.getProfile(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Backup profile not found' });

      // A senha nunca sai daqui pela API, então o painel também não a devolve:
      // um corpo sem Password significa "não mexa na senha", não "apague-a".
      const data = Object.assign({}, existing, req.body, { Id: req.params.id });
      if (req.body.Password === undefined || req.body.Password === '') data.Password = existing.Password;

      const result = this.backupManager.updateProfile(data);
      if (result && result.success === false) return res.status(400).json({ error: result.message });
      this._audit(req, 'BACKUP_PROFILE_UPDATED_WEB', {
        targetType: 'backup', target: req.params.id,
        before: { Name: existing.Name, CronExpression: existing.CronExpression, Enabled: existing.Enabled },
        after: { Name: data.Name, CronExpression: data.CronExpression, Enabled: data.Enabled },
      });
      res.json({ success: true, data: Object.assign({}, result, { Password: undefined }) });
    });

    this.app.delete('/api/backups/:id', this._need('backups:delete'), (req, res) => {
      if (!guard(res)) return;
      const existing = this.backupManager.getProfile(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Backup profile not found' });
      this.backupManager.deleteProfile(req.params.id);
      this._audit(req, 'BACKUP_PROFILE_DELETED_WEB', {
        targetType: 'backup', target: req.params.id, before: { Name: existing.Name }, after: null,
      });
      res.json({ success: true, message: `Backup profile "${existing.Name}" deleted` });
    });

    // Testar conexão pede a senha, que é a única vez em que ela entra por aqui -
    // e mesmo assim não é gravada nem devolvida. Só lê, então pede só a leitura
    // da tela: um perfil de backup não é coisa de quem não pode ver a lista.
    this.app.post('/api/backups/test-connection', this._need('backups:view'), async (req, res) => {
      if (!guard(res)) return;
      const { profileId, Host, Port, User, Password } = req.body || {};
      const alvo = profileId ? this.backupManager.getProfile(profileId) : { Host, Port, User, Password };
      if (!alvo) return res.status(404).json({ error: 'Backup profile not found' });
      try {
        const result = await this.backupManager.testConnection(alvo);
        this._audit(req, 'BACKUP_CONNECTION_TESTED_WEB', {
          targetType: 'backup', target: profileId || Host, after: { success: !!(result && result.success) },
        });
        res.json({ success: true, data: result });
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    });

    this.app.post('/api/backups/databases', this._need('backups:view'), async (req, res) => {
      if (!guard(res)) return;
      const { profileId, Host, Port, User, Password } = req.body || {};
      const alvo = profileId ? this.backupManager.getProfile(profileId) : { Host, Port, User, Password };
      if (!alvo) return res.status(404).json({ error: 'Backup profile not found' });
      try {
        res.json({ success: true, data: await this.backupManager.listDatabases(alvo) });
      } catch (e) {
        res.status(502).json({ error: e.message });
      }
    });

    this.app.post('/api/backups/:id/run', this._need('backups:run'), async (req, res) => {
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

  // ─── Sync (sincronismo de pastas) ───
  //
  // A senha do destino (SMB/FTP/SFTP) nunca sai daqui: nem na listagem, nem no
  // corpo de um erro. E um corpo sem Password no PUT significa "não mexa na
  // senha", exatamente como no backup - o painel não a devolve, então "ausente"
  // não pode virar "apagada".
  // Rede de sincronismo: mesmas telas do desktop, com os mesmos escopos. A
  // autorização de dispositivo exige a conta GitHub da sessão - o id numérico
  // sai de req.kyriosUser, que o webAuth validou contra a API do GitHub, e
  // nunca do corpo da requisição. Sem sessão não há autorização possível.
  _networkRoutes() {
    const guard = (res) => {
      if (!this.syncNetwork) { res.status(503).json({ error: 'Sync network unavailable' }); return false; }
      return true;
    };
    const actorOf = (req) => {
      const user = req.kyriosUser;
      if (!user) return null;
      return { githubId: user.id, githubLogin: String(user.login || '').toLowerCase(), githubName: user.name || '', isAdmin: false };
    };
    // `blocked` viaja junto porque "pasta nao salva" sem dizer qual dispositivo
    // travou deixa o operador sem saber o que liberar.
    const reason = (res, result) => res.status(400).json(Object.assign(
      { success: false, error: (result && result.error) || (result && result.reason) || 'network.error' },
      (result && result.blocked) ? { blocked: result.blocked } : {}
    ));

    this.app.get('/api/network/status', this._need('network:view'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.status().then((status) => res.json({ success: true, data: status }), (err) => res.status(500).json({ error: err.message }));
    });

    this.app.get('/api/network/overview', this._need('network:view'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.overview()
        .then((view) => res.json({ success: Boolean(view.ok), data: view }))
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.get('/api/network/folders', this._need('network:view'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.folders()
        .then((result) => res.json({ success: Boolean(result.ok), data: result.folders || [], reason: result.reason }))
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.put('/api/network/folders/:id', this._need('network:write'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.saveFolder(Object.assign({}, req.body, { id: req.params.id }))
        .then((result) => {
          if (!result.ok) { reason(res, result); return; }
          this._audit(req, 'WEB_SYNC_FOLDER_SAVED', { targetId: req.params.id, type: result.folder.type });
          res.json({ success: true, data: result.folder });
        })
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.delete('/api/network/folders/:id', this._need('network:write'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.deleteFolder(req.params.id)
        .then(() => { this._audit(req, 'WEB_SYNC_FOLDER_DELETED', { targetId: req.params.id }); res.json({ success: true }); })
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.get('/api/network/folders/:id/ignores', this._need('network:view'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.ignores(req.params.id)
        .then((result) => res.json({ success: Boolean(result.ok), data: result.ignores || [] }))
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.put('/api/network/folders/:id/ignores', this._need('network:write'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.saveIgnores(req.params.id, (req.body && req.body.ignore) || [])
        .then(() => { this._audit(req, 'WEB_SYNC_IGNORES_SAVED', { targetId: req.params.id }); res.json({ success: true }); })
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.get('/api/network/devices', this._need('network:view'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.devices()
        .then((result) => res.json({ success: Boolean(result.ok), data: result.devices || [], reason: result.reason }))
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.post('/api/network/devices/:deviceId/authorize', this._need('network:write'), (req, res) => {
      if (!guard(res)) return;
      const actor = actorOf(req);
      if (!actor) { res.status(401).json({ success: false, error: 'network.loginRequired' }); return; }
      this.syncNetwork.authorizeDevice({ deviceID: req.params.deviceId, githubId: actor.githubId, githubLogin: actor.githubLogin }, actor)
        .then((result) => {
          if (!result.ok) { res.status(403).json({ success: false, error: result.reason }); return; }
          this._audit(req, 'WEB_SYNC_DEVICE_AUTHORIZED', { targetId: req.params.deviceId, github: `${result.entry.githubLogin}#${result.entry.githubId}` });
          res.json({ success: true, data: result.entry });
        })
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.delete('/api/network/devices/:deviceId/authorize', this._need('network:write'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.revokeDevice(req.params.deviceId)
        .then(() => { this._audit(req, 'WEB_SYNC_DEVICE_REVOKED', { targetId: req.params.deviceId }); res.json({ success: true }); })
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.get('/api/network/instances', this._need('network:view'), (req, res) => {
      if (!guard(res)) return;
      res.json({ success: true, data: this.syncNetwork.listInstances() });
    });

    this.app.post('/api/network/instances', this._need('network:write'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.createInstance(req.body && req.body.name)
        .then((result) => {
          if (!result.ok) { reason(res, result); return; }
          this._audit(req, 'WEB_SYNC_INSTANCE_CREATED', { targetId: result.instance.Id });
          res.status(201).json({ success: true, data: result.instance });
        })
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.delete('/api/network/instances/:id', this._need('network:write'), (req, res) => {
      if (!guard(res)) return;
      this.syncNetwork.removeInstance(req.params.id)
        .then((result) => {
          if (!result.ok) { reason(res, result); return; }
          this._audit(req, 'WEB_SYNC_INSTANCE_REMOVED', { targetId: req.params.id });
          res.json({ success: true });
        })
        .catch((err) => res.status(500).json({ error: err.message }));
    });

    this.app.post('/api/network/daemon/:action', this._need('network:run'), (req, res) => {
      if (!guard(res)) return;
      const action = req.params.action;
      if (!['start', 'stop', 'install'].includes(action)) { res.status(400).json({ error: 'network.unknownAction' }); return; }
      const run = action === 'stop' ? this.syncNetwork.stop() : (action === 'install' ? this.syncNetwork.install() : this.syncNetwork.start());
      run.then((result) => {
        this._audit(req, `WEB_SYNC_DAEMON_${action.toUpperCase()}`, { success: Boolean(result.success) });
        res.json(Object.assign({ success: Boolean(result.success) }, result));
      }).catch((err) => res.status(500).json({ error: err.message }));
    });
  }

  _syncRoutes() {
    const guard = (res) => {
      if (!this.syncManager) { res.status(503).json({ error: 'Sync manager unavailable' }); return false; }      return true;
    };
    const semSenha = (profile) => Object.assign({}, profile, { Password: undefined });
    const pastaDe = (body) => (body && (body.dir || body.path || body.folder)) || '';
    // O motor de destino trabalha no formato dele (path/host/port/user/password)
    // - o mesmo que syncManager monta na execução, para testar a conexão pelas
    // mesmas regras que vão valer na hora de rodar.
    const destinoDe = (fonte) => ({
      path: fonte.DestPath || fonte.path || '',
      host: fonte.Host || fonte.host || '',
      port: fonte.Port || fonte.port || null,
      user: fonte.User || fonte.user || '',
      password: fonte.Password || fonte.password || '',
    });

    this.app.get('/api/sync', this._need('sync:view'), (req, res) => {
      if (!guard(res)) return;
      const data = this.syncManager.getAllProfiles().map(semSenha);
      res.json({ success: true, data, count: data.length });
    });

    // Literais antes de '/api/sync/:id': o Express casa na ordem de registro, e
    // 'engines' seria lido como id.
    this.app.get('/api/sync/engines', this._need('sync:view'), (req, res) => {
      if (!guard(res)) return;
      const data = require('./sync/engines').list();
      res.json({ success: true, data, count: data.length });
    });

    // Analisar, simular, previsualizar e testar conexão só LEEM: percorrem o
    // disco (ou abrem uma conexão) e nada é apagado. Por isso pedem a leitura da
    // tela - igual ao test-connection de backup.
    this.app.post('/api/sync/analyze', this._need('sync:view'), (req, res) => {
      if (!guard(res)) return;
      const body = req.body || {};
      try {
        res.json({
          success: true,
          data: this.syncManager.analyzeFolder(pastaDe(body), {
            useNames: body.useNames,
            useMetadata: body.useMetadata,
            extensions: body.extensions || body.FileExtensions,
            datePattern: body.datePattern || body.DatePatternRegex || '',
          }),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/sync/plan', this._need('sync:view'), async (req, res) => {
      if (!guard(res)) return;
      const body = Object.assign({}, req.body || {});
      // Rascunho: ou vem no corpo, ou vem como um perfil salvo que o painel
      // ajustou antes de simular. A senha usada é a do perfil - e não volta na
      // resposta, que só traz o que seria copiado ou apagado.
      let draft = (body.draft && typeof body.draft === 'object') ? Object.assign({}, body.draft) : body;
      if (body.profileId) {
        const saved = this.syncManager.getProfile(body.profileId);
        if (!saved) return res.status(404).json({ error: 'Sync profile not found' });
        draft = Object.assign({}, saved, draft);
      }
      try {
        res.json({ success: true, data: await this.syncManager.previewSyncPlan(draft) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/sync/retention/preview', this._need('sync:view'), (req, res) => {
      if (!guard(res)) return;
      const body = req.body || {};
      try {
        res.json({
          success: true,
          data: this.syncManager.previewRetention(pastaDe(body), body.Retention || body.retention || {}),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/sync/test-connection', this._need('sync:view'), async (req, res) => {
      if (!guard(res)) return;
      const body = req.body || {};
      // O que veio no corpo vence o perfil salvo: o painel está testando o que a
      // pessoa acabou de digitar, não o que ficou gravado.
      let fonte = body;
      if (body.profileId) {
        const saved = this.syncManager.getProfile(body.profileId);
        if (!saved) return res.status(404).json({ error: 'Sync profile not found' });
        fonte = Object.assign({}, saved, body);
      }
      const engineId = body.Engine || body.engine || fonte.Engine || 'local';
      try {
        const dest = destinoDe(fonte);
        const result = await require('./sync/engines').get(engineId).testConnection(dest);
        this._audit(req, 'SYNC_CONNECTION_TESTED_WEB', {
          targetType: 'sync', target: body.profileId || dest.path,
          after: { engine: engineId, success: !!(result && result.success) },
        });
        res.json({ success: true, data: result });
      } catch (e) {
        this.logger.log('WARN', `Sync connection test failed: ${e.message}`);
        res.status(502).json({ error: e.message });
      }
    });

    this.app.get('/api/sync/:id', this._need('sync:view'), (req, res) => {
      if (!guard(res)) return;
      const profile = this.syncManager.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: 'Sync profile not found' });
      res.json({ success: true, data: semSenha(profile) });
    });

    this.app.post('/api/sync', this._need('sync:write'), (req, res) => {
      if (!guard(res)) return;
      const body = req.body || {};
      if (!body.Name) return res.status(400).json({ error: 'Name is required' });
      const result = this.syncManager.createProfile(body);
      if (result && result.success === false) return res.status(400).json({ error: result.message });
      this._audit(req, 'SYNC_PROFILE_CREATED_WEB', {
        targetType: 'sync', target: (result && result.Id) || body.Name,
        before: null, after: { Name: body.Name, SourcePath: body.SourcePath, DestPath: body.DestPath, Engine: result && result.Engine },
      });
      res.status(201).json({ success: true, data: semSenha(result) });
    });

    this.app.put('/api/sync/:id', this._need('sync:write'), (req, res) => {
      if (!guard(res)) return;
      const existing = this.syncManager.getProfile(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Sync profile not found' });

      const data = Object.assign({}, existing, req.body, { Id: req.params.id });
      // Ausente, vazio ou null é "não mexa na senha": o painel não a devolve, e
      // um null vindo do formulário não pode virar senha apagada.
      if (req.body.Password == null || req.body.Password === '') data.Password = existing.Password;

      const result = this.syncManager.updateProfile(data);
      if (!result) return res.status(404).json({ error: 'Sync profile not found' });
      this._audit(req, 'SYNC_PROFILE_UPDATED_WEB', {
        targetType: 'sync', target: req.params.id,
        before: { Name: existing.Name, SourcePath: existing.SourcePath, DestPath: existing.DestPath, CronExpression: existing.CronExpression, Enabled: existing.Enabled },
        after: { Name: data.Name, SourcePath: data.SourcePath, DestPath: data.DestPath, CronExpression: data.CronExpression, Enabled: data.Enabled },
      });
      res.json({ success: true, data: semSenha(result) });
    });

    this.app.delete('/api/sync/:id', this._need('sync:delete'), (req, res) => {
      if (!guard(res)) return;
      const existing = this.syncManager.getProfile(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Sync profile not found' });
      this.syncManager.deleteProfile(req.params.id);
      this._audit(req, 'SYNC_PROFILE_DELETED_WEB', {
        targetType: 'sync', target: req.params.id, before: { Name: existing.Name, SourcePath: existing.SourcePath }, after: null,
      });
      res.json({ success: true, message: `Sync profile "${existing.Name}" deleted` });
    });

    // Executar copia e apaga no destino (mirror + retenção): é 'run', não
    // 'write'. Só quem pode executar chega perto.
    this.app.post('/api/sync/:id/run', this._need('sync:run'), async (req, res) => {
      if (!guard(res)) return;
      const profile = this.syncManager.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: 'Sync profile not found' });
      try {
        const result = await this.syncManager.executeSync(req.params.id);
        this._audit(req, 'SYNC_EXECUTED_WEB', {
          targetType: 'sync', target: req.params.id,
          after: { profile: profile.Name, success: !!(result && result.success), copied: result && result.copied, deleted: result && result.deleted },
        });
        res.json({ success: true, data: result });
      } catch (e) {
        this.logger.error('Web sync execution failed', e);
        res.status(500).json({ error: e.message });
      }
    });
  }

  // ─── Retenção (agenda de limpeza de uma pasta) ───
  //
  // Executar apaga arquivos de verdade - mesmo peso do sync, mesmo 'run'.
  _retentionRoutes() {
    const guard = (res) => {
      if (!this.retentionManager) { res.status(503).json({ error: 'Retention manager unavailable' }); return false; }
      return true;
    };

    this.app.get('/api/retention', this._need('retention:view'), (req, res) => {
      if (!guard(res)) return;
      const data = this.retentionManager.getAllProfiles();
      res.json({ success: true, data, count: data.length });
    });

    this.app.get('/api/retention/:id', this._need('retention:view'), (req, res) => {
      if (!guard(res)) return;
      const profile = this.retentionManager.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: 'Retention profile not found' });
      res.json({ success: true, data: profile });
    });

    this.app.post('/api/retention', this._need('retention:write'), (req, res) => {
      if (!guard(res)) return;
      let created;
      try {
        created = this.retentionManager.createProfile(req.body);
      } catch (e) {
        // Validação de nome, pasta e política: é erro do pedido, não do servidor.
        return res.status(400).json({ error: e.message });
      }
      this._audit(req, 'RETENTION_PROFILE_CREATED_WEB', {
        targetType: 'retention-profile', target: created.Id,
        before: null, after: { Name: created.Name, FolderPath: created.FolderPath, CronExpression: created.CronExpression },
      });
      res.status(201).json({ success: true, data: created });
    });

    this.app.put('/api/retention/:id', this._need('retention:write'), (req, res) => {
      if (!guard(res)) return;
      const existing = this.retentionManager.getProfile(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Retention profile not found' });
      let updated;
      try {
        updated = this.retentionManager.updateProfile(Object.assign({}, req.body, { Id: req.params.id }));
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      if (!updated) return res.status(404).json({ error: 'Retention profile not found' });
      this._audit(req, 'RETENTION_PROFILE_UPDATED_WEB', {
        targetType: 'retention-profile', target: req.params.id,
        before: { Name: existing.Name, FolderPath: existing.FolderPath, CronExpression: existing.CronExpression, Enabled: existing.Enabled },
        after: { Name: updated.Name, FolderPath: updated.FolderPath, CronExpression: updated.CronExpression, Enabled: updated.Enabled },
      });
      res.json({ success: true, data: updated });
    });

    this.app.delete('/api/retention/:id', this._need('retention:delete'), (req, res) => {
      if (!guard(res)) return;
      const existing = this.retentionManager.getProfile(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Retention profile not found' });
      try {
        this.retentionManager.deleteProfile(req.params.id);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
      this._audit(req, 'RETENTION_PROFILE_DELETED_WEB', {
        targetType: 'retention-profile', target: req.params.id, before: { Name: existing.Name, FolderPath: existing.FolderPath }, after: null,
      });
      res.json({ success: true, message: `Retention profile "${existing.Name}" deleted` });
    });

    // Rodar a agenda é o botão que apaga: cada arquivo sai daqui com nome do
    // autor e IP no log de auditoria.
    this.app.post('/api/retention/:id/run', this._need('retention:run'), async (req, res) => {
      if (!guard(res)) return;
      const profile = this.retentionManager.getProfile(req.params.id);
      if (!profile) return res.status(404).json({ error: 'Retention profile not found' });
      try {
        const result = await this.retentionManager.runProfile(req.params.id);
        this._audit(req, 'RETENTION_EXECUTED_WEB', {
          targetType: 'retention-profile', target: req.params.id,
          after: { profile: profile.Name, folder: profile.FolderPath, ok: !!(result && result.ok), deleted: result && result.deleted },
        });
        res.json({ success: true, data: result });
      } catch (e) {
        this.logger.error('Web retention execution failed', e);
        res.status(500).json({ error: e.message });
      }
    });
  }

  // ─── Windows services ───
  //
  // O painel web administra serviços porque no servidor ele é a única interface
  // disponível: quem fez logoff não tem como abrir o app desktop.
  _serviceRoutes() {
    const guard = (res) => {
      if (!this.serviceManager) { res.status(503).json({ error: 'Service manager unavailable' }); return false; }
      return true;
    };

    const ACOES = {
      start: { metodo: 'startService', audit: 'SERVICE_STARTED_WEB' },
      stop: { metodo: 'stopService', audit: 'SERVICE_STOPPED_WEB' },
      restart: { metodo: 'restartService', audit: 'SERVICE_RESTARTED_WEB' },
    };

    // Parar e reiniciar um serviço derrubam o que roda na máquina: é 'run',
    // não 'write'. Só quem pode executar chega perto.
    this.app.post('/api/services/:name/:action', this._need('services:run'), (req, res) => {
      if (!guard(res)) return;
      const acao = ACOES[req.params.action];
      if (!acao) return res.status(400).json({ error: 'Unknown action' });

      const nome = req.params.name;
      // Só um serviço que o sistema realmente enxerga: sem isso o nome vira
      // argumento de linha de comando para o NSSM.
      const existe = (this.serviceManager.getAllServices() || []).some(s => s.Name === nome);
      if (!existe) return res.status(404).json({ error: 'Service not found' });

      const result = this.serviceManager[acao.metodo](nome);
      this._audit(req, acao.audit, { targetType: 'service', target: nome, after: { action: req.params.action, success: result.success } });
      if (!result.success) return res.status(500).json({ error: result.message });
      res.json({ success: true, message: result.message });
    });

    this.app.delete('/api/services/:name', this._need('services:delete'), (req, res) => {
      if (!guard(res)) return;
      const nome = req.params.name;
      const servico = (this.serviceManager.getAllServices() || []).find(s => s.Name === nome);
      if (!servico) return res.status(404).json({ error: 'Service not found' });
      // Remover um serviço que não é nosso desconfigura a máquina inteira.
      if (!servico.IsManaged) {
        return res.status(403).json({ error: 'Only services created by Kyrios Chronos can be removed from the web panel' });
      }

      const result = this.serviceManager.uninstallService(nome);
      this._audit(req, 'SERVICE_REMOVED_WEB', { targetType: 'service', target: nome, before: { Name: nome }, after: null });
      if (!result.success) return res.status(500).json({ error: result.message });
      res.json({ success: true, message: result.message });
    });
  }

  // ─── Execuções em andamento ───
  _runRoutes() {
    const guard = (res) => {
      if (!this.runRegistry) { res.status(503).json({ error: 'Run registry unavailable' }); return false; }
      return true;
    };

    this.app.get('/api/runs', this._need('runs:view'), (req, res) => {
      if (!guard(res)) return;
      res.json({ success: true, data: this.runRegistry.active(), recent: this.runRegistry.recent() });
    });

    this.app.get('/api/runs/target/:targetId', this._need('runs:view'), (req, res) => {
      if (!guard(res)) return;
      res.json({ success: true, data: this.runRegistry.activeFor(req.params.targetId) });
    });

    // Depois de /target/: o Express casa na ordem de registro, e :id casaria
    // com a palavra "target" primeiro.
    this.app.get('/api/runs/:id', this._need('runs:view'), (req, res) => {
      if (!guard(res)) return;
      const sinceSeq = parseInt(req.query.since, 10) || 0;
      const detail = this.runRegistry.detail(req.params.id, sinceSeq);
      if (!detail) return res.status(404).json({ error: 'Run not found' });
      res.json({ success: true, data: detail });
    });
  }

  // ─── Scripts gerenciados ───
  //
  // O painel envia arquivos de script para uma pasta que o sistema administra.
  // Tudo aqui é sobre não deixar o navegador escolher onde grava: o nome passa
  // por safeFileName, o caminho por safeJoin e a extensão tem lista fechada -
  // o que for gravado aqui o agendador executa depois.
  _scriptRoutes() {
    const raiz = () => {
      const dir = path.join(this.config.configDir, '..', 'scripts');
      try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
      return dir;
    };

    const MAX_BYTES = 8 * 1024 * 1024;

    this.app.get('/api/scripts', this._need('scripts:view'), (req, res) => {
      const dir = raiz();
      let arquivos = [];
      try {
        arquivos = fs.readdirSync(dir)
          .filter(n => security.ALLOWED_SCRIPT_EXT.has(path.extname(n).toLowerCase()))
          .map(n => {
            const st = fs.statSync(path.join(dir, n));
            return { name: n, size: st.size, modified: st.mtime.toISOString(), path: path.join(dir, n) };
          })
          .sort((a, b) => b.modified.localeCompare(a.modified));
      } catch (e) {}
      res.json({ success: true, data: arquivos, count: arquivos.length, dir });
    });

    this.app.get('/api/scripts/:name', this._need('scripts:view'), (req, res) => {
      const nome = security.safeFileName(req.params.name);
      if (!nome) return res.status(400).json({ error: 'Invalid file name' });
      const full = security.safeJoin(raiz(), nome);
      if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'Script not found' });
      res.json({ success: true, data: { name: nome, path: full, content: fs.readFileSync(full, 'utf8') } });
    });

    // O corpo vem em base64 num JSON: evita uma dependência de multipart e
    // deixa o limite de tamanho explícito nesta rota, em vez de afrouxar o
    // limite global por causa de uma só.
    this.app.post('/api/scripts', this._need('scripts:write'), express.json({ limit: '12mb' }), (req, res) => {
      const nome = security.safeFileName((req.body || {}).name);
      if (!nome) {
        return res.status(400).json({
          error: 'Invalid file name',
          message: 'Use a plain file name with one of these extensions: ' + [...security.ALLOWED_SCRIPT_EXT].join(', '),
        });
      }

      const bruto = (req.body || {}).contentBase64;
      if (typeof bruto !== 'string') return res.status(400).json({ error: 'contentBase64 is required' });

      let buffer;
      try { buffer = Buffer.from(bruto, 'base64'); }
      catch (e) { return res.status(400).json({ error: 'Malformed base64 content' }); }
      if (buffer.length > MAX_BYTES) return res.status(413).json({ error: 'Script is too large', maxBytes: MAX_BYTES });

      const full = security.safeJoin(raiz(), nome);
      if (!full) return res.status(400).json({ error: 'Invalid file name' });

      const existia = fs.existsSync(full);
      if (existia && req.body.overwrite !== true) {
        return res.status(409).json({ error: 'A script with that name already exists', name: nome });
      }

      try {
        fs.writeFileSync(full, buffer);
      } catch (e) {
        this.logger.error('Script upload failed', e, { name: nome });
        return res.status(500).json({ error: e.message });
      }

      this._audit(req, existia ? 'SCRIPT_REPLACED_WEB' : 'SCRIPT_UPLOADED_WEB', {
        targetType: 'script', target: nome,
        before: existia ? { name: nome } : null,
        after: { name: nome, bytes: buffer.length },
      });
      this.logger.log('INFO', `Script ${existia ? 'replaced' : 'uploaded'} via web: ${nome} (${buffer.length} bytes)`);
      res.status(existia ? 200 : 201).json({ success: true, data: { name: nome, path: full, size: buffer.length } });
    });

    this.app.delete('/api/scripts/:name', this._need('scripts:delete'), (req, res) => {
      const nome = security.safeFileName(req.params.name);
      if (!nome) return res.status(400).json({ error: 'Invalid file name' });
      const full = security.safeJoin(raiz(), nome);
      if (!full || !fs.existsSync(full)) return res.status(404).json({ error: 'Script not found' });

      // Um script apagado por baixo de uma tarefa agendada vira falha silenciosa
      // na próxima execução, então o painel avisa quem usa.
      const emUso = this.taskManager.getAllTasks().filter(t => (t.ScriptPath || '').toLowerCase() === full.toLowerCase());
      if (emUso.length && req.query.force !== 'true') {
        return res.status(409).json({
          error: 'Script is in use',
          tasks: emUso.map(t => ({ Id: t.Id, Name: t.Name })),
        });
      }

      fs.unlinkSync(full);
      this._audit(req, 'SCRIPT_DELETED_WEB', { targetType: 'script', target: nome, before: { name: nome }, after: null });
      res.json({ success: true, message: `Script "${nome}" deleted` });
    });
  }

  // ─── Everything else ───
  _miscRoutes() {
    this.app.get('/api/logs', this._need('logs:view'), (req, res) => {
      const limit = parseInt(req.query.limit, 10) || 200;
      // From disk, so the web UI also sees what the service did.
      const logs = this.logger.getRecentLogsFromDisk
        ? this.logger.getRecentLogsFromDisk(limit)
        : this.logger.getRecentLogs(limit);
      res.json({ success: true, data: logs, count: logs.length });
    });

    this.app.get('/api/logs/errors', this._need('logs:view'), (req, res) => {
      const limit = parseInt(req.query.limit, 10) || 300;
      const read = primary => typeof this.logger[primary] === 'function'
        ? this.logger[primary](limit)
        : (typeof this.logger[primary.replace('FromDisk', '')] === 'function' ? this.logger[primary.replace('FromDisk', '')](limit) : []);
      const data = read('getRecentErrorsFromDisk');
      res.json({ success: true, data: data || [], count: (data || []).length });
    });

    this.app.get('/api/logs/audit', this._need('logs:view'), (req, res) => {
      const limit = parseInt(req.query.limit, 10) || 300;
      const read = primary => typeof this.logger[primary] === 'function'
        ? this.logger[primary](limit)
        : (typeof this.logger[primary.replace('FromDisk', '')] === 'function' ? this.logger[primary.replace('FromDisk', '')](limit) : []);
      const data = read('getRecentAuditFromDisk');
      res.json({ success: true, data: data || [], count: (data || []).length });
    });

    this.app.get('/api/logs/stats', this._need('logs:view'), (req, res) => {
      const stats = typeof this.logger.getStats === 'function' ? this.logger.getStats() : {};
      res.json({ success: true, data: stats });
    });

    this.app.get('/api/services', this._need('services:view'), (req, res) => {
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

    this.app.get('/api/calendar', this._need('calendar:view'), (req, res) => {
      try {
        const calendar = require('./calendarData');
        const from = new Date(req.query.from || Date.now() - 7 * 86400000);
        const to = new Date(req.query.to || Date.now() + 7 * 86400000);
        let backupHistory = [];
        try { backupHistory = (this.backupManager && this.backupManager.getHistory ? this.backupManager.getHistory() : []) || []; } catch (e) {}

        res.json({ success: true, data: calendar.build(this.cronParser, {
          tasks: this.taskManager.getAllTasks(),
          profiles: this.backupManager ? this.backupManager.getAllProfiles() : [],
          taskHistory: this.taskManager.history || [],
          backupHistory,
        }, { from, to }, {}) });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    this.app.post('/api/schedule/conflicts', (req, res) => {
      try {
        const advisor = require('./scheduleAdvisor');
        const { expression, excludeId } = req.body || {};
        if (!expression) return res.status(400).json({ error: 'expression is required' });

        const agenda = advisor.collectSchedules(
          this.taskManager.getAllTasks(),
          this.backupManager ? this.backupManager.getAllProfiles() : []
        );
        const conflicts = advisor.findConflicts(this.cronParser, expression, agenda, { excludeId });
        const suggestion = conflicts.length
          ? advisor.suggestFreeSlot(this.cronParser, expression, agenda, { excludeId })
          : null;
        res.json({ success: true, data: { conflicts, suggestion, totalScheduled: agenda.length } });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
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

    // Sem isto o express responde uma página de erro com o stack trace dentro -
    // que é exatamente o tipo de coisa que não se entrega a quem está sondando.
    this.app.use((err, req, res, next) => {
      const status = err.status || err.statusCode || 500;
      if (status >= 500) this.logger.error(`Unhandled error on ${req.method} ${req.path}`, err);
      else this.logger.log('WARN', `${req.method} ${req.path} refused: ${err.message}`);
      if (res.headersSent) return next(err);
      res.status(status).json({
        error: status === 413 ? 'Payload too large' : (status < 500 ? err.message : 'Internal error'),
      });
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
  <p style="font-size:13px;color:var(--text2)">A browser session signed in with GitHub can be limited per screen (view / write / run / delete) in the <code>WebUserPermissions</code> setting; a call outside the account's scopes answers <code>403 Forbidden</code> with the scope it needed. API key requests are not limited that way.</p>

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
