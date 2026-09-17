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

const SESSION_COOKIE = 'kyrios_sid';
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

  get clientId() { return (this.config.getSetting('GithubClientId', '') || '').trim(); }
  get clientSecret() { return (this.config.getSetting('GithubClientSecret', '') || '').trim(); }

  /** Logins allowed in, lower-cased. Empty means nobody. */
  get allowedUsers() {
    const raw = this.config.getSetting('WebAllowedUsers', []);
    const list = Array.isArray(raw)
      ? raw
      : String(raw || '').split(/[\s,;]+/);
    return list.map(u => String(u || '').trim().toLowerCase()).filter(Boolean);
  }

  /** True once GitHub sign-in can actually be performed. */
  isConfigured() {
    return !!(this.clientId && this.clientSecret);
  }

  /**
   * Why sign-in is unavailable, or null when it is ready.
   * Surfaced on the login page so an operator is never left guessing.
   */
  configurationProblem() {
    if (!this.clientId || !this.clientSecret) {
      return 'GitHub sign-in is not configured yet. In the desktop app open Settings > Web Interface and enter the Client ID and Client Secret of a GitHub OAuth App.';
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

  setSessionCookie(res, sid) {
    res.setHeader('Set-Cookie',
      `${SESSION_COOKIE}=${this.signCookie(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  }

  clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
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
