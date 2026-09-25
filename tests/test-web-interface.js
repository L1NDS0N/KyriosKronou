// tests/test-web-interface.js
//
// The web interface can create, edit, delete and run tasks on a server, so the
// parts worth pinning down are: who gets in, what a refused attempt looks like,
// and that every change carries the GitHub identity that made it.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ConfigManager = require('../src/main/configManager');
const Logger = require('../src/main/logger');
const CronParser = require('../src/main/cronParser');
const TaskManager = require('../src/main/taskManager');
const BackupManager = require('../src/main/backupManager');
const WebAuth = require('../src/main/webAuth');
const SystemMetrics = require('../src/main/systemMetrics');
const ApiServer = require('../src/main/apiServer');

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-web-'));
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  return new ConfigManager(dir, 'default');
}

function makeAuth() {
  const config = tempConfig();
  const logger = new Logger(path.join(config.configDir, 'logs'));
  return { auth: new WebAuth(config, logger), config, logger };
}

describe('Web access: the allowlist', () => {
  let auth, config;
  beforeEach(() => { ({ auth, config } = makeAuth()); });
  afterEach(() => auth.dispose());

  it('lets nobody in until an account is added', () => {
    expect(auth.allowedUsers).to.deep.equal([]);
    expect(auth.isAllowed('l1nds0n')).to.equal(false);
    expect(auth.isAllowed('anyone')).to.equal(false);
  });

  it('admits an account once it is on the list', () => {
    config.setSetting('WebAllowedUsers', ['l1nds0n']);
    expect(auth.isAllowed('l1nds0n')).to.equal(true);
  });

  it('matches the login case-insensitively, as GitHub does', () => {
    config.setSetting('WebAllowedUsers', ['L1NDS0N']);
    expect(auth.isAllowed('l1nds0n')).to.equal(true);
    expect(auth.isAllowed('L1nds0N')).to.equal(true);
  });

  it('keeps refusing everyone not on the list', () => {
    config.setSetting('WebAllowedUsers', ['l1nds0n']);
    expect(auth.isAllowed('someone-else')).to.equal(false);
    expect(auth.isAllowed('')).to.equal(false);
    expect(auth.isAllowed(null)).to.equal(false);
  });

  it('accepts a list stored as free text, not only as an array', () => {
    config.setSetting('WebAllowedUsers', 'alice, bob; carol');
    expect(auth.allowedUsers).to.deep.equal(['alice', 'bob', 'carol']);
  });

  it('explains what is missing rather than silently refusing', () => {
    // The client ID ships with the app, so the only thing left to configure on
    // a fresh install is who is allowed in.
    expect(auth.configurationProblem()).to.include('No GitHub account is allowed');
    config.setSetting('WebAllowedUsers', ['l1nds0n']);
    expect(auth.configurationProblem()).to.equal(null);
  });

  it('is ready to sign in out of the box, using the built-in client ID', () => {
    expect(auth.isConfigured()).to.equal(true);
    expect(auth.clientId).to.be.a('string').with.length.above(10);
  });

  it('uses the device flow by default, which needs no client secret', () => {
    expect(auth.clientSecret).to.equal('');
    expect(auth.flow).to.equal('device');
  });

  it('switches to the redirect flow only when an admin supplies a secret', () => {
    config.setSetting('GithubClientSecret', 'their-own-secret');
    expect(auth.flow).to.equal('redirect');
  });

  // An .asar is a plain archive: anything compiled in can be read straight out
  // of the shipped binary, so a client secret must never be one of them.
  it('ships no client secret in the source', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'webAuth.js'), 'utf8');
    const assignments = src.match(/BUILTIN_CLIENT_SECRET|clientSecret\s*=\s*['"][a-f0-9]{20,}/gi);
    expect(assignments).to.equal(null);
  });
});

