// tests/test-web-network.js
//
// A rede de sincronismo no painel web precisa das mesmas garantias do desktop:
// escopos por acao, autorizacao de dispositivo presa a sessao GitHub e nada de
// 500 quando o daemon nao existe.
//
// O ponto sensivel e o ultimo do primeiro paragrafo: autorizar dispositivo por
// um id que veio no corpo da requisicao reabriria exatamente o bypass que a
// camada de autorizacao existe para fechar. Aqui a identidade vem da sessao que
// o webAuth validou contra a API do GitHub.

const { expect } = require('chai');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ApiServer = require('../src/main/apiServer');
const ConfigManager = require('../src/main/configManager');
const security = require('../src/main/webSecurity');

const DEVICE_OK = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
const DEVICE_NB = 'IIIIIII-JJJJJJJ-KKKKKKK-LLLLLLL-MMMMMMM-NNNNNNN-OOOOOOO-PPPPPPP';

function fakeNetwork() {
  return {
    status: async () => ({ installed: true, running: true, deviceID: 'LOCAL' }),
    overview: async () => ({ ok: true, deviceID: 'LOCAL', listeners: { ok: 3, total: 3 } }),
    folders: async () => ({ ok: true, folders: [{ id: 'docs', label: 'Docs', type: 'sendreceive', authorized: true }] }),
    saveFolder: async (folder) => ((folder.devices || []).some((d) => d.deviceID === DEVICE_NB)
      ? { ok: false, error: 'network.deviceNotAuthorized', blocked: [DEVICE_NB] }
      : { ok: true, folder }),
    deleteFolder: async () => ({ ok: true }),
    ignores: async () => ({ ok: true, ignores: ['*.tmp'] }),
    saveIgnores: async () => ({ ok: true }),
    devices: async () => ({ ok: true, devices: [{ deviceID: DEVICE_OK, authorized: true, githubLogin: 'l1nds0n' }] }),
    authorizeDevice: async (payload, actor) => {
      if (!actor) return { ok: false, reason: 'network.loginRequired' };
      if (actor.githubId !== payload.githubId) return { ok: false, reason: 'deviceAuth.loginMismatch' };
      return { ok: true, entry: { deviceID: payload.deviceID, githubId: actor.githubId, githubLogin: actor.githubLogin } };
    },
    revokeDevice: async () => ({ ok: true }),
    listInstances: () => [{ Id: 'default', Name: 'Local' }],
    createInstance: async (name) => (name ? { ok: true, instance: { Id: 'hd', Name: name } } : { ok: false, error: 'network.instanceNeedsName' }),
    removeInstance: async (id) => (id === 'default' ? { ok: false, error: 'network.cannotRemoveDefault' } : { ok: true }),
    start: async () => ({ success: true }),
    stop: async () => ({ success: true }),
    install: async () => ({ success: true }),
  };
}

function recordingLogger() {
  const audits = [];
  return { audits, log: () => {}, error: () => {}, info: () => {}, audit: (action, details) => audits.push({ action, details }) };
}

function build(syncNetwork) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-webnet-'));
  dirs.push(dir);
  const config = new ConfigManager(path.join(dir, 'config'), 'default');
  const server = new ApiServer({ getAllTasks: () => [] }, config, recordingLogger(), null, null, null, {
    runRegistry: { active: () => [], detail: () => null },
    cronParser: null,
    syncNetwork,
  });
  return server;
}

const dirs = [];

