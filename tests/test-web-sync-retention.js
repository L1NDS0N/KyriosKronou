// tests/test-web-sync-retention.js
//
// Sincronismo e retenção existiam no desktop e não existiam no painel: as telas
// sync e retention já estavam no catálogo de permissões (webPermissions.js) sem
// uma única rota atrás. Estes testes sobem o ApiServer de verdade e exercitam
// cada rota nova por HTTP, autenticado, com escopo real - incluindo o que uma
// conta de leitura não pode fazer, o que o servidor responde quando o manager
// não foi injetado, e a regra de que senha de destino não sai por aqui.

const { expect } = require('chai');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ApiServer = require('../src/main/apiServer');
const ConfigManager = require('../src/main/configManager');
const CronParser = require('../src/main/cronParser');
const TaskManager = require('../src/main/taskManager');
const BackupManager = require('../src/main/backupManager');
const SyncManager = require('../src/main/sync/syncManager');
const RetentionManager = require('../src/main/retentionManager');
const RunRegistry = require('../src/main/runRegistry');
const WebPermissions = require('../src/main/webPermissions');
const security = require('../src/main/webSecurity');

const SENHA = 'senha-nunca-sai-4d3a';

function tempConfig(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kyrios-websync-${label}-`));
  return { dir, config: new ConfigManager(path.join(dir, 'config'), 'default') };
}

/** Logger de mentira que guarda a auditoria, para dar para conferir quem agiu. */
function recordingLogger() {
  const audits = [];
  return {
    audits,
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    audit: (action, details) => audits.push({ action, details }),
    getRecentLogs: () => [],
    getRecentLogsFromDisk: () => [],
  };
}

/** Snapshot .7z com data no nome e no mtime, como o motor de retenção espera. */
function snapshot(dir, rel, isoDate) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, `conteudo de ${rel}`);
  if (isoDate) {
    const when = new Date(isoDate);
    fs.utimesSync(full, when, when);
  }
  return full;
}

// Data relativa a hoje, para o arquivo "recente" destes testes não envelhecer
// junto com o calendário. Com data fixa, um '2026-09-24' visto de 2026-10-01
// tem mais de 7 dias e a retenção o apaga: o teste passa a falhar sozinho,
// culpando código que está certo.
function diasAtras(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ─── O registro das rotas ───

describe('API web de sync e retention: as rotas ficam registradas com escopo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'apiServer.js'), 'utf8');

  const PROTEGIDAS = [
    ["get", "/api/sync", "sync:view"],
    ["get", "/api/sync/engines", "sync:view"],
    ["post", "/api/sync/analyze", "sync:view"],
    ["post", "/api/sync/plan", "sync:view"],
    ["post", "/api/sync/retention/preview", "sync:view"],
    ["post", "/api/sync/test-connection", "sync:view"],
    ["get", "/api/sync/:id", "sync:view"],
    ["post", "/api/sync", "sync:write"],
    ["put", "/api/sync/:id", "sync:write"],
    ["post", "/api/sync/:id/run", "sync:run"],
    ["delete", "/api/sync/:id", "sync:delete"],
    ["get", "/api/retention", "retention:view"],
    ["get", "/api/retention/:id", "retention:view"],
    ["post", "/api/retention", "retention:write"],
    ["put", "/api/retention/:id", "retention:write"],
    ["post", "/api/retention/:id/run", "retention:run"],
    ["delete", "/api/retention/:id", "retention:delete"],
  ];

  it('protege cada rota nova com o escopo da tela, e não só com a sessão', () => {
    for (const [metodo, rota, escopo] of PROTEGIDAS) {
      expect(src, `${metodo.toUpperCase()} ${rota} perdeu a proteção de escopo`)
        .to.include(`this.app.${metodo}('${rota}', this._need('${escopo}')`);
    }
  });

  it('só usa escopo do catálogo, para um erro de digitação não virar recusa silenciosa', () => {
    const usados = [...src.matchAll(/this\._need\('([^']+)'\)/g)].map(m => m[1]);
    expect(usados.length, 'quase nenhuma rota protegida: a proteção sumiu').to.be.above(40);
    for (const escopo of usados) expect(WebPermissions.isValidScope(escopo), `${escopo} não está no catálogo`).to.equal(true);
  });

  // Ordem de registro: '/api/sync/engines' depois de '/api/sync/:id' seria lido
  // como um perfil chamado "engines".
  it('registra as rotas literais de sync antes da rota com :id', () => {
    const literais = ["/api/sync/engines", "/api/sync/analyze", "/api/sync/plan", "/api/sync/retention/preview", "/api/sync/test-connection"];
    for (const rota of literais) {
      expect(src.indexOf(`'${rota}'`), `${rota} não existe`).to.be.above(0);
      expect(src.indexOf(`'${rota}'`), `${rota} precisa vir antes de /api/sync/:id`)
        .to.be.below(src.indexOf(`this.app.get('/api/sync/:id'`));
    }
  });

  it('a GUI e o serviço passam os dois managers para o ApiServer', () => {
    for (const arquivo of ['main.js', 'serviceScheduler.js']) {
      const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', arquivo), 'utf8');
      const inicio = fonte.indexOf('new ApiServer(');
      const bloco = fonte.slice(inicio, inicio + 400);
      expect(/syncManager/.test(bloco), `${arquivo} não passa syncManager para o ApiServer`).to.equal(true);
      expect(/retentionManager/.test(bloco), `${arquivo} não passa retentionManager para o ApiServer`).to.equal(true);
    }
  });
});

// ─── Sync, no servidor de verdade ───

describe('API web de sync: CRUD, execução e leitura', function () {
  this.timeout(30000);

  let server, config, port, runs, syncManager, retentionManager, cookies, csrf, logger;
  let source, dest, temp;

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

  const criar = (extra = {}) => request('/api/sync', {
    method: 'POST',
    body: JSON.stringify(Object.assign({
      Name: 'Backup de pasta', SourcePath: source, DestPath: dest, Engine: 'local',
      CronExpression: '0 3 * * *', Host: 'srv', Port: 445, User: 'admin', Password: SENHA,
    }, extra)),
  });

  const audits = (action) => logger.audits.filter((a) => a.action === action);

  before(async () => {
    const feito = tempConfig('sync');
    temp = feito.dir;
    config = feito.config;
    logger = recordingLogger();
    const cronParser = new CronParser();
    runs = new RunRegistry();
    const taskManager = new TaskManager(config, logger, cronParser, runs);
    const backupManager = new BackupManager(config, logger, runs);
    syncManager = new SyncManager(config, logger, runs);
    retentionManager = new RetentionManager({
      syncManager, cronParser, logger, configDir: path.join(temp, 'config'),
    });

    source = path.join(temp, 'origem');
    dest = path.join(temp, 'destino');
    snapshot(source, '2026-09-20/db.7z', '2026-09-20T10:00:00Z');
    snapshot(source, '2026-09-21/db.7z', '2026-09-21T10:00:00Z');

    config.setSetting('WebAllowedUsers', ['boss', 'reader']);
    config.setSetting('WebUserPermissions', { boss: ['*'], reader: ['sync:view', 'retention:view'] });

    server = new ApiServer(taskManager, config, logger, null, null, backupManager, {
      runRegistry: runs, cronParser, syncManager, retentionManager,
    });
    port = (await server.start(7747)).port;

    cookies = {}; csrf = {};
    for (const login of ['boss', 'reader']) {
      const sid = server.auth.createSession({ login, id: 1, name: login }, '127.0.0.1');
      cookies[login] = 'kyrios_sid=' + server.auth.signCookie(sid);
      csrf[login] = security.csrfToken(server.auth.secret, sid);
    }
  });

  after(async () => {
    if (server) await server.stop();
    if (runs) runs.dispose();
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
  });

  it('lista os perfis com o envelope que o resto da API usa', async () => {
    const vazia = await request('/api/sync');
    expect(vazia.status).to.equal(200);
    expect(vazia.json).to.include({ success: true, count: 0 });

    await criar();
    const lista = await request('/api/sync');
    expect(lista.json.success).to.equal(true);
    expect(lista.json.count).to.equal(1);
    expect(lista.json.data[0].Name).to.equal('Backup de pasta');
    expect(lista.json.data[0].Retention, 'a política entra normalizada').to.have.property('FileExtensions');
  });

  it('cria com escopo de escrita, devolve 201 e {success}', async () => {
    const res = await criar({ Name: 'Diário' });
    expect(res.status).to.equal(201);
    expect(res.json.success).to.equal(true);
    expect(res.json.data.Name).to.equal('Diário');
    expect(syncManager.getProfile(res.json.data.Id).Name).to.equal('Diário');
  });

  it('recusa criar sem nome, e não grava nada', async () => {
    const antes = syncManager.getAllProfiles().length;
    const res = await request('/api/sync', { method: 'POST', body: JSON.stringify({ SourcePath: source }) });
    expect(res.status).to.equal(400);
    expect(syncManager.getAllProfiles()).to.have.length(antes);
  });

  it('lê um perfil pelo id e responde 404 para o que não existe', async () => {
    const criado = await criar({ Name: 'Leitura' });
    const id = criado.json.data.Id;

    const res = await request('/api/sync/' + id);
    expect(res.status).to.equal(200);
    expect(res.json.data.Id).to.equal(id);

    const inexistente = await request('/api/sync/nao-existe');
    expect(inexistente.status).to.equal(404);
  });

  // A senha do destino é credencial de SMB/FTP/SFTP: ela é gravada, usada e
  // nunca devolvida - nem na listagem, nem no detalhe, nem no erro.
  it('nunca devolve a senha do destino, em nenhuma resposta', async () => {
    const criado = await criar({ Name: 'Com senha', Password: SENHA });
    const id = criado.json.data.Id;

    for (const res of [criado, await request('/api/sync'), await request('/api/sync/' + id)]) {
      expect(res.body, 'a senha vazou no corpo da resposta').to.not.include(SENHA);
      expect(JSON.stringify(res.json)).to.not.include(SENHA);
    }
    expect(Object.keys(criado.json.data)).to.not.include('Password');
    expect(syncManager.getProfile(id).Password, 'mas ela continua gravada').to.equal(SENHA);
  });

  it('um corpo sem Password no PUT significa "não mexa na senha"', async () => {
    const criado = await criar({ Name: 'Editando', Password: SENHA });
    const id = criado.json.data.Id;

    const res = await request('/api/sync/' + id, {
      method: 'PUT', body: JSON.stringify({ Name: 'Editado', Password: '' }),
    });
    expect(res.status).to.equal(200);
    expect(res.json.success).to.equal(true);
    expect(res.json.data.Name).to.equal('Editado');
    expect(res.body).to.not.include(SENHA);
    expect(syncManager.getProfile(id).Password, 'a senha não pode ser apagada pelo painel').to.equal(SENHA);

    // null é o que um formulário vazio costuma mandar: também é "não mexa".
    await request('/api/sync/' + id, { method: 'PUT', body: JSON.stringify({ Password: null }) });
    expect(syncManager.getProfile(id).Password).to.equal(SENHA);

    const trocada = await request('/api/sync/' + id, {
      method: 'PUT', body: JSON.stringify({ Password: 'outra-senha-9f2' }),
    });
    expect(trocada.status).to.equal(200);
    expect(syncManager.getProfile(id).Password).to.equal('outra-senha-9f2');
  });

  it('devolve 404 ao editar ou apagar o que não existe', async () => {
    const put = await request('/api/sync/nao-existe', { method: 'PUT', body: JSON.stringify({ Name: 'X' }) });
    expect(put.status).to.equal(404);
    const del = await request('/api/sync/nao-existe', { method: 'DELETE' });
    expect(del.status).to.equal(404);
  });

  it('apaga o perfil e some da lista', async () => {
    const criado = await criar({ Name: 'Descartável' });
    const id = criado.json.data.Id;

    const res = await request('/api/sync/' + id, { method: 'DELETE' });
    expect(res.status).to.equal(200);
    expect(res.json.success).to.equal(true);
    expect(syncManager.getProfile(id)).to.equal(null);
    expect((await request('/api/sync/' + id)).status).to.equal(404);
  });

  it('executa o perfil, copia de verdade e devolve {success}', async () => {
    const criado = await criar({ Name: 'Rodando', DestPath: path.join(temp, 'run-destino') });
    const res = await request('/api/sync/' + criado.json.data.Id + '/run', { method: 'POST' });

    expect(res.status).to.equal(200);
    expect(res.json.success).to.equal(true);
    expect(res.json.data.success).to.equal(true);
    expect(fs.existsSync(path.join(temp, 'run-destino', '2026-09-20', 'db.7z'))).to.equal(true);
    expect(syncManager.getProfile(criado.json.data.Id).LastStatus).to.equal('Success');
  });

  it('devolve 404 ao executar o que não existe', async () => {
    const res = await request('/api/sync/nao-existe/run', { method: 'POST' });
    expect(res.status).to.equal(404);
  });

  it('lista os motores de destino, e "engines" não vira id de perfil', async () => {
    const res = await request('/api/sync/engines');
    expect(res.status).to.equal(200);
    expect(res.json.data.map((e) => e.id)).to.deep.equal(['local', 'smb', 'ftp', 'sftp']);
  });

  it('analisa a pasta de origem, somente leitura', async () => {
    const res = await request('/api/sync/analyze', {
      method: 'POST', body: JSON.stringify({ dir: source, extensions: ['.7z'] }),
    });
    expect(res.status).to.equal(200);
    expect(res.json.data.ok).to.equal(true);
    expect(res.json.data.totalFiles).to.be.above(0);
  });

  it('devolve o erro da análise sem quebrar quando a pasta não existe', async () => {
    const res = await request('/api/sync/analyze', {
      method: 'POST', body: JSON.stringify({ dir: path.join(temp, 'nao-existe') }),
    });
    expect(res.status).to.equal(200);
    expect(res.json.data.ok).to.equal(false);
  });

  it('simula o plano sem executar nada', async () => {
    const destino = path.join(temp, 'plan-destino');
    const res = await request('/api/sync/plan', {
      method: 'POST',
      body: JSON.stringify({ SourcePath: source, DestPath: destino, Engine: 'local', Mode: 'incremental', Mirror: true }),
    });
    expect(res.status).to.equal(200);
    expect(res.json.data.ok).to.equal(true);
    expect(res.json.data.copy.length).to.equal(2);
    expect(fs.existsSync(destino), 'simular não pode criar o destino').to.equal(false);
  });

  it('simula a partir de um perfil salvo, sem exigir o rascunho inteiro', async () => {
    const criado = await criar({ Name: 'Base do plano', DestPath: path.join(temp, 'plan2-destino'), Password: SENHA });
    const res = await request('/api/sync/plan', {
      method: 'POST', body: JSON.stringify({ profileId: criado.json.data.Id }),
    });
    expect(res.status).to.equal(200);
    expect(res.json.data.copy.length).to.equal(2);
    expect(res.body, 'a senha usada na simulação não volta na resposta').to.not.include(SENHA);

    const inexistente = await request('/api/sync/plan', { method: 'POST', body: JSON.stringify({ profileId: 'nao-existe' }) });
    expect(inexistente.status).to.equal(404);
  });

  it('previsualiza a retenção do destino sem apagar nada', async () => {
    const destino = path.join(temp, 'preview-destino');
    const velho = snapshot(destino, 'daily/2020-01-01/db.7z', '2020-01-01T10:00:00Z');
    const recente = snapshot(destino, `daily/${diasAtras(1)}/db.7z`, `${diasAtras(1)}T10:00:00Z`);

    const res = await request('/api/sync/retention/preview', {
      method: 'POST',
      body: JSON.stringify({
        dir: destino,
        Retention: { Enabled: true, ByAge: true, KeepDays: 7, MinKeep: 0, FileExtensions: ['.7z'] },
      }),
    });
    expect(res.status).to.equal(200);
    expect(res.json.data.ok).to.equal(true);
    expect(res.json.data.delete.map((d) => d.rel)).to.deep.equal(['daily/2020-01-01/db.7z']);
    expect(fs.existsSync(velho), 'previsualizar não apaga').to.equal(true);
    expect(fs.existsSync(recente)).to.equal(true);
  });

  it('testa a conexão com o motor, sem devolver a senha', async () => {
    const res = await request('/api/sync/test-connection', {
      method: 'POST',
      body: JSON.stringify({ Engine: 'local', DestPath: path.join(temp, 'conexao') }),
    });
    expect(res.status).to.equal(200);
    expect(res.json.data.success).to.equal(true);
    expect(res.body).to.not.include(SENHA);

    // Por id: herda motor e destino do perfil salvo, e o que veio no corpo vence.
    const criado = await criar({ Name: 'Testado', DestPath: path.join(temp, 'conexao-do-perfil') });
    const porId = await request('/api/sync/test-connection', {
      method: 'POST', body: JSON.stringify({ profileId: criado.json.data.Id }),
    });
    expect(porId.status).to.equal(200);
    expect(porId.json.data.success).to.equal(true);
    expect(porId.body).to.not.include(SENHA);

    const inexistente = await request('/api/sync/test-connection', {
      method: 'POST', body: JSON.stringify({ profileId: 'nao-existe' }),
    });
    expect(inexistente.status).to.equal(404);
  });

  // Quem só lê a tela não executa, não edita e não apaga: a recusa tem de vir
  // antes de qualquer efeito no disco.
  it('recusa escrita, execução e apagar para quem só pode ler a tela', async () => {
    const criado = await criar({ Name: 'Protegido' });
    const id = criado.json.data.Id;
    const antes = syncManager.getAllProfiles().length;

    const chamadas = [
      { path: '/api/sync', method: 'POST', required: 'sync:write', body: JSON.stringify({ Name: 'Invadido' }) },
      { path: '/api/sync/' + id, method: 'PUT', required: 'sync:write', body: JSON.stringify({ Name: 'Invadido' }) },
      { path: '/api/sync/' + id + '/run', method: 'POST', required: 'sync:run' },
      { path: '/api/sync/' + id, method: 'DELETE', required: 'sync:delete' },
    ];
    for (const call of chamadas) {
      const res = await request(call.path, { method: call.method, body: call.body, login: 'reader' });
      expect(res.status, `${call.method} ${call.path}`).to.equal(403);
      expect(res.json.required, `${call.method} ${call.path}`).to.equal(call.required);
    }
    expect(syncManager.getProfile(id), 'o perfil continua lá').to.not.equal(null);
    expect(syncManager.getAllProfiles()).to.have.length(antes);
  });

  it('recusa a tela de sync para quem só pode ler outra coisa', async () => {
    const res = await request('/api/sync', { login: 'reader' });
    expect(res.status).to.equal(200, 'reader tem sync:view');

    config.setSetting('WebUserPermissions', { boss: ['*'], reader: ['retention:view'] });
    const recusa = await request('/api/sync', { login: 'reader' });
    expect(recusa.status).to.equal(403);
    expect(recusa.json.required).to.equal('sync:view');
    config.setSetting('WebUserPermissions', { boss: ['*'], reader: ['sync:view', 'retention:view'] });
  });

  it('sem sessão a resposta é 401, não 403', async () => {
    const res = await request('/api/sync', { auth: false });
    expect(res.status).to.equal(401);
  });

  // Quem apaga arquivo tem de poder dizer quem foi: cada escrita do painel leva
  // autor e IP para a auditoria.
  it('deixa toda escrita no log de auditoria, com autor e IP', async () => {
    const criado = await criar({ Name: 'Auditado' });
    const id = criado.json.data.Id;
    await request('/api/sync/' + id, { method: 'PUT', body: JSON.stringify({ Description: 'olha só' }) });
    await request('/api/sync/' + id + '/run', { method: 'POST' });
    await request('/api/sync/' + id, { method: 'DELETE' });

    for (const action of ['SYNC_PROFILE_CREATED_WEB', 'SYNC_PROFILE_UPDATED_WEB', 'SYNC_EXECUTED_WEB', 'SYNC_PROFILE_DELETED_WEB']) {
      const registros = audits(action);
      expect(registros, `${action} não foi auditado`).to.have.length.above(0);
      expect(registros[0].details.actor, `${action} sem autor`).to.include('boss');
      expect(registros[0].details.via).to.equal('web');
      expect(registros[0].details.ip).to.be.a('string');
    }
    expect(JSON.stringify(logger.audits), 'a senha não pode ir para a auditoria').to.not.include(SENHA);
  });
});

// ─── Retention, no servidor de verdade ───

describe('API web de retention: agenda de limpeza', function () {
  this.timeout(30000);

  let server, config, port, runs, syncManager, retentionManager, cookies, csrf, logger, pasta, temp;

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

  const politica = (extra = {}) => Object.assign({
    Enabled: true, ByAge: true, KeepDays: 7, MinKeep: 0, FileExtensions: ['.7z'],
  }, extra);

  const criar = (extra = {}) => request('/api/retention', {
    method: 'POST',
    body: JSON.stringify(Object.assign({ Name: 'Limpeza', FolderPath: pasta, CronExpression: '0 2 * * *', Retention: politica() }, extra)),
  });

  before(async () => {
    const feito = tempConfig('retention');
    temp = feito.dir;
    config = feito.config;
    logger = recordingLogger();
    const cronParser = new CronParser();
    runs = new RunRegistry();
    const taskManager = new TaskManager(config, logger, cronParser, runs);
    const backupManager = new BackupManager(config, logger, runs);
    syncManager = new SyncManager(config, logger, runs);
    retentionManager = new RetentionManager({
      syncManager, cronParser, logger, configDir: path.join(temp, 'config'),
    });

    pasta = path.join(temp, 'arquivo');
    fs.mkdirSync(pasta, { recursive: true });

    config.setSetting('WebAllowedUsers', ['boss', 'reader']);
    config.setSetting('WebUserPermissions', { boss: ['*'], reader: ['retention:view'] });

    server = new ApiServer(taskManager, config, logger, null, null, backupManager, {
      runRegistry: runs, cronParser, syncManager, retentionManager,
    });
    port = (await server.start(7748)).port;

    cookies = {}; csrf = {};
    for (const login of ['boss', 'reader']) {
      const sid = server.auth.createSession({ login, id: 1, name: login }, '127.0.0.1');
      cookies[login] = 'kyrios_sid=' + server.auth.signCookie(sid);
      csrf[login] = security.csrfToken(server.auth.secret, sid);
    }
  });

  after(async () => {
    if (server) await server.stop();
    if (runs) runs.dispose();
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
  });

  it('cria a agenda com escopo de escrita e devolve 201 e {success}', async () => {
    const res = await criar();
    expect(res.status).to.equal(201);
    expect(res.json.success).to.equal(true);
    expect(res.json.data.Id).to.match(RetentionManager.UUID_RE);
    expect(res.json.data.Retention.ByAge).to.equal(true);
    expect(retentionManager.getProfile(res.json.data.Id)).to.not.equal(null);
  });

  it('devolve 400, e não 500, para uma pasta que não existe', async () => {
    const antes = retentionManager.getAllProfiles().length;
    const res = await criar({ FolderPath: path.join(temp, 'nao-existe'), Name: 'Pasta errada' });
    expect(res.status).to.equal(400);
    expect(res.json.error).to.be.a('string');
    expect(retentionManager.getAllProfiles()).to.have.length(antes);
  });

  it('devolve 400 para uma política impossível', async () => {
    const res = await criar({ Name: 'Sem regra', Retention: { Enabled: true } });
    expect(res.status).to.equal(400);
  });

  it('lista e lê por id, e 404 para o que não existe', async () => {
    const criado = await criar({ Name: 'Consultável' });
    const id = criado.json.data.Id;

    const lista = await request('/api/retention');
    expect(lista.status).to.equal(200);
    expect(lista.json.success).to.equal(true);
    expect(lista.json.data.some((p) => p.Id === id)).to.equal(true);

    const um = await request('/api/retention/' + id);
    expect(um.json.data.Name).to.equal('Consultável');
    expect((await request('/api/retention/nao-existe')).status).to.equal(404);
  });

  it('edita mantendo a última execução, e devolve 404 no que não existe', async () => {
    const criado = await criar({ Name: 'Antigo' });
    const id = criado.json.data.Id;

    const res = await request('/api/retention/' + id, { method: 'PUT', body: JSON.stringify({ Name: 'Renomeado' }) });
    expect(res.status).to.equal(200);
    expect(res.json.success).to.equal(true);
    expect(res.json.data.Name).to.equal('Renomeado');
    expect(retentionManager.getProfile(id).CronExpression, 'o que não foi mandado continua').to.equal('0 2 * * *');

    const nada = await request('/api/retention/nao-existe', { method: 'PUT', body: JSON.stringify({ Name: 'X' }) });
    expect(nada.status).to.equal(404);
  });

  // Este é o botão que apaga arquivo de verdade: mesmo peso do sync, mesmo
  // 'run', e um registro de auditoria com quem mandou.
  it('executa a agenda, apaga o que envelheceu e devolve {success}', async () => {
    const alvo = path.join(temp, 'execucao');
    fs.mkdirSync(alvo, { recursive: true });
    const velho = snapshot(alvo, '2020-01-01/db.7z', '2020-01-01T10:00:00Z');
    const novo = snapshot(alvo, `${diasAtras(1)}/db.7z`, `${diasAtras(1)}T10:00:00Z`);

    const criado = await criar({ Name: 'Executada', FolderPath: alvo });
    const res = await request('/api/retention/' + criado.json.data.Id + '/run', { method: 'POST' });

    expect(res.status).to.equal(200);
    expect(res.json.success).to.equal(true);
    expect(res.json.data.ok).to.equal(true);
    expect(res.json.data.deleted).to.equal(1);
    expect(fs.existsSync(velho), 'o arquivo velho tem de ter saído').to.equal(false);
    expect(fs.existsSync(novo), 'o recente fica').to.equal(true);
    expect(retentionManager.getProfile(criado.json.data.Id).LastStatus).to.equal('Success');

    const auditoria = logger.audits.filter((a) => a.action === 'RETENTION_EXECUTED_WEB');
    expect(auditoria).to.have.length.above(0);
    expect(auditoria[0].details.actor).to.include('boss');
    expect(auditoria[0].details.after.deleted).to.equal(1);
  });

  it('devolve 404 ao executar o que não existe', async () => {
    const res = await request('/api/retention/nao-existe/run', { method: 'POST' });
    expect(res.status).to.equal(404);
  });

  it('apaga a agenda e some da lista', async () => {
    const criado = await criar({ Name: 'Descartável' });
    const id = criado.json.data.Id;

    const res = await request('/api/retention/' + id, { method: 'DELETE' });
    expect(res.status).to.equal(200);
    expect(res.json.success).to.equal(true);
    expect(retentionManager.getProfile(id)).to.equal(null);
    expect((await request('/api/retention/' + id)).status).to.equal(404);
  });

  it('recusa escrita, execução e apagar para quem só pode ler a tela', async () => {
    const criado = await criar({ Name: 'Protegida' });
    const id = criado.json.data.Id;

    const chamadas = [
      { path: '/api/retention', method: 'POST', required: 'retention:write', body: JSON.stringify({ Name: 'Invadida', FolderPath: pasta, CronExpression: '0 2 * * *', Retention: politica() }) },
      { path: '/api/retention/' + id, method: 'PUT', required: 'retention:write', body: JSON.stringify({ Name: 'Invadida' }) },
      { path: '/api/retention/' + id + '/run', method: 'POST', required: 'retention:run' },
      { path: '/api/retention/' + id, method: 'DELETE', required: 'retention:delete' },
    ];
    for (const call of chamadas) {
      const res = await request(call.path, { method: call.method, body: call.body, login: 'reader' });
      expect(res.status, `${call.method} ${call.path}`).to.equal(403);
      expect(res.json.required, `${call.method} ${call.path}`).to.equal(call.required);
    }
    expect(retentionManager.getProfile(id), 'a agenda continua lá').to.not.equal(null);
  });

  it('deixa cada escrita no log de auditoria, com autor e IP', async () => {
    const criado = await criar({ Name: 'Auditada' });
    const id = criado.json.data.Id;
    await request('/api/retention/' + id, { method: 'PUT', body: JSON.stringify({ Description: 'olha só' }) });
    await request('/api/retention/' + id, { method: 'DELETE' });

    for (const action of ['RETENTION_PROFILE_CREATED_WEB', 'RETENTION_PROFILE_UPDATED_WEB', 'RETENTION_PROFILE_DELETED_WEB']) {
      const registros = logger.audits.filter((a) => a.action === action);
      expect(registros, `${action} não foi auditado`).to.have.length.above(0);
      expect(registros[0].details.actor).to.include('boss');
      expect(registros[0].details.via).to.equal('web');
    }
  });
});

// ─── Sem manager nenhum ───

describe('API web de sync e retention: sem manager injetado', function () {
  this.timeout(30000);

  let server, config, port, cookies, csrf, logger;

  const request = (routePath, options = {}) => new Promise((resolve) => {
    const headers = Object.assign({}, { cookie: cookies.boss, 'X-CSRF-Token': csrf.boss });
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
        resolve({ status: res.statusCode, body, json });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message, json: null }));
    if (options.body) req.write(options.body);
    req.end();
  });

  before(async () => {
    const feito = tempConfig('sem-manager');
    config = feito.config;
    logger = recordingLogger();
    const cronParser = new CronParser();
    const runs = new RunRegistry();
    const taskManager = new TaskManager(config, logger, cronParser, runs);
    const backupManager = new BackupManager(config, logger, runs);

    // Sem syncManager e sem retentionManager: é assim que o servidor fica se
    // alguém construir o ApiServer sem injetar os dois.
    server = new ApiServer(taskManager, config, logger, null, null, backupManager, {
      runRegistry: runs, cronParser,
    });
    port = (await server.start(7749)).port;
    config.setSetting('WebAllowedUsers', ['boss']);
    const sid = server.auth.createSession({ login: 'boss', id: 1, name: 'boss' }, '127.0.0.1');
    cookies = { boss: 'kyrios_sid=' + server.auth.signCookie(sid) };
    csrf = { boss: security.csrfToken(server.auth.secret, sid) };
  });

  after(async () => { if (server) await server.stop(); });

  it('responde 503 em toda rota de sync, e não derruba o servidor', async () => {
    const rotas = [
      ['/api/sync', 'GET'],
      ['/api/sync/engines', 'GET'],
      ['/api/sync', 'POST'],
      ['/api/sync/um-id', 'GET'],
      ['/api/sync/um-id', 'PUT'],
      ['/api/sync/um-id', 'DELETE'],
      ['/api/sync/um-id/run', 'POST'],
      ['/api/sync/analyze', 'POST'],
      ['/api/sync/plan', 'POST'],
      ['/api/sync/test-connection', 'POST'],
      ['/api/sync/retention/preview', 'POST'],
    ];
    for (const [rota, metodo] of rotas) {
      const res = await request(rota, { method: metodo, body: metodo === 'GET' ? undefined : JSON.stringify({ Name: 'X' }) });
      expect(res.status, `${metodo} ${rota}`).to.equal(503);
      expect(res.json.error, `${metodo} ${rota}`).to.be.a('string');
    }
  });

  it('responde 503 em toda rota de retention', async () => {
    const rotas = [
      ['/api/retention', 'GET'],
      ['/api/retention', 'POST'],
      ['/api/retention/um-id', 'GET'],
      ['/api/retention/um-id', 'PUT'],
      ['/api/retention/um-id', 'DELETE'],
      ['/api/retention/um-id/run', 'POST'],
    ];
    for (const [rota, metodo] of rotas) {
      const res = await request(rota, { method: metodo, body: metodo === 'GET' ? undefined : JSON.stringify({ Name: 'X' }) });
      expect(res.status, `${metodo} ${rota}`).to.equal(503);
    }
  });

  it('o resto do painel continua de pé depois do 503', async () => {
    const res = await request('/api/tasks');
    expect(res.status).to.equal(200);
    const health = await request('/api/health');
    expect(health.status).to.equal(200);
  });
});