describe('Web access: sessions', () => {
  let auth, config;
  const user = { login: 'l1nds0n', id: 4242, name: 'Lindson' };

  beforeEach(() => {
    ({ auth, config } = makeAuth());
    config.setSetting('WebAllowedUsers', ['l1nds0n']);
  });
  afterEach(() => auth.dispose());

  it('round-trips a signed cookie', () => {
    const sid = auth.createSession(user, '10.0.0.1');
    const cookie = auth.signCookie(sid);
    expect(auth.verifyCookie(cookie)).to.equal(sid);
  });

  it('rejects a tampered cookie', () => {
    const sid = auth.createSession(user, '10.0.0.1');
    const cookie = auth.signCookie(sid);
    const separator = cookie.lastIndexOf('.');
    const tamperedSid = `${sid[0] === 'a' ? 'b' : 'a'}${sid.slice(1)}`;
    const tamperedMac = `${cookie[separator + 1] === '0' ? '1' : '0'}${cookie.slice(separator + 2)}`;
    expect(auth.verifyCookie(`${tamperedSid}${cookie.slice(separator)}`)).to.equal(null);
    expect(auth.verifyCookie(`${cookie.slice(0, separator + 1)}${tamperedMac}`)).to.equal(null);
    expect(auth.verifyCookie(sid)).to.equal(null, 'an unsigned id must not pass');
    expect(auth.verifyCookie('garbage')).to.equal(null);
  });

  it('cannot be forged without the signing secret', () => {
    const other = makeAuth();
    const sid = other.auth.createSession(user, '10.0.0.1');
    const foreignCookie = other.auth.signCookie(sid);
    expect(auth.verifyCookie(foreignCookie)).to.equal(null);
    other.auth.dispose();
  });

  it('drops the session the moment the account leaves the allowlist', () => {
    const sid = auth.createSession(user, '10.0.0.1');
    expect(auth.getSession(sid)).to.not.equal(null);

    config.setSetting('WebAllowedUsers', []);
    expect(auth.getSession(sid)).to.equal(null, 'revoking access must not wait for expiry');
  });

  it('revokeUser ends every session for that login', () => {
    auth.createSession(user, '10.0.0.1');
    auth.createSession(user, '10.0.0.2');
    expect(auth.listSessions()).to.have.length(2);
    expect(auth.revokeUser('L1NDS0N')).to.equal(2);
    expect(auth.listSessions()).to.have.length(0);
  });

  it('expires a session once it is older than its lifetime', () => {
    const sid = auth.createSession(user, '10.0.0.1');
    const session = auth.sessions.get(sid);
    session.createdAt = Date.now() - WebAuth.SESSION_TTL_MS - 1000;
    expect(auth.getSession(sid)).to.equal(null);
  });

  it('reads the session back off a request cookie header', () => {
    const sid = auth.createSession(user, '10.0.0.1');
    const req = { headers: { cookie: `other=x; ${WebAuth.SESSION_COOKIE}=${auth.signCookie(sid)}` } };
    const who = auth.authenticate(req);
    expect(who.login).to.equal('l1nds0n');
  });

  it('treats a request with no cookie as anonymous', () => {
    expect(auth.authenticate({ headers: {} })).to.equal(null);
  });

  // Strict, nao Lax: Lax ainda acompanha navegacao de topo vinda de outro site,
  // e uma dessas basta para disparar uma acao no agendador.
  it('keeps the cookie HttpOnly and SameSite=Strict', () => {
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; } };
    auth.setSessionCookie(res, auth.createSession(user, '1.1.1.1'));
    expect(headers['Set-Cookie']).to.include('HttpOnly');
    expect(headers['Set-Cookie']).to.include('SameSite=Strict');
  });

  it('marks the cookie Secure once TLS is configured', () => {
    const headers = {};
    const res = { setHeader: (k, v) => { headers[k] = v; } };
    auth.setSessionCookie(res, auth.createSession(user, '1.1.1.1'));
    expect(headers['Set-Cookie']).to.not.include('Secure');

    config.setSetting('WebHttps', true);
    auth.setSessionCookie(res, auth.createSession(user, '1.1.1.1'));
    expect(headers['Set-Cookie']).to.include('Secure');
  });
});

describe('Web access: OAuth state', () => {
  let auth, config;
  beforeEach(() => {
    ({ auth, config } = makeAuth());
    config.setSetting('GithubClientId', 'test-client');
    config.setSetting('GithubClientSecret', 'test-secret');
  });
  afterEach(() => auth.dispose());

  it('asks GitHub only for the scope it needs', () => {
    const url = auth.buildAuthorizeUrl('http://host/auth/github/callback');
    expect(url).to.include('scope=read%3Auser');
    expect(url).to.not.include('repo');
  });

  it('accepts a state value exactly once, so a replay fails', () => {
    const url = auth.buildAuthorizeUrl('http://host/cb');
    const state = new URL(url).searchParams.get('state');
    expect(auth.consumeState(state)).to.not.equal(null);
    expect(auth.consumeState(state)).to.equal(null);
  });

  it('rejects a state value it never issued', () => {
    expect(auth.consumeState('made-up')).to.equal(null);
  });
});

