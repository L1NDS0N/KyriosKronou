// syncthing/daemon.js - Ciclo de vida do processo Syncthing.
//
// Duas cuidadoas que custaram comportamento estranho antes:
//
// 1. A CLI mudou de forma entre v1 e v2. v1 usa `-home=` e `-generate=`; v2 usa
//    os subcomandos `serve` e `generate` com `--home=`. Passar os flags da
//    versão errada faz o binário abrir uma GUI e um profile novos em vez de
//    rodar o nosso, então a versão é detectada e os argumentos montados por ela.
//
// 2. `--home` aponta para %ProgramData%, nunca para %LOCALAPPDATA%. O serviço
//    roda como LocalSystem e veria outro profile, com outro device ID.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const { syncthingHome } = require('../paths');
const { SyncthingClient } = require('./client');

// A porta 8384 é a do Syncthing, mas um segundo daemon na mesma máquina
// (outro usuário, um Syncthing avulso) já pode estar com ela.
const BASE_PORT = 8384;
const MAX_PORT_ATTEMPTS = 12;

// A CLI mudou entre v1 e v2. These flags were measured with --help on 2.1.5,
// not taken from the docs: `generate` in v2 accepts no --no-default-folder and
// no --no-upgrade, and --gui-address wants a full URL instead of host:port.
// Getting any of this wrong makes the binary open a brand new profile instead
// of ours, or refuse to start at all, so the version decides the arguments.
//
// --no-port-probing keeps Syncthing on the port we picked: it would otherwise
// go looking for a free one and move out from under the client we already
// built for it.
const COMMON_V2 = ['--no-browser', '--no-console', '--no-restart', '--no-upgrade', '--no-port-probing'];
const COMMON_V1 = ['-no-browser', '-no-console', '-no-restart', '-no-upgrade'];

function readApiKey(home) {
  const xmlPath = path.join(home, 'config.xml');
  if (!fs.existsSync(xmlPath)) return '';
  try {
    const match = fs.readFileSync(xmlPath, 'utf8').match(/<apikey>([^<]*)<\/apikey>/);
    return match ? match[1].trim() : '';
  } catch (e) {
    return '';
  }
}

function isGenerated(home) {
  return fs.existsSync(path.join(home, 'config.xml')) && fs.existsSync(path.join(home, 'cert.pem'));
}

