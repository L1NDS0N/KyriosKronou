// tests/test-web-actions.js
//
// O painel web tem que fazer as mesmas coisas que o desktop - e o servidor é
// quem decide o que ele consegue fazer. Estes testes sobem o ApiServer de
// verdade e exercitam cada rota nova por HTTP, autenticado, incluindo as que
// devem ser recusadas.

const { expect } = require('chai');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ApiServer = require('../src/main/apiServer');
const ConfigManager = require('../src/main/configManager');
const Logger = require('../src/main/logger');
const CronParser = require('../src/main/cronParser');
const TaskManager = require('../src/main/taskManager');
const BackupManager = require('../src/main/backupManager');
const RunRegistry = require('../src/main/runRegistry');
const security = require('../src/main/webSecurity');

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-web-'));
  return new ConfigManager(path.join(dir, 'config'), 'default');
}

/** Um ServiceManager de mentira: os testes não instalam serviços de verdade. */
function fakeServiceManager() {
  const calls = [];
  return {
    calls,
    services: [
      { Name: 'KyriosTask_demo', Status: 'Running', IsManaged: true, Application: 'x', StartupType: 'Automatic' },
      { Name: 'Spooler', Status: 'Running', IsManaged: false, Application: 'y', StartupType: 'Automatic' },
    ],
    getAllServices() { return this.services; },
    startService(n) { calls.push(['start', n]); return { success: true, message: 'Started' }; },
    stopService(n) { calls.push(['stop', n]); return { success: true, message: 'Stopped' }; },
    restartService(n) { calls.push(['restart', n]); return { success: true, message: 'Restarted' }; },
    uninstallService(n) { calls.push(['remove', n]); return { success: true, message: 'Uninstalled' }; },
  };
}