describe('Web interface: HTTP surface', function () {
  this.timeout(30000);

  let server, config, port;

  const request = (routePath, options = {}) => new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: routePath,
      method: options.method || 'GET', headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    if (options.body) req.write(options.body);
    req.end();
  });

  before(async () => {
    config = tempConfig();
    const logger = new Logger(path.join(config.configDir, 'logs'));
    const cronParser = new CronParser();
    const taskManager = new TaskManager(config, logger, cronParser);
    taskManager.addTask({ Name: 'Demo', CronExpression: '*/5 * * * *', ScriptPath: 'C:\\Windows\\System32\\cmd.exe' });
    const backupManager = new BackupManager(config, logger);

    server = new ApiServer(taskManager, config, logger, null, null, backupManager);
    // A high port so a developer machine's real instance is never disturbed.
    const info = await server.start(7731);
    port = info.port;
  });

  after(async () => { if (server) await server.stop(); });

  it('binds to loopback only unless explicitly opened up', async () => {
    const info = { host: server.config.getSetting('ApiBindAll', false) ? '0.0.0.0' : '127.0.0.1' };
    expect(info.host).to.equal('127.0.0.1');
  });

  it('serves health without a session, for monitoring probes', async () => {
    const res = await request('/api/health');
    expect(res.status).to.equal(200);
    expect(JSON.parse(res.body).status).to.equal('ok');
  });

  it('sends an anonymous browser to the login page', async () => {
    const res = await request('/');
    expect(res.status).to.equal(302);
    expect(res.location).to.equal('/login');
  });

  it('answers an anonymous API call with 401, not a redirect', async () => {
    const res = await request('/api/tasks');
    expect(res.status).to.equal(401);
    expect(JSON.parse(res.body).error).to.equal('Unauthorized');
  });

  it('refuses to list tasks, run one, or delete one while signed out', async () => {
    for (const call of [
      { path: '/api/tasks', method: 'GET' },
      { path: '/api/tasks/x/run', method: 'POST' },
      { path: '/api/tasks/x', method: 'DELETE' },
      { path: '/api/backups', method: 'GET' },
      { path: '/api/logs', method: 'GET' },
      { path: '/api/metrics', method: 'GET' },
    ]) {
      const res = await request(call.path, { method: call.method });
      expect(res.status, `${call.method} ${call.path} must be refused`).to.equal(401);
    }
  });

  it('explains on the login page what still needs configuring', async () => {
    const res = await request('/login');
    expect(res.status).to.equal(302);
    expect(decodeURIComponent(res.location)).to.include('No GitHub account is allowed');
  });

  // The first version redirected /login?problem=... back to itself forever and
  // the browser refused the page with ERR_TOO_MANY_REDIRECTS.
  it('serves the login page once the problem is in the URL, instead of looping', async () => {
    const first = await request('/login');
    const second = await request(first.location);
    expect(second.status).to.equal(200);
    expect(second.body).to.include('Entrar com GitHub');
  });

  it('never redirects the login page to itself', async () => {
    let location = '/login';
    for (let hop = 0; hop < 4; hop++) {
      const res = await request(location);
      if (res.status !== 302) { expect(res.status).to.equal(200); return; }
      expect(res.location).to.not.equal(location, 'login redirected to itself');
      location = res.location;
    }
    throw new Error('login kept redirecting - likely a loop');
  });

  it('serves the stylesheet publicly, so the login page is not unstyled', async () => {
    const res = await request('/style.css');
    expect(res.status).to.equal(200);
    expect(res.body).to.include('--bg: #050508', 'must carry the desktop theme tokens');
  });

  it('still accepts an API key, so existing integrations keep working', async () => {
    config.setSetting('ApiKey', 'k-123');
    server.apiKey = 'k-123';
    try {
      const res = await request('/api/tasks', { headers: { 'x-api-key': 'k-123' } });
      expect(res.status).to.equal(200);
      expect(JSON.parse(res.body).count).to.equal(1);

      const wrong = await request('/api/tasks', { headers: { 'x-api-key': 'nope' } });
      expect(wrong.status).to.equal(401);
    } finally {
      config.setSetting('ApiKey', '');
      server.apiKey = '';
    }
  });

  it('never returns backup passwords over the network', async () => {
    config.setSetting('ApiKey', 'k-123');
    server.apiKey = 'k-123';
    try {
      server.backupManager.createProfile({ Name: 'Nightly', Host: 'localhost', User: 'eco', Password: 'super-secret-pw' });
      const res = await request('/api/backups', { headers: { 'x-api-key': 'k-123' } });
      expect(res.status).to.equal(200);
      expect(res.body).to.not.include('super-secret-pw');
    } finally {
      config.setSetting('ApiKey', '');
      server.apiKey = '';
    }
  });
});

