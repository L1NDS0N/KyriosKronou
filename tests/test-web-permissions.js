// tests/test-web-permissions.js
//
// A allowlist (webAuth.js) decide QUEM entra. Isto fixa o que cada login pode
// fazer depois de entrar: a auditoria mostrou que o painel era tudo-ou-nada, e
// que uma conta autorizada só para olhar o monitor também apaga serviço,
// executa script e mexe em perfil de backup.
//
// São três camadas aqui: a leitura da configuração (normaliza array ou texto,
// ignora escopo desconhecido), o middleware (403 com o escopo que faltou) e o
// servidor de verdade, onde a recusa tem de chegar antes do agendador.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ApiServer = require('../src/main/apiServer');
const ConfigManager = require('../src/main/configManager');
const Logger = require('../src/main/logger');
const CronParser = require('../src/main/cronParser');
const TaskManager = require('../src/main/taskManager');
const BackupManager = require('../src/main/backupManager');
const RunRegistry = require('../src/main/runRegistry');
const WebPermissions = require('../src/main/webPermissions');
const security = require('../src/main/webSecurity');

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-perm-'));
  return new ConfigManager(dir, 'default');
}

function fakeLogger() {
  const warns = [];
  const audits = [];
  return {
    warns, audits,
    log: (level, message) => { if (String(level) === 'WARN') warns.push(message); },
    audit: (action, details) => audits.push({ action, details }),
    error: () => {},
    getRecentLogs: () => [],
  };
}

// ─── O catálogo ───

describe('Permissões web: o catálogo', () => {
  it('cobre todas as telas do painel, com os nomes que a interface usa', () => {
    expect(WebPermissions.SCREENS).to.deep.equal([
      'monitor', 'tasks', 'backups', 'sync', 'retention',
      'services', 'scripts', 'history', 'logs', 'calendar', 'runs',
    ]);
  });

  it('separa ler de mudar, executar e apagar', () => {
    expect(WebPermissions.ACTIONS).to.deep.equal(['view', 'write', 'run', 'delete']);
  });

  it('expõe os escopos todos, para o editor de permissões não inventar nome', () => {
    expect(WebPermissions.ALL_SCOPES).to.have.length(WebPermissions.SCREENS.length * WebPermissions.ACTIONS.length);
    expect(WebPermissions.ALL_SCOPES).to.include('tasks:delete');
    expect(WebPermissions.isValidScope('retention:run')).to.equal(true);
    expect(WebPermissions.isValidScope('taks:view')).to.equal(false);
    expect(WebPermissions.isValidScope('tasks:publish')).to.equal(false);
  });

  // O serviço carrega este arquivo em sessão 0, sem Electron.
  it('não importa electron', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'webPermissions.js'), 'utf8');
    expect(src).to.not.match(/require\(['"]electron['"]\)/);
  });
});

// ─── A configuração ───