describe('API web de rede', () => {
  let server;
  let port;
  let cookies;
  let csrf;
  const logger = recordingLogger();

  const request = (routePath, options = {}) => new Promise((resolve) => {
    const headers = Object.assign({}, options.headers);
    const login = options.login || 'boss';
    if (options.auth !== false && cookies[login]) headers.cookie = cookies[login];
    if (options.auth !== false && csrf[login] && options.method && options.method !== 'GET'
        && !('X-CSRF-Token' in headers)) headers['X-CSRF-Token'] = csrf[login];
    if (options.body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const req = http.request({ host: '127.0.0.1', port, path: routePath, method: options.method || 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) {}
        resolve({ status: res.statusCode, body, json, headers: res.headers });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message, json: null }));
    if (options.body) req.write(options.body);
    req.end();
  });

  const signIn = () => {
    cookies = {}; csrf = {};
    for (const login of ['boss', 'reader']) {
      const sid = server.auth.createSession({ login, id: login === 'boss' ? 4242 : 7, name: login }, '127.0.0.1');
      cookies[login] = `kyrios_sid=${server.auth.signCookie(sid)}`;
      csrf[login] = security.csrfToken(server.auth.secret, sid);
    }
  };

  beforeEach(async () => {
    server = build(fakeNetwork());
    // A allowlist e as permissoes por usuario vivem na config; sem elas nenhuma
    // sessao e aceita e toda rota responde 401 antes de chegar no escopo.
    server.config.setSetting('WebAllowedUsers', ['boss', 'reader']);
    server.config.setSetting('WebUserPermissions', { boss: ['*'], reader: ['network:view'] });
    port = (await server.start(0)).port;
    signIn();
  });

  afterEach(async () => {
    if (server) await server.stop();
    for (const dir of dirs.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  });

  it('devolve o estado do daemon e o painel de metricas', async () => {
    const status = await request('/api/network/status');
    expect(status.status).to.equal(200);
    expect(status.json.success).to.equal(true);

    const overview = await request('/api/network/overview');
    expect(overview.json.data.listeners).to.deep.equal({ ok: 3, total: 3 });
  });

  it('lista pastas, dispositivos e instancias', async () => {
    expect((await request('/api/network/folders')).json.data).to.have.length(1);
    expect((await request('/api/network/devices')).json.data[0].deviceID).to.equal(DEVICE_OK);
    expect((await request('/api/network/instances')).json.data[0].Id).to.equal('default');
  });

  it('lê e grava os filtros de exclusão da pasta', async () => {
    const read = await request('/api/network/folders/docs/ignores');
    expect(read.json.data).to.deep.equal(['*.tmp']);
    const saved = await request('/api/network/folders/docs/ignores', { method: 'PUT', body: JSON.stringify({ ignore: ['*.log'] }) });
    expect(saved.status).to.equal(200);
  });

  it('recusa salvar uma pasta compartilhada com dispositivo nao autorizado, com 400 e nao 500', async () => {
    const res = await request('/api/network/folders/docs', {
      method: 'PUT',
      body: JSON.stringify({ path: 'C:\\docs', type: 'sendreceive', devices: [{ deviceID: DEVICE_NB }] }),
    });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal('network.deviceNotAuthorized');
    expect(res.json.blocked).to.deep.equal([DEVICE_NB]);
  });

  it('recusa autorizar sem sessao GitHub, mesmo com um id no corpo', async () => {
    const res = await request(`/api/network/devices/${DEVICE_NB}/authorize`, {
      method: 'POST', auth: false, body: JSON.stringify({ githubId: 999 }),
    });
    expect([401, 403]).to.include(res.status);
  });

  it('ignora o githubId do corpo e usa o da sessao', async () => {
    const res = await request(`/api/network/devices/${DEVICE_NB}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ githubId: 999, githubLogin: 'outro' }),
    });
    // O corpo nao substitui a identidade: a sessao e do boss (4242) e a
    // entrada sai com 4242, nao com o 999 que veio no corpo.
    expect(res.status).to.equal(200);
    expect(res.json.data.githubId).to.equal(4242);
    expect(res.json.data.githubLogin).to.equal('boss');
  });

  it('libera um dispositivo para a propria conta da sessao', async () => {
    const res = await request(`/api/network/devices/${DEVICE_NB}/authorize`, {
      method: 'POST',
      body: JSON.stringify({ githubId: 4242, githubLogin: 'boss' }),
    });
    expect(res.status).to.equal(200);
    expect(res.json.data.githubId).to.equal(4242);
  });

  it('deixa em auditoria quem liberou o dispositivo', async () => {
    await request(`/api/network/devices/${DEVICE_NB}/authorize`, {
      method: 'POST', body: JSON.stringify({ githubId: 4242, githubLogin: 'boss' }),
    });
    const entry = server.logger.audits.find((a) => a.action === 'WEB_SYNC_DEVICE_AUTHORIZED');
    expect(entry).to.not.equal(undefined);
    expect(entry.details.actor).to.contain('boss');
    expect(entry.details.targetId).to.equal(DEVICE_NB);
  });

  it('recusa escrita para quem só pode ler a tela', async () => {
    const res = await request(`/api/network/folders/docs`, {
      method: 'PUT', login: 'reader', body: JSON.stringify({ path: 'C:\\docs' }),
    });
    expect(res.status).to.equal(403);
  });

  it('recusa rodar o daemon para quem só pode ler', async () => {
    const res = await request('/api/network/daemon/start', { method: 'POST', login: 'reader', body: '{}' });
    expect(res.status).to.equal(403);
  });

  it('recusa uma acao de daemon desconhecida em vez de executar qualquer coisa', async () => {
    const res = await request('/api/network/daemon/reboot', { method: 'POST', body: '{}' });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal('network.unknownAction');
  });

  it('recusa remover a instancia principal', async () => {
    const res = await request('/api/network/instances/default', { method: 'DELETE' });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.equal('network.cannotRemoveDefault');
  });

  it('responde 503 em tudo quando a rede nao foi injetada, e o resto continua de pe', async () => {
    await server.stop();
    server = build(null);
    server.config.setSetting('WebAllowedUsers', ['boss', 'reader']);
    server.config.setSetting('WebUserPermissions', { boss: ['*'], reader: ['network:view'] });
    port = (await server.start(0)).port;
    // As sessao vivem no webAuth do servidor: um sid do servidor anterior nao
    // existe no novo, e o 401 disfarçaria o 503 que o teste quer ver.
    signIn();
    expect((await request('/api/network/status')).status).to.equal(503);
    expect((await request('/api/network/folders')).status).to.equal(503);
    // Uma rota que nao depende da rede: o painel continua de pe.
    expect((await request('/api/me')).status).to.equal(200);
  });
});