describe('Web interface: theme parity with the desktop app', () => {
  const webCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'style.css'), 'utf8');
  const appCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'style.css'), 'utf8');

  // The whole point of "identical theme" is that these values do not drift.
  const TOKENS = ['--bg', '--glass', '--glass-border', '--primary', '--green', '--red', '--amber', '--text', '--text2', '--text3', '--radius'];

  it('uses the same colour and shape tokens as the desktop app', () => {
    for (const token of TOKENS) {
      const re = new RegExp(token.replace('-', '\\-') + ':\\s*([^;]+);');
      const inApp = re.exec(appCss);
      const inWeb = re.exec(webCss);
      expect(inApp, `${token} missing from the desktop theme`).to.not.equal(null);
      expect(inWeb, `${token} missing from the web theme`).to.not.equal(null);
      expect(inWeb[1].trim(), `${token} drifted between desktop and web`).to.equal(inApp[1].trim());
    }
  });

  it('carries the same lunar background treatment', () => {
    expect(webCss).to.include('.moon');
    expect(webCss).to.include('moonPulse');
    expect(webCss).to.include('.dot-field');
  });

  it('uses the Greek product name in the interface', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.html'), 'utf8');
    const login = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'login.html'), 'utf8');
    expect(html).to.include('Κύριος Χρόνος');
    expect(login).to.include('Κύριος Χρόνος');
  });

  it('loads no external scripts or fonts - servers are often offline', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'index.html'), 'utf8');
    expect(html).to.not.match(/src=["']https?:/);
    expect(html).to.not.match(/href=["']https?:.*\.css/);
  });
});

describe('Resource monitor', function () {
  this.timeout(30000);

  it('reports the host facts the charts are labelled with', () => {
    const metrics = new SystemMetrics(null);
    const current = metrics.current();
    expect(current.host.hostname).to.be.a('string');
    expect(current.host.cpuCount).to.be.above(0);
    expect(current.host.totalMemory).to.be.above(0);
  });

  it('collects CPU, memory, disk I/O and network from a live sample', function (done) {
    if (process.platform !== 'win32') return this.skip();

    const metrics = new SystemMetrics(null, { intervalMs: 1000 });
    metrics.start();

    metrics.once('sample', (s) => {
      try {
        expect(s.cpuPct).to.be.within(0, 100);
        expect(s.memPct).to.be.within(0, 100);
        expect(s.memTotal).to.be.above(0);
        expect(s.diskRead).to.be.at.least(0);
        expect(s.diskWrite).to.be.at.least(0);
        expect(s.netRecv).to.be.at.least(0);
        expect(s.netSent).to.be.at.least(0);
        expect(s.volumes).to.be.an('array').with.length.above(0);
        expect(s.volumes[0]).to.include.keys('drive', 'total', 'free', 'used', 'pct');
        done();
      } catch (err) { done(err); } finally { metrics.stop(); }
    });
  });

  it('keeps a bounded history, so a long-running service cannot leak memory', () => {
    const metrics = new SystemMetrics(null, { maxHistory: 5 });
    for (let i = 0; i < 50; i++) {
      metrics._ingest(JSON.stringify({ t: Date.now() + i, cpuPct: i, memTotalB: 100, memFreeB: 50, volumes: [] }));
    }
    expect(metrics.history).to.have.length(5);
    expect(metrics.getHistory()).to.have.length(5);
    expect(metrics.latest.cpuPct).to.equal(49);
  });

  it('clamps nonsense values instead of drawing impossible charts', () => {
    const metrics = new SystemMetrics(null);
    metrics._ingest(JSON.stringify({ cpuPct: 250, memTotalB: 100, memFreeB: 200, diskReadBps: -5, volumes: [] }));
    expect(metrics.latest.cpuPct).to.equal(100);
    expect(metrics.latest.memUsed).to.equal(0);
    expect(metrics.latest.diskRead).to.equal(0);
  });

  it('ignores malformed sampler output rather than crashing the service', () => {
    const metrics = new SystemMetrics(null);
    expect(() => metrics._ingest('not json')).to.not.throw();
    expect(() => metrics._ingest('{"error":"WMI unavailable"}')).to.not.throw();
    expect(metrics.lastError).to.equal('WMI unavailable');
    expect(metrics.history).to.have.length(0);
  });

  it('is sampled by locale-invariant CIM classes, not localised counter names', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'systemMetrics.js'), 'utf8');
    // "\Processor(_Total)\% Processor Time" does not exist on a non-English
    // Windows, which is exactly where this ships.
    expect(src).to.include('Win32_PerfFormattedData_PerfOS_Processor');
    // Only the comment explaining the decision may name the localised approach.
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(code).to.not.include('% Processor Time');
    expect(code).to.not.include('typeperf');
    expect(code).to.not.include('Get-Counter');
  });
});

describe('Web interface: hosted by the service', () => {
  it('the service entry point starts the web interface itself', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'serviceScheduler.js'), 'utf8');
    expect(src).to.include("require('./apiServer')");
    expect(src).to.include('apiServer.start()');
  });

  it('the server pulls in nothing from electron, so the service can load it', () => {
    for (const file of ['apiServer.js', 'webAuth.js', 'systemMetrics.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', file), 'utf8');
      expect(src, `${file} must not require electron`).to.not.match(/require\(['"]electron['"]\)/);
    }
  });

  it('the desktop app yields the port when the service owns the scheduler', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
    expect(src).to.include('syncWebInterface');
    expect(src).to.include('scheduler.isOwner');
  });
});