describe('Permissões web: ler a configuração', () => {
  let config, permissions;
  beforeEach(() => {
    config = tempConfig();
    permissions = new WebPermissions(config, fakeLogger());
  });

  it('aceita a lista como array ou como texto colado', () => {
    config.setSetting('WebUserPermissions', { ana: ['tasks:view'] });
    expect(permissions.forLogin('ana').allows('tasks:view')).to.equal(true);

    config.setSetting('WebUserPermissions', { ana: 'tasks:view, logs:view' });
    const grant = permissions.forLogin('ana');
    expect(grant.allows('tasks:view')).to.equal(true);
    expect(grant.allows('logs:view')).to.equal(true);
    expect(grant.allows('tasks:delete')).to.equal(false);
  });

  it('não distingue maiúscula de minúscula, como o GitHub', () => {
    config.setSetting('WebUserPermissions', { Ana: ['Tasks:View'] });
    expect(permissions.forLogin('ana').allows('tasks:view')).to.equal(true);
    expect(permissions.forLogin('ANA').allows('tasks:view')).to.equal(true);
  });

  it('trata a tela sozinha como as quatro ações dela', () => {
    config.setSetting('WebUserPermissions', { ana: ['tasks'] });
    const grant = permissions.forLogin('ana');
    for (const acao of WebPermissions.ACTIONS) expect(grant.allows(`tasks:${acao}`), acao).to.equal(true);
    expect(grant.allows('backups:view')).to.equal(false);
  });

  it('aceita uma ação em todas as telas', () => {
    config.setSetting('WebUserPermissions', { ana: ['*:view'] });
    const grant = permissions.forLogin('ana');
    for (const tela of WebPermissions.SCREENS) expect(grant.allows(`${tela}:view`), tela).to.equal(true);
    expect(grant.allows('tasks:delete')).to.equal(false);
  });

  it('trata "*" como tudo, e só isso', () => {
    config.setSetting('WebUserPermissions', { ana: ['*'] });
    const grant = permissions.forLogin('ana');
    expect(grant.wildcard).to.equal(true);
    for (const escopo of WebPermissions.ALL_SCOPES) expect(grant.allows(escopo), escopo).to.equal(true);
  });

  // O ponto de não quebrar o resto da lista: um nome errado de tela não pode
  // virar recusa de tudo nem abrir algo.
  it('ignora escopo desconhecido e segue com os válidos', () => {
    config.setSetting('WebUserPermissions', { ana: ['taks:view', 'banana', 'tasks:publishear', 'tasks:view'] });
    const grant = permissions.forLogin('ana');
    expect(grant.allows('tasks:view')).to.equal(true);
    expect(grant.allows('tasks:publish')).to.equal(false);
    expect(grant.allows('taks:view')).to.equal(false);
  });

  it('libera tudo para quem não foi limitado - instalação que nunca tocou nisso', () => {
    expect(config.getSetting('WebUserPermissions', null)).to.equal(null);
    const grant = permissions.forLogin('qualquer-um');
    expect(grant.wildcard).to.equal(true);
    expect(grant.allows('services:delete')).to.equal(true);
  });

  it('usa a entrada do próprio login em vez do default', () => {
    config.setSetting('WebUserPermissions', { ana: ['monitor:view'], default: ['*'] });
    expect(permissions.forLogin('ana').allows('tasks:write')).to.equal(false);
    expect(permissions.forLogin('bruno').allows('tasks:write'), 'bruno cai no default').to.equal(true);
  });

  // whom o administrador não nomeou, sem default, não fica com tudo: a negação
  // por padrão é o que evita o acidente de quem rebaixa um login só.
  it('nega o que não foi nomeado quando existe configuração', () => {
    config.setSetting('WebUserPermissions', { ana: ['monitor:view'] });
    expect(permissions.forLogin('bruno').allows('monitor:view')).to.equal(false);
    expect(permissions.forLogin('bruno').allows('monitor:view')).to.equal(false);
  });

  it('deixa um login sem nada quando a lista dele está vazia', () => {
    config.setSetting('WebUserPermissions', { ana: [], default: ['*'] });
    expect(permissions.forLogin('ana').allows('monitor:view')).to.equal(false);
  });

  // Chave da API é o caminho de volta: quem não tem acesso no painel ainda
  // recupera a máquina por ela.
  it('nega a tabela inteira quando o valor gravado não é um objeto', () => {
    const logger = fakeLogger();
    const quebrado = new WebPermissions(config, logger);
    config.setSetting('WebUserPermissions', 'tasks:view');
    expect(quebrado.forLogin('ana').allows('tasks:view')).to.equal(false);
    expect(logger.warns.join(' ')).to.include('WebUserPermissions');

    quebrado.forLogin('ana');
    expect(logger.warns, 'o aviso não pode virar spam de log').to.have.length(1);
  });

  it('relê a configuração a cada chamada, sem esperar reiniciar', () => {
    config.setSetting('WebUserPermissions', { ana: ['monitor:view'] });
    expect(permissions.forLogin('ana').allows('tasks:delete')).to.equal(false);
    config.setSetting('WebUserPermissions', { ana: ['*'] });
    expect(permissions.forLogin('ana').allows('tasks:delete'), 'a mudança vale na chamada seguinte').to.equal(true);
  });

  it('resume o que a pessoa pode fazer, para o painel esconder o resto', () => {
    config.setSetting('WebUserPermissions', { ana: ['monitor:view', 'tasks:view', 'tasks:write'] });
    const resumo = permissions.summarize('ana');
    expect(resumo.wildcard).to.equal(false);
    expect(resumo.screens).to.deep.equal({ monitor: ['view'], tasks: ['view', 'write'] });
    expect(resumo.scopes).to.deep.equal(['monitor:view', 'tasks:view', 'tasks:write']);
  });

  it('resume o curinga com as telas todas liberadas', () => {
    config.setSetting('WebUserPermissions', { ana: ['*'] });
    const resumo = permissions.summarize('ana');
    expect(resumo.wildcard).to.equal(true);
    expect(resumo.scopes).to.have.length(WebPermissions.ALL_SCOPES.length);
    expect(resumo.screens.tasks).to.deep.equal(['view', 'write', 'run', 'delete']);
  });
});