function portFree(port) {
  const net = require('net');
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

class SyncthingDaemon {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.home = options.home || syncthingHome();
    this.installer = options.installer;
    // Injetável para os testes: verificar "o filho foi derrubado" exige
    // controlar o spawn, e `spawn` desestruturado no topo não é alcançado
    // por quem substitui o módulo depois do require.
    this.spawn = options.spawn || spawn;
    this.process = null;
    this.pid = null;
  }

  log(level, message) {
    if (this.logger) this.logger.log(level, message);
  }

  serveArgs(major, port) {
    if (major >= 2) return ['serve', '--home', this.home, '--gui-address', `http://127.0.0.1:${port}`, ...COMMON_V2];
    return [`-home=${this.home}`, `-gui-address=127.0.0.1:${port}`, ...COMMON_V1];
  }

  generateArgs(major) {
    if (major >= 2) return ['generate', '--home', this.home, '--no-port-probing'];
    return [`-home=${this.home}`];
  }

  async findFreePort() {
    for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
      const port = BASE_PORT + i;
      if (await portFree(port)) return port;
    }
    return null;
  }

  // Cria config.xml, cert.pem e key.pem. Sem isso o Syncthing geraria um
  // profile no %LOCALAPPDATA% do usuário corrente e o daemon do serviço ficaria
  // com um device ID diferente do que a GUI enxerga.
  async generate(executable, major) {
    await new Promise((resolve) => fs.promises.mkdir(this.home, { recursive: true }).then(resolve, resolve));
    await new Promise((resolve, reject) => {
      execFile(executable, this.generateArgs(major), { encoding: 'utf8', timeout: 60000, windowsHide: true },
        (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stdout || ''}${stderr || ''}`)) : resolve()));
    });
    return isGenerated(this.home);
  }

  // A ordem importa: primeiro pergunta a cada porta se alguém já responde, e
  // só depois procura porta livre. Procurar a livre primeiro pulava a porta do
  // nosso próprio daemon - ela está ocupada justamente porque ele está de pé -
  // e o resultado era um segundo Syncthing subindo na porta seguinte.
  async pickClient(executable) {
    const installed = await this.installer.checkInstalled();
    if (!installed.installed) return { ok: false, reason: 'not-installed' };
    const apiKey = readApiKey(this.home);
    if (!apiKey) return { ok: false, reason: 'not-generated', executable: installed.path, version: installed.version };

    const base = { executable: installed.path, version: installed.version };
    const ports = Array.from({ length: MAX_PORT_ATTEMPTS }, (unused, i) => BASE_PORT + i);

    for (const port of ports) {
      const client = new SyncthingClient({ port, apiKey });
      try {
        return { ok: true, client, port, running: true, status: await client.systemStatus(), ...base };
      } catch (e) { /* nada escutando nesta porta */ }
    }
    for (const port of ports) {
      if (await portFree(port)) return { ok: true, client: new SyncthingClient({ port, apiKey }), port, running: false, ...base };
    }
    return { ok: false, reason: 'no-port', ...base };
  }

  // Duas chamadas concorrentes de start() - a GUI e o serviço subindo no mesmo
// minuto - passavam as duas pela verificação de porta livre, porque cada uma
// via a porta antes de a outra ocupar. Resultado: dois daemons no mesmo home,
// disputando o mesmo config.xml. Memoizar a promise fecha a janela, e ela é
// liberada quando o start termina, para o próximo start de verdade.
async start() {
    if (this._starting) return this._starting;
    this._starting = this._startOnce().finally(() => { this._starting = null; });
    return this._starting;
  }

  async _startOnce() {
    if (isGenerated(this.home) === false) {
      const installed = await this.installer.checkInstalled();
      if (!installed.installed) return { ok: false, reason: 'not-installed' };
      await this.generate(installed.path, installed.version.major);
    }

    const picked = await this.pickClient();
    if (!picked.ok) return picked;
    if (picked.running) {
      return { ok: true, alreadyRunning: true, client: picked.client, port: picked.port, executable: picked.executable, version: picked.version, status: picked.status };
    }

    const installed = await this.installer.checkInstalled();
    const port = picked.port;
    const child = this.spawn(installed.path, this.serveArgs(installed.version.major, port), {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    });
    child.unref();
    this.process = child;
    this.log('INFO', `Syncthing iniciado: ${installed.path} (v${installed.version.text}) porta ${port}`);

    const status = await this.waitForApi(picked.client, 30000);
    if (status.ok) {
      this.pid = child.pid;
      await this.writePidFile(child.pid);
      await this.dropDefaultFolder(picked.client);
      return { ok: true, client: picked.client, port, executable: installed.path, version: installed.version, status: status.status, pid: child.pid };
    }

    // O binário subiu mas a API não respondeu em 30 s: ele está de pé, com o
    // config.xml trancado, e ninguém mais conseguiria falar com ele. Deixar
    // esse filho órfão é pior do que não ter daemon: derrubar e devolver a
    // máquina ao estado em que ela estava.
    this.log('WARN', `Syncthing subiu mas a API não respondeu em 30s; encerrando o processo ${child.pid}`);
    try { process.kill(child.pid); } catch (e) { /* já morreu */ }
    this.process = null;
    this.pid = null;
    return { ok: false, reason: 'start-timeout', client: picked.client, port, executable: installed.path, version: installed.version };
  }

  // O PID em disco é o que permite saber, depois de um reinício ou de um
  // fechamento abrupto, se o daemon continua de pé e contra qual porta falar.
  async writePidFile(pid) {
    try {
      await fs.promises.mkdir(this.home, { recursive: true });
      await fs.promises.writeFile(path.join(this.home, 'daemon.pid'), String(pid), 'utf8');
    } catch (e) {
      this.log('WARN', `Nao consegui gravar o pid do Syncthing: ${e.message}`);
    }
  }

  readPidFile() {
    try {
      const raw = fs.readFileSync(path.join(this.home, 'daemon.pid'), 'utf8').trim();
      return Number(raw) > 0 ? Number(raw) : null;
    } catch (e) {
      return null;
    }
  }

  async clearPidFile() {
    try { fs.unlinkSync(path.join(this.home, 'daemon.pid')); } catch (e) { /* já não existe */ }
  }

  // A v2 não tem mais --no-default-folder, e a flag só valeria na primeira
  // inicialização mesmo. Apagar pela REST API funciona em toda versão e não
  // depende de o binário aceitar uma flag.
  async dropDefaultFolder(client) {
    try {
      const folders = await client.folders();
      const extra = (folders || []).filter((f) => f.id === 'default');
      for (const folder of extra) await client.deleteFolder(folder.id);
    } catch (e) {
      this.log('WARN', `Nao foi possivel remover a pasta default: ${e.message}`);
    }
  }

  async waitForApi(client, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return { ok: true, status: await client.systemStatus() };
      } catch (e) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return { ok: false, status: null };
  }

  async stop(client) {
    try {
      await client.shutdown();
    } catch (e) {
      this.log('WARN', `Syncthing shutdown via API falhou: ${e.message}`);
    }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        await client.systemStatus();
      } catch (e) {
        await this.clearPidFile();
        this.pid = null;
        return { ok: true };
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // A API não confirmou a queda. O PID em disco é o que sobrou: encerrar o
    // processo conhecido é melhor do que deixar o daemon de pé trancando o
    // config.xml para o próximo start.
    const pid = this.pid || this.readPidFile();
    if (pid) {
      this.log('WARN', `Syncthing nao confirmou o shutdown; encerrando o processo ${pid}`);
      try { process.kill(pid); } catch (e) { /* já morreu, ou pertence a outro */ }
    }
    await this.clearPidFile();
    this.pid = null;
    return { ok: true, forced: Boolean(pid) };
  }

  async status() {
    const picked = await this.pickClient();
    if (!picked.ok) return picked;
    return { ok: true, running: picked.running, client: picked.client, port: picked.port, status: picked.status };
  }
}

module.exports = SyncthingDaemon;
module.exports.SyncthingDaemon = SyncthingDaemon;
module.exports.readApiKey = readApiKey;
module.exports.isGenerated = isGenerated;
module.exports.BASE_PORT = BASE_PORT;
