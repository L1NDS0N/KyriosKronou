// webAuth.js - GitHub sign-in for the web interface.
//
// Every change made through the web UI is attributed to a real GitHub account,
// so the audit log answers "who did this" rather than just "someone on the
// network". Access is deny-by-default: until an administrator adds a login to
// the allowlist in the desktop app, nobody gets in - including the person who
// owns the OAuth app.
//
// No external session library: a signed, HttpOnly cookie carrying a random id
// plus a server-side session map is all this needs, and it keeps the service
// free of another dependency.

const crypto = require('crypto');
const https = require('https');

// Built-in OAuth client. A client ID is NOT a secret - GitHub publishes it in
// every authorize URL - so shipping it inside the app is fine and means an
// install needs no configuration at all.
//
// The client SECRET is deliberately absent. An .asar is a plain archive, not an
// encrypted one: any secret compiled into the app can be read out of the
// shipped binary with a text editor, so a "secret" distributed to every
// customer is not a secret. Instead the app uses GitHub's device flow, which
// exists precisely for clients that cannot keep one.
const BUILTIN_CLIENT_ID = 'Ov23limjCfEniWd6J6CR';

const SESSION_COOKIE = 'kyrios_sid';
const DEVICE_POLL_TIMEOUT_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const STATE_TTL_MS = 10 * 60 * 1000;        // OAuth round trip

class WebAuth {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.sessions = new Map(); // sid -> { user, createdAt, lastSeen, ip }
    this.states = new Map();   // state -> { createdAt, redirectTo }