// ─── O middleware ───

describe('Permissões web: o middleware', () => {
  let config, permissions, logger;
  beforeEach(() => {
    config = tempConfig();
    logger = fakeLogger();
    permissions = new WebPermissions(config, logger);
  });

  const call = (middleware, req) => new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve({ status: this.statusCode, body: payload }); return this; },
    };
    let wentThrough = false;
    middleware(req, res, () => { wentThrough = true; resolve({ status: null }); });
    if (!wentThrough && !res.body) resolve({ status: res.statusCode, body: res.body });
  });

  // Erro de digitação em rota vira recusa silenciosa em produção, que é a pior
  // forma de falha num controle de acesso: tem de estourar na partida.
  it('recusa escopo escrito errado logo ao registrar a rota', () => {
    expect(() => permissions.requireScope('taks:view')).to.throw(/Escopo inválido/);
    expect(() => permissions.requireScope('tasks:publish')).to.throw(/Escopo inválido/);
    expect(() => permissions.requireScope('')).to.throw(/Escopo inválido/);
    expect(() => permissions.requireScope('tasks:view')).to.not.throw();
  });

  it('deixa passar quem tem o escopo', async () => {
    config.setSetting('WebUserPermissions', { ana: ['tasks:view'] });
    const res = await call(permissions.requireScope('tasks:view'), { kyriosUser: { login: 'ana' }, method: 'GET', path: '/api/tasks' });
    expect(res.status).to.equal(null, 'a requisição tem de seguir para a rota');
  });

  it('responde 403 dizendo qual escopo faltou', async () => {
    config.setSetting('WebUserPermissions', { ana: ['tasks:view'] });
    const res = await call(permissions.requireScope('tasks:delete'), {
      kyriosUser: { login: 'ana' }, method: 'DELETE', path: '/api/tasks/x', ip: '10.0.0.9',
    });
    expect(res.status).to.equal(403);
    expect(res.body.error).to.equal('Forbidden');
    expect(res.body.required).to.equal('tasks:delete');
  });

  it('deixa a tentativa recusada no log de auditoria, com quem e de onde', async () => {
    config.setSetting('WebUserPermissions', { ana: ['tasks:view'] });
    await call(permissions.requireScope('tasks:run'), {
      kyriosUser: { login: 'ana', id: 7 }, method: 'POST', path: '/api/tasks/x/run', ip: '10.0.0.9',
    });
    expect(logger.audits).to.have.length(1);
    expect(logger.audits[0].action).to.equal('WEB_SCOPE_DENIED');
    expect(logger.audits[0].details.actor).to.include('ana');
    expect(logger.audits[0].details.ip).to.equal('10.0.0.9');
    expect(logger.warns.join(' ')).to.include('tasks:run');
  });

  // Integração de máquina não é uma pessoa: a chave de API continua com tudo,
  // senão quebra quem já automatiza por ela.
  it('não limita quem entra pela chave de API', async () => {
    config.setSetting('WebUserPermissions', { ana: ['monitor:view'] });
    const res = await call(permissions.requireScope('services:delete'), {
      kyriosViaApiKey: true, kyriosUser: { login: 'api-key', id: 0 }, method: 'DELETE', path: '/api/services/x',
    });
    expect(res.status).to.equal(null);
  });

  // Rota pública por engano não pode responder 403: sem sessão, é 401.
  it('sem sessão, responde 401 e não 403', async () => {
    const res = await call(permissions.requireScope('tasks:view'), { method: 'GET', path: '/api/tasks' });
    expect(res.status).to.equal(401);
  });
});