describe('Painel web: ações', function () {
  this.timeout(30000);

  let server, config, port, sessionCookie, csrf, runs, serviceManager, taskManager, scriptsDir;

  const request = (routePath, options = {}) => new Promise((resolve) => {
    const headers = Object.assign({}, options.headers);
    if (options.auth !== false && sessionCookie) headers.cookie = sessionCookie;
    // Nao sobrescreve um token que o proprio teste tenha mandado: e assim que
    // se testa a recusa por token ausente.
    if (options.auth !== false && csrf && options.method && options.method !== 'GET'
        && !('X-CSRF-Token' in headers)) headers['X-CSRF-Token'] = csrf;
    if (options.body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    // Sem Origin a checagem fica indeterminada e só o token decide; os testes
    // que tratam de origem mandam o cabeçalho explicitamente.
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

  before(async () => {
    config = tempConfig();
    const logger = new Logger(path.join(config.configDir, 'logs'));
    const cronParser = new CronParser();
    runs = new RunRegistry();
    taskManager = new TaskManager(config, logger, cronParser, runs);
    taskManager.addTask({ Name: 'Demo', CronExpression: '*/5 * * * *', ScriptPath: 'C:\\Windows\\System32\\cmd.exe' });
    const backupManager = new BackupManager(config, logger, runs);
    serviceManager = fakeServiceManager();

    server = new ApiServer(taskManager, config, logger, serviceManager, null, backupManager, {
      runRegistry: runs, cronParser,
    });
    const info = await server.start(7733);
    port = info.port;
    scriptsDir = path.join(config.configDir, '..', 'scripts');

    // Uma sessão de verdade, criada pelo próprio WebAuth. O allowlist nega por
    // padrão, e uma sessão de login não permitido morre na requisição seguinte -
    // então o login do teste precisa estar lá.
    config.setSetting('WebAllowedUsers', 'tester');
    const user = { login: 'tester', id: 42, name: 'Tester' };
    const sid = server.auth.createSession(user, '127.0.0.1');
    sessionCookie = 'kyrios_sid=' + server.auth.signCookie(sid);
    csrf = security.csrfToken(server.auth.secret, sid);
  });

  after(async () => {
    if (server) await server.stop();
    if (runs) runs.dispose();
  });

  // ─── CSRF ───

  describe('CSRF', () => {
    it('recusa uma escrita sem token, mesmo com a sessão válida', async () => {
      const res = await request('/api/tasks', {
        method: 'POST', body: JSON.stringify({ Name: 'X', CronExpression: '* * * * *', ScriptPath: 'c:\\x.bat' }),
        headers: { 'X-CSRF-Token': '' },
      });
      expect(res.status).to.equal(403);
      expect(res.json.error).to.equal('Invalid CSRF token');
    });

    // O cenário real: a vítima está logada e abre uma página maliciosa.
    it('recusa uma escrita vinda de outra origem', async () => {
      const res = await request('/api/tasks/x', {
        method: 'DELETE', headers: { origin: 'http://malicioso.example' },
      });
      expect(res.status).to.equal(403);
      expect(res.json.error).to.equal('Cross-origin request refused');
    });

    it('deixa passar a leitura sem token, que não muda nada', async () => {
      expect((await request('/api/tasks')).status).to.equal(200);
    });

    it('entrega o token junto com o /api/me, para a página poder escrever', async () => {
      const res = await request('/api/me');
      expect(res.status).to.equal(200);
      expect(res.json.csrfToken).to.be.a('string').with.length.above(32);
    });
  });

  // ─── Serviços ───

  describe('serviços', () => {
    it('lista os serviços', async () => {
      const res = await request('/api/services');
      expect(res.status).to.equal(200);
      expect(res.json.data).to.have.length(2);
    });

    it('inicia, para e reinicia', async () => {
      for (const acao of ['start', 'stop', 'restart']) {
        const res = await request('/api/services/KyriosTask_demo/' + acao, { method: 'POST' });
        expect(res.status, acao).to.equal(200);
      }
      expect(serviceManager.calls.map(c => c[0])).to.include.members(['start', 'stop', 'restart']);
    });

    // Sem essa checagem o nome vira argumento de linha de comando para o NSSM.
    it('recusa um serviço que não existe', async () => {
      const res = await request('/api/services/inventado/start', { method: 'POST' });
      expect(res.status).to.equal(404);
    });

    it('recusa uma ação que não conhece', async () => {
      const res = await request('/api/services/KyriosTask_demo/format-disk', { method: 'POST' });
      expect(res.status).to.equal(400);
    });

    // Remover um serviço do Windows que não é nosso desconfigura a máquina.
    it('só remove serviço criado pelo próprio sistema', async () => {
      const alheio = await request('/api/services/Spooler', { method: 'DELETE' });
      expect(alheio.status).to.equal(403);

      const nosso = await request('/api/services/KyriosTask_demo', { method: 'DELETE' });
      expect(nosso.status).to.equal(200);
      expect(serviceManager.calls).to.deep.include(['remove', 'KyriosTask_demo']);
    });
  });

  // ─── Execuções ───

  describe('execuções ao vivo', () => {
    it('lista o que está rodando agora', async () => {
      const runId = runs.start({ targetId: 't1', kind: 'task', name: 'Demo', steps: ['um', 'dois'] });
      const res = await request('/api/runs');
      expect(res.status).to.equal(200);
      expect(res.json.data.map(r => r.runId)).to.include(runId);
      runs.finish(runId, { success: true });
    });

    it('entrega só as linhas novas de uma execução', async () => {
      const runId = runs.start({ targetId: 't2', kind: 'task', name: 'Demo', steps: ['um'] });
      runs.appendOutput(runId, 'primeira linha');
      runs.appendOutput(runId, 'segunda linha');

      const tudo = await request('/api/runs/' + runId);
      expect(tudo.status).to.equal(200);
      const seq = tudo.json.data.lastSeq;

      runs.appendOutput(runId, 'terceira linha');
      const novas = await request('/api/runs/' + runId + '?since=' + seq);
      expect(novas.json.data.lines.map(l => l.text).join(' ')).to.include('terceira');
      expect(novas.json.data.lines.map(l => l.text).join(' ')).to.not.include('primeira');
      runs.finish(runId, { success: true });
    });

    // /api/runs/:id casaria com a palavra "target" se viesse registrada antes.
    it('a rota por alvo não é engolida pela rota por id', async () => {
      const res = await request('/api/runs/target/t3');
      expect(res.status).to.equal(200);
      expect(res.json.success).to.equal(true);
    });

    it('responde 404 para uma execução que não existe', async () => {
      expect((await request('/api/runs/nao-existe')).status).to.equal(404);
    });
  });

  // ─── Upload de scripts ───

  describe('scripts', () => {
    const enviar = (body) => request('/api/scripts', { method: 'POST', body: JSON.stringify(body) });
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

    it('recebe um arquivo e o guarda na pasta gerenciada', async () => {
      const res = await enviar({ name: 'rotina.ps1', contentBase64: b64('Write-Host "oi"') });
      expect(res.status).to.equal(201);
      expect(fs.readFileSync(path.join(scriptsDir, 'rotina.ps1'), 'utf8')).to.include('Write-Host');
    });

    it('lista o que foi enviado', async () => {
      const res = await request('/api/scripts');
      expect(res.json.data.map(f => f.name)).to.include('rotina.ps1');
    });

    it('devolve o conteúdo de um script', async () => {
      const res = await request('/api/scripts/rotina.ps1');
      expect(res.json.data.content).to.include('Write-Host');
    });

    // Sobrescrever calado apagaria o script de alguém sem aviso nenhum.
    it('não sobrescreve sem que peçam', async () => {
      const res = await enviar({ name: 'rotina.ps1', contentBase64: b64('outro') });
      expect(res.status).to.equal(409);

      const forcado = await enviar({ name: 'rotina.ps1', contentBase64: b64('outro'), overwrite: true });
      expect(forcado.status).to.equal(200);
    });

    // O que for gravado aqui o agendador executa depois.
    it('recusa extensão que não está na lista', async () => {
      const res = await enviar({ name: 'malware.exe', contentBase64: b64('MZ') });
      expect(res.status).to.equal(400);
      expect(fs.existsSync(path.join(scriptsDir, 'malware.exe'))).to.equal(false);
    });

    it('recusa nome que tenta escapar da pasta', async () => {
      for (const nome of ['../fora.ps1', '..\\fora.ps1', 'C:\\Windows\\Temp\\fora.ps1', 'sub/dentro.ps1']) {
        const res = await enviar({ name: nome, contentBase64: b64('x') });
        expect(res.status, nome).to.equal(400);
      }
      expect(fs.existsSync(path.join(path.dirname(scriptsDir), 'fora.ps1'))).to.equal(false);
    });

    it('recusa um arquivo grande demais', async () => {
      const res = await enviar({ name: 'grande.ps1', contentBase64: Buffer.alloc(9 * 1024 * 1024).toString('base64') });
      expect(res.status).to.equal(413);
    });

    it('avisa quando o script está em uso por uma tarefa', async () => {
      const alvo = path.join(scriptsDir, 'emuso.bat');
      await enviar({ name: 'emuso.bat', contentBase64: b64('echo oi') });
      taskManager.addTask({ Name: 'Usa o script', CronExpression: '0 3 * * *', ScriptPath: alvo });

      const res = await request('/api/scripts/emuso.bat', { method: 'DELETE' });
      expect(res.status).to.equal(409);
      expect(res.json.tasks[0].Name).to.equal('Usa o script');
      expect(fs.existsSync(alvo)).to.equal(true);

      const forcado = await request('/api/scripts/emuso.bat?force=true', { method: 'DELETE' });
      expect(forcado.status).to.equal(200);
      expect(fs.existsSync(alvo)).to.equal(false);
    });
  });

  // ─── Backups ───

  describe('perfis de backup', () => {
    let id;

    it('cria um perfil', async () => {
      const res = await request('/api/backups', {
        method: 'POST',
        body: JSON.stringify({ Name: 'Diário', Host: 'localhost', Port: 3306, User: 'root', Password: 'segredo', CronExpression: '0 2 * * *' }),
      });
      expect(res.status).to.equal(201);
      id = res.json.data.Id;
      expect(id).to.be.a('string');
    });

    // A senha é o motivo de o painel existir num servidor, e o motivo de ela
    // nunca poder sair dele.
    it('nunca devolve a senha', async () => {
      const lista = await request('/api/backups');
      expect(JSON.stringify(lista.json)).to.not.include('segredo');
      const um = await request('/api/backups/' + id);
      expect(JSON.stringify(um.json)).to.not.include('segredo');
      expect(um.json.data.Password).to.equal(undefined);
    });

    // Como a senha não sai, ela também não volta - e um PUT sem ela significa
    // "não mexa na senha", não "apague".
    it('preserva a senha num update que não a traz', async () => {
      const res = await request('/api/backups/' + id, {
        method: 'PUT', body: JSON.stringify({ Name: 'Diário (renomeado)' }),
      });
      expect(res.status).to.equal(200);
      expect(server.backupManager.getProfile(id).Password).to.equal('segredo');
      expect(server.backupManager.getProfile(id).Name).to.equal('Diário (renomeado)');
    });

    it('apaga um perfil', async () => {
      const res = await request('/api/backups/' + id, { method: 'DELETE' });
      expect(res.status).to.equal(200);
      expect(server.backupManager.getProfile(id)).to.equal(null);
    });

    it('responde 404 para um perfil que não existe', async () => {
      expect((await request('/api/backups/nao-existe')).status).to.equal(404);
      expect((await request('/api/backups/nao-existe', { method: 'DELETE' })).status).to.equal(404);
    });
  });

  // ─── Agenda ───

  describe('agenda', () => {
    it('monta o calendário', async () => {
      const res = await request('/api/calendar');
      expect(res.status).to.equal(200);
      expect(res.json.data).to.be.an('object');
    });

    it('aponta conflito de horário e sugere um livre', async () => {
      const res = await request('/api/schedule/conflicts', {
        method: 'POST', body: JSON.stringify({ expression: '*/5 * * * *' }),
      });
      expect(res.status).to.equal(200);
      expect(res.json.data.conflicts).to.be.an('array');
      expect(res.json.data.conflicts.length, 'a tarefa Demo usa */5').to.be.above(0);
    });

    it('recusa expressão ausente', async () => {
      const res = await request('/api/schedule/conflicts', { method: 'POST', body: JSON.stringify({}) });
      expect(res.status).to.equal(400);
    });
  });

  // ─── Sem sessão ───

  // auth:false nao manda o cookie; zerar a variavel compartilhada aqui
  // derrubaria todos os outros testes, que o mocha roda depois deste.
  it('todas as rotas novas exigem sessão', async () => {
    for (const call of [
      { path: '/api/services/x/start', method: 'POST' },
      { path: '/api/services/x', method: 'DELETE' },
      { path: '/api/runs', method: 'GET' },
      { path: '/api/scripts', method: 'GET' },
      { path: '/api/scripts', method: 'POST' },
      { path: '/api/scripts/x.ps1', method: 'DELETE' },
      { path: '/api/backups', method: 'POST' },
      { path: '/api/calendar', method: 'GET' },
      { path: '/api/schedule/conflicts', method: 'POST' },
    ]) {
      const res = await request(call.path, { method: call.method, auth: false });
      expect(res.status, `${call.method} ${call.path} tem que ser recusada`).to.equal(401);
    }
  });
});