    // Signing key for the session cookie. Generated once and persisted so
    // sessions survive a restart of the app or service.
    let secret = this.config.getSetting('WebSessionSecret', '');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      this.config.setSetting('WebSessionSecret', secret);
    }
    this.secret = secret;

    this._sweepTimer = setInterval(() => this._sweep(), 60000);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  // ─── Configuration ───

  get clientId() {
    return (this.config.getSetting('GithubClientId', '') || '').trim() || BUILTIN_CLIENT_ID;
  }
  get clientSecret() { return (this.config.getSetting('GithubClientSecret', '') || '').trim(); }

  /** Logins allowed in, lower-cased. Empty means nobody. */
  get allowedUsers() {
    const raw = this.config.getSetting('WebAllowedUsers', []);
    const list = Array.isArray(raw)
      ? raw
      : String(raw || '').split(/[\s,;]+/);
    return list.map(u => String(u || '').trim().toLowerCase()).filter(Boolean);
  }

  /**
   * How sign-in will be performed.
   *  - 'device'   : no client secret needed. The browser shows a code the user
   *                 types at github.com/login/device. This is the default and
   *                 works out of the box on a fresh install.
   *  - 'redirect' : the classic authorization-code flow, used only when an
   *                 administrator has supplied their own client secret.
   */
  get flow() {
    return this.clientSecret ? 'redirect' : 'device';
  }

  /** True once GitHub sign-in can actually be performed. */
  isConfigured() {
    return !!this.clientId;
  }

  /**
   * Why sign-in is unavailable, or null when it is ready.
   * Surfaced on the login page so an operator is never left guessing.
   */
  configurationProblem() {
    if (!this.clientId) {
      return 'GitHub sign-in is not configured. In the desktop app open Settings > Web Access and enter a GitHub OAuth App Client ID.';
    }
    if (this.allowedUsers.length === 0) {
      return 'No GitHub account is allowed in yet. In the desktop app open Settings > Web Interface and add the logins that may sign in.';
    }
    return null;
  }

  isAllowed(login) {
    if (!login) return false;
    return this.allowedUsers.includes(String(login).toLowerCase());
  }

  // ─── OAuth ───

  /** Build the GitHub authorize URL and remember the anti-CSRF state. */
  buildAuthorizeUrl(callbackUrl, redirectTo = '/') {
    const state = crypto.randomBytes(24).toString('hex');
    this.states.set(state, { createdAt: Date.now(), redirectTo });

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: callbackUrl,
      // read:user is enough to learn the login; no repository access is asked for.
      scope: 'read:user',
      state,
      allow_signup: 'false',
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  /** Validate and burn a state value. Single use, so a replay cannot succeed. */
  consumeState(state) {
    const entry = this.states.get(state);
    if (!entry) return null;
    this.states.delete(state);
    if (Date.now() - entry.createdAt > STATE_TTL_MS) return null;
    return entry;
  }

  async exchangeCodeForToken(code, callbackUrl) {
    const body = JSON.stringify({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: callbackUrl,
    });

    const res = await httpsJson({
      hostname: 'github.com',
      path: '/login/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'KyriosChronos',
      },
    }, body);

    if (res.error) throw new Error(res.error_description || res.error);
    if (!res.access_token) throw new Error('GitHub did not return an access token');
    return res.access_token;
  }

  // ─── Device flow ───
  //
  // GitHub hands back a short code; the operator types it at
  // github.com/login/device and approves there. No client secret is involved,
  // which is why this is the default for a shipped app.

  async startDeviceFlow() {
    const body = JSON.stringify({ client_id: this.clientId, scope: 'read:user' });
    const res = await httpsJson({
      hostname: 'github.com',
      path: '/login/device/code',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'KyriosChronos',
      },
    }, body);

    if (res.error) {
      // The most common cause by far, and the message GitHub returns is opaque.
      if (res.error === 'device_flow_disabled') {
        throw new Error('Device flow is turned off on the GitHub OAuth App. Enable "Device flow" in its settings at github.com/settings/developers.');
      }
      throw new Error(res.error_description || res.error);
    }
    if (!res.device_code) throw new Error('GitHub did not start the device flow');

    return {
      deviceCode: res.device_code,
      userCode: res.user_code,
      verificationUri: res.verification_uri || 'https://github.com/login/device',
      interval: Math.max(5, parseInt(res.interval, 10) || 5),
      expiresIn: parseInt(res.expires_in, 10) || 900,
    };
  }

  /**
   * Ask GitHub whether the code has been approved yet.
   * Returns { status: 'pending' | 'slow_down' | 'token', token?, message? } so
   * the caller can poll without treating "not yet" as a failure.
   */
  async pollDeviceFlow(deviceCode) {
    const body = JSON.stringify({
      client_id: this.clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });

    const res = await httpsJson({
      hostname: 'github.com',
      path: '/login/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'KyriosChronos',
      },
    }, body);

    if (res.access_token) return { status: 'token', token: res.access_token };

    switch (res.error) {
      case 'authorization_pending': return { status: 'pending' };
      case 'slow_down': return { status: 'slow_down', interval: parseInt(res.interval, 10) || 10 };
      case 'expired_token': return { status: 'error', message: 'The code expired. Start again.' };
      case 'access_denied': return { status: 'error', message: 'Authorisation was refused on GitHub.' };
      default: return { status: 'error', message: res.error_description || res.error || 'Unknown response from GitHub' };
    }
  }

  async fetchGithubUser(token) {
    const user = await httpsJson({
      hostname: 'api.github.com',
      path: '/user',
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'KyriosChronos',
      },
    });
    if (!user || !user.login) throw new Error('Could not read the GitHub profile');
    return {
      login: user.login,
      id: user.id,
      name: user.name || user.login,
      avatar: user.avatar_url || '',
    };
  }

  // ─── Sessions ───

  createSession(user, ip) {
    const sid = crypto.randomBytes(32).toString('hex');
    this.sessions.set(sid, { user, ip, createdAt: Date.now(), lastSeen: Date.now() });
    return sid;
  }

  getSession(sid) {
    if (!sid) return null;
    const session = this.sessions.get(sid);
    if (!session) return null;
    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
      this.sessions.delete(sid);
      return null;
    }
    // A login removed from the allowlist loses access on its next request,
    // without waiting for the session to expire.
    if (!this.isAllowed(session.user.login)) {
      this.sessions.delete(sid);
      return null;
    }
    session.lastSeen = Date.now();
    return session;
  }

  destroySession(sid) {
    if (sid) this.sessions.delete(sid);
  }

  /** Drop every session belonging to a login (used when access is revoked). */
  revokeUser(login) {
    const target = String(login || '').toLowerCase();
    let removed = 0;
    for (const [sid, session] of this.sessions) {
      if (session.user.login.toLowerCase() === target) {
        this.sessions.delete(sid);
        removed++;
      }
    }
    return removed;
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      login: s.user.login,
      name: s.user.name,
      ip: s.ip,
      since: new Date(s.createdAt).toISOString(),
      lastSeen: new Date(s.lastSeen).toISOString(),
    }));
  }

  // ─── Cookies ───

  signCookie(sid) {
    const mac = crypto.createHmac('sha256', this.secret).update(sid).digest('hex');
    return `${sid}.${mac}`;
  }

  verifyCookie(value) {
    if (!value || typeof value !== 'string') return null;
    const idx = value.lastIndexOf('.');
    if (idx <= 0) return null;
    const sid = value.slice(0, idx);
    const mac = value.slice(idx + 1);
    const expected = crypto.createHmac('sha256', this.secret).update(sid).digest('hex');
    // Constant-time compare so the signature cannot be guessed byte by byte.
    const a = Buffer.from(mac, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return sid;
  }

  /** Secure so navegador nenhum mande o cookie em claro - e so quando ha TLS. */
  get cookieSecure() { return !!this.config.getSetting('WebHttps', false); }

  setSessionCookie(res, sid) {
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${this.signCookie(sid)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${this.cookieSecure ? '; Secure' : ''}`);
  }

  clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  readSessionCookie(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return this.verifyCookie(rest.join('='));
    }
    return null;
  }

  /** Resolve the signed-in user for a request, or null. */
  authenticate(req) {
    const sid = this.readSessionCookie(req);
    const session = this.getSession(sid);
    if (!session) return null;
    return { ...session.user, sid };
  }

  _sweep() {
    const now = Date.now();
    for (const [sid, s] of this.sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) this.sessions.delete(sid);
    }
    for (const [state, s] of this.states) {
      if (now - s.createdAt > STATE_TTL_MS) this.states.delete(state);
    }
  }

  dispose() {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this.sessions.clear();
    this.states.clear();
  }
}

function httpsJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); }
        catch (e) { reject(new Error(`Unexpected response from GitHub (HTTP ${res.statusCode})`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('GitHub request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

module.exports = WebAuth;
module.exports.SESSION_COOKIE = SESSION_COOKIE;
module.exports.SESSION_TTL_MS = SESSION_TTL_MS;