// ─── As rotas ───

describe('Permissões web: as rotas', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'apiServer.js'), 'utf8');

  // A auditoria apontou as rotas que passam por dentro do servidor real; cada
  // uma delas tem de continuar protegida, com o escopo certo.
  const PROTEGIDAS = [
    ["get", "/api/metrics", "monitor:view"],
    ["get", "/api/metrics/stream", "monitor:view"],
    ["get", "/api/tasks", "tasks:view"],
    ["get", "/api/tasks/:id", "tasks:view"],
    ["get", "/api/tasks/:id/script", "tasks:view"],
    ["post", "/api/tasks", "tasks:write"],
    ["put", "/api/tasks/:id", "tasks:write"],
    ["post", "/api/tasks/:id/attach", "tasks:write"],
    ["post", "/api/tasks/:id/run", "tasks:run"],
    ["delete", "/api/tasks/:id", "tasks:delete"],
    ["delete", "/api/tasks/:id/attach", "tasks:delete"],
    ["get", "/api/history", "history:view"],
    ["get", "/api/backups", "backups:view"],
    ["get", "/api/backups/history", "backups:view"],
    ["get", "/api/backups/:id", "backups:view"],
    ["post", "/api/backups/test-connection", "backups:view"],
    ["post", "/api/backups/databases", "backups:view"],
    ["post", "/api/backups", "backups:write"],
    ["put", "/api/backups/:id", "backups:write"],
    ["post", "/api/backups/:id/run", "backups:run"],
    ["delete", "/api/backups/:id", "backups:delete"],
    ["get", "/api/sync", "sync:view"],
    ["get", "/api/sync/engines", "sync:view"],
    ["get", "/api/sync/:id", "sync:view"],
    ["post", "/api/sync/analyze", "sync:view"],
    ["post", "/api/sync/plan", "sync:view"],
    ["post", "/api/sync/retention/preview", "sync:view"],
    ["post", "/api/sync/test-connection", "sync:view"],
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
    ["get", "/api/services", "services:view"],
    ["post", "/api/services/:name/:action", "services:run"],
    ["delete", "/api/services/:name", "services:delete"],
    ["get", "/api/runs", "runs:view"],
    ["get", "/api/runs/target/:targetId", "runs:view"],
    ["get", "/api/runs/:id", "runs:view"],
    ["get", "/api/scripts", "scripts:view"],
    ["get", "/api/scripts/:name", "scripts:view"],
    ["post", "/api/scripts", "scripts:write"],
    ["delete", "/api/scripts/:name", "scripts:delete"],
    ["get", "/api/logs", "logs:view"],
    ["get", "/api/logs/errors", "logs:view"],
    ["get", "/api/logs/audit", "logs:view"],
    ["get", "/api/logs/stats", "logs:view"],
    ["get", "/api/calendar", "calendar:view"],
  ];

  it('protege cada rota com o escopo da tela, e não só com a sessão', () => {
    for (const [metodo, rota, escopo] of PROTEGIDAS) {
      expect(src, `${metodo.toUpperCase()} ${rota} perdeu a proteção de escopo`)
        .to.include(`this.app.${metodo}('${rota}', this._need('${escopo}')`);
    }
  });

  it('só usa escopo do catálogo, para um erro de digitação não virar recusa silenciosa', () => {
    const usados = [...src.matchAll(/this\._need\('([^']+)'\)/g)].map(m => m[1]);
    expect(usados.length, 'nenhuma rota protegida: a proteção sumiu').to.be.above(20);
    for (const escopo of usados) expect(WebPermissions.isValidScope(escopo), `${escopo} não está no catálogo`).to.equal(true);
  });

  it('deixa /api/me e /api/health sem escopo, porque são a entrada e o probe', () => {
    expect(src).to.match(/this\.app\.get\('\/api\/me', \(req, res\)/);
    expect(src).to.match(/this\.app\.get\('\/api\/health', \(req, res\)/);
  });
});

// ─── No servidor de verdade ───

describe('Permissões web: no servidor de verdade', function () {
  this.timeout(30000);

  let server, config, port, runs, serviceManager, taskManager, cookies, csrf;

  const request = (routePath, options = {}) => new Promise((resolve) => {
    const headers = Object.assign({}, options.headers);
    const login = options.login || 'reader';
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

  const abrirSessao = (login) => {
    const sid = server.auth.createSession({ login, id: 1, name: login }, '127.0.0.1');
    cookies[login] = 'kyrios_sid=' + server.auth.signCookie(sid);
    csrf[login] = security.csrfToken(server.auth.secret, sid);
  };

  before(async () => {
    config = tempConfig();
    const logger = new Logger(path.join(config.configDir, 'logs'));
    const cronParser = new CronParser();
    runs = new RunRegistry();
    taskManager = new TaskManager(config, logger, cronParser, runs);
    taskManager.addTask({ Name: 'Demo', CronExpression: '*/5 * * * *', ScriptPath: 'C:\\Windows\\System32\\cmd.exe' });
    const backupManager = new BackupManager(config, logger, runs);
    serviceManager = {
      calls: [],
      getAllServices: () => [{ Name: 'KyriosTask_demo', Status: 'Running', IsManaged: true }],
      startService(n) { this.calls.push(['start', n]); return { success: true, message: 'Started' }; },
      stopService(n) { this.calls.push(['stop', n]); return { success: true, message: 'Stopped' }; },
      restartService(n) { this.calls.push(['restart', n]); return { success: true, message: 'Restarted' }; },
      uninstallService(n) { this.calls.push(['remove', n]); return { success: true, message: 'Uninstalled' }; },
    };

    config.setSetting('WebAllowedUsers', ['reader', 'boss', 'schiavo']);
    config.setSetting('WebUserPermissions', {
      reader: ['monitor:view', 'tasks:view'],
      boss: ['*'],
    });
    config.setSetting('ApiKey', 'k-perm');

    server = new ApiServer(taskManager, config, logger, serviceManager, null, backupManager, {
      runRegistry: runs, cronParser,
    });
    const info = await server.start(7735);
    port = info.port;

    cookies = {}; csrf = {};
    for (const login of ['reader', 'boss', 'schiavo']) abrirSessao(login);
  });

  after(async () => {
    if (server) await server.stop();
    if (runs) runs.dispose();
  });

  it('deixa quem tem o escopo fazer a sua parte', async () => {
    expect((await request('/api/tasks')).status).to.equal(200);
    expect((await request('/api/metrics')).status).to.equal(200);
  });

  it('recusa a tela que o login não tem, dizendo o que faltou', async () => {
    const res = await request('/api/logs');
    expect(res.status).to.equal(403);
    expect(res.json.error).to.equal('Forbidden');
    expect(res.json.required).to.equal('logs:view');
  });

  it('recusa apagar, executar e editar onde só se pode ler', async () => {
    const alvo = taskManager.getAllTasks()[0];
    const chamadas = [
      { path: '/api/tasks/' + alvo.Id, method: 'DELETE', required: 'tasks:delete' },
      { path: '/api/tasks/' + alvo.Id + '/run', method: 'POST', required: 'tasks:run' },
      { path: '/api/tasks/' + alvo.Id, method: 'PUT', required: 'tasks:write', body: JSON.stringify({ Name: 'X' }) },
      { path: '/api/tasks', method: 'POST', required: 'tasks:write', body: JSON.stringify({ Name: 'X', CronExpression: '* * * * *', ScriptPath: 'c:\\x.bat' }) },
      { path: '/api/tasks/' + alvo.Id + '/attach', method: 'DELETE', required: 'tasks:delete' },
    ];
    for (const call of chamadas) {
      const res = await request(call.path, { method: call.method, body: call.body });
      expect(res.status, `${call.method} ${call.path}`).to.equal(403);
      expect(res.json.required, `${call.method} ${call.path}`).to.equal(call.required);
    }
    // A tarefa continua lá: a recusa veio antes de qualquer efeito.
    expect(taskManager.getTask(alvo.Id)).to.not.equal(null);
    expect(taskManager.getAllTasks().filter(t => t.Name === 'X')).to.have.length(0);
  });

  it('recusa mexer em serviço e em script de quem só lê', async () => {
    const servico = await request('/api/services/KyriosTask_demo/start', { method: 'POST' });
    expect(servico.status).to.equal(403);
    expect(servico.json.required).to.equal('services:run');

    const envio = await request('/api/scripts', {
      method: 'POST', body: JSON.stringify({ name: 'invadido.bat', contentBase64: 'ZWNobyBvag==' }),
    });
    expect(envio.status).to.equal(403);
    expect(envio.json.required).to.equal('scripts:write');
    expect(fs.existsSync(path.join(config.configDir, '..', 'scripts', 'invadido.bat'))).to.equal(false);
    expect(serviceManager.calls).to.have.length(0);
  });

  // A ordem importa: quem não tem escopo ainda precisa de CSRF válido, senão a
  // recusa por escopo vira oráculo para requisição cross-site.
  it('checa o CSRF antes do escopo', async () => {
    const res = await request('/api/tasks/x', { method: 'DELETE', headers: { 'X-CSRF-Token': '' } });
    expect(res.status).to.equal(403);
    expect(res.json.error).to.equal('Invalid CSRF token');
  });

  it('continua exigindo sessão: sem login a resposta é 401, não 403', async () => {
    const res = await request('/api/tasks/x', { method: 'DELETE', auth: false });
    expect(res.status).to.equal(401);
    expect(res.json.error).to.equal('Unauthorized');
  });

  it('nega quem não foi nomeado, já que existe configuração', async () => {
    const res = await request('/api/tasks', { login: 'schiavo' });
    expect(res.status).to.equal(403);
    expect(res.json.required).to.equal('tasks:view');
  });

  it('deixa o curinga fazer tudo, inclusive o que destrói', async () => {
    const criado = await request('/api/tasks', {
      login: 'boss',
      method: 'POST',
      body: JSON.stringify({ Name: 'Descartável', CronExpression: '0 4 * * *', ScriptPath: 'c:\\x.bat' }),
    });
    expect(criado.status).to.equal(201);
    const id = criado.json.data.task.Id;

    const apagado = await request('/api/tasks/' + id, { login: 'boss', method: 'DELETE' });
    expect(apagado.status).to.equal(200);
    expect(taskManager.getTask(id)).to.equal(null);

    const servico = await request('/api/services/KyriosTask_demo/stop', { login: 'boss', method: 'POST' });
    expect(servico.status).to.equal(200);
    expect(serviceManager.calls).to.deep.include(['stop', 'KyriosTask_demo']);
  });

  // Quem tem a chave já é máquina: a chave não passa por tela nenhuma.
  it('a chave de API continua com tudo, mesmo para sessão sem escopo', async () => {
    const criado = await request('/api/tasks', {
      method: 'POST', auth: false,
      headers: { 'x-api-key': 'k-perm' },
      body: JSON.stringify({ Name: 'Pela chave', CronExpression: '0 5 * * *', ScriptPath: 'c:\\x.bat' }),
    });
    expect(criado.status).to.equal(201);

    const apagado = await request('/api/tasks/' + criado.json.data.task.Id, {
      method: 'DELETE', auth: false, headers: { 'x-api-key': 'k-perm' },
    });
    expect(apagado.status).to.equal(200);
    expect(taskManager.getTask(criado.json.data.task.Id)).to.equal(null);

    const chaves = ['boss', 'schiavo'].map((login) => request('/api/tasks', {
      login, auth: false, headers: { 'x-api-key': 'k-perm' },
    }));
    for (const res of await Promise.all(chaves)) expect(res.status, 'a chave manda sobre a sessão').to.equal(200);
  });

  it('a chave errada continua recusada com 401', async () => {
    const res = await request('/api/tasks', { auth: false, headers: { 'x-api-key': 'chave-errada' } });
    expect(res.status).to.equal(401);
  });

  it('entrega o resumo do escopo em /api/me, sem tirar nada do que já ia', async () => {
    const res = await request('/api/me');
    expect(res.status).to.equal(200);
    expect(res.json.login).to.equal('reader');
    expect(res.json.csrfToken).to.be.a('string').with.length.above(32);
    expect(res.json.permissions.wildcard).to.equal(false);
    expect(res.json.permissions.screens).to.deep.equal({ monitor: ['view'], tasks: ['view'] });
    expect(res.json.permissions.scopes).to.deep.equal(['monitor:view', 'tasks:view']);

    const chefe = await request('/api/me', { login: 'boss' });
    expect(chefe.json.permissions.wildcard).to.equal(true);
  });

  // Rebaixar alguém não espera sessão expirar, como no allowlist.
  it('vale a mudança de permissão sem reiniciar o servidor', async () => {
    expect((await request('/api/logs')).status).to.equal(403);
    config.setSetting('WebUserPermissions', { reader: ['monitor:view', 'tasks:view', 'logs:view'], boss: ['*'] });
    expect((await request('/api/logs')).status).to.equal(200);
    expect((await request('/api/logs/errors')).status).to.equal(200);
    expect((await request('/api/logs/audit')).status).to.equal(200);
    expect((await request('/api/logs/stats')).status).to.equal(200);
    config.setSetting('WebUserPermissions', { reader: ['monitor:view', 'tasks:view'], boss: ['*'] });
    expect((await request('/api/logs')).status).to.equal(403);
  });
});

describe('Permissões web: edição no desktop', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');

  it('leva a matriz para o renderer sem devolver segredo', () => {
    expect(main).to.include("ipcMain.handle('get-web-access'");
    expect(main).to.include('screens: WebPermissions.SCREENS');
    expect(main).to.include('actions: WebPermissions.ACTIONS');
    expect(main).to.include('users: Object.fromEntries');
  });

  it('salva e audita a matriz por login', () => {
    expect(main).to.include("ipcMain.handle('set-web-user-permissions'");
    expect(main).to.include("logger.audit('WEB_USER_PERMISSIONS_CHANGED'");
    expect(main).to.include("config.setSetting('WebUserPermissions', table)");
    expect(preload).to.include('setWebUserPermissions: (login, scopes)');
  });

  it('preserva allowlist em texto quando alguém é adicionado', () => {
    expect(main).to.include("WebPermissions.normalizeList(config.getSetting('WebAllowedUsers', []))");
    expect(main).to.not.include('const users = Array.isArray(raw) ? raw.slice() : [];');
  });
});
