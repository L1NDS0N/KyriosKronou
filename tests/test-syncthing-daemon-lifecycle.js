// tests/test-syncthing-daemon-lifecycle.js
//
// O daemon do Syncthing roda detached, e isso traz dois problemas que só
// aparecem quando GUI e serviço sobem no mesmo minuto, ou quando o app fecha
// com o daemon de pé.
//
// O primeiro era um spawn duplicado: duas chamadas concorrentes de start()
// passavam as duas pela verificação de porta livre, porque cada uma via a
// porta antes de a outra ocupar. Dois daemons no mesmo home, disputando o
// mesmo config.xml.
//
// O segundo era um filho órfão: se o binário subisse mas a API não
// respondesse em 30 s, ele ficava de pé, trancando o config.xml, e nada no
// projeto tinha um handle para derrubá-lo.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { SyncthingDaemon } = require('../src/main/syncthing/daemon');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-daemon-'));
}

// Instala um home "gerado" de verdade, para o daemon não tentar gerar nada.
function homeGerado(dir) {
  fs.writeFileSync(path.join(dir, 'config.xml'),
    '<configuration version="52"><device id="AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH"></device><gui><apikey>chave</apikey></gui></configuration>', 'utf8');
  fs.writeFileSync(path.join(dir, 'cert.pem'), 'x', 'utf8');
  return dir;
}

function installerDuble({ installed = true, major = 2 } = {}) {
  return {
    checkInstalled: async () => (installed
      ? { installed: true, path: 'C:\\syncthing.exe', version: { major, minor: 1, patch: 5, text: `${major}.1.5` } }
      : { installed: false }),
  };
}

// Cliente que nunca responde, para o caminho de timeout.
const clienteMorto = {
  systemStatus: async () => { throw new Error('sem resposta'); },
  folders: async () => [],
  deleteFolder: async () => {},
};

describe('Daemon: duas chamadas concorrentes não sobem dois processos', () => {
  it('as chamadas concorrentes compartilham o mesmo start', async () => {
    const home = homeGerado(temp());
    let spawned = 0;
    const d = new SyncthingDaemon({ home, installer: installerDuble() });

    // Sem memoizar, as duas chamadas passariam pela checagem de porta livre e
    // cada uma criaria um processo.
    d._startOnce = async function () {
      spawned++;
      await new Promise((r) => setTimeout(r, 30));
      return { ok: true, port: 8384, pid: 1234 };
    };

    const [a, b] = await Promise.all([d.start(), d.start()]);
    expect(spawned, 'só pode haver um start real').to.equal(1);
    expect(a.port).to.equal(8384);
    expect(b.port).to.equal(8384);
  });

  it('a janela volta a ficar livre para o próximo start', async () => {
    // Sem isso, o segundo start da sessão devolveria o resultado do primeiro
    // mesmo com o daemon já parado.
    const home = homeGerado(temp());
    let chamadas = 0;
    const d = new SyncthingDaemon({ home, installer: installerDuble() });
    d._startOnce = async function () { chamadas++; return { ok: true, port: 8384 }; };

    await d.start();
    await d.start();
    expect(chamadas).to.equal(2);
  });

  it('um start que falha libera a janela para nova tentativa', async () => {
    const home = homeGerado(temp());
    const d = new SyncthingDaemon({ home, installer: installerDuble() });
    let chamadas = 0;
    d._startOnce = async function () {
      chamadas++;
      return chamadas === 1 ? { ok: false, reason: 'not-installed' } : { ok: true, port: 8384 };
    };
    expect((await d.start()).ok).to.equal(false);
    expect((await d.start()).ok).to.equal(true);
  });
});

describe('Daemon: o processo não fica órfão', () => {
  it('derruba o filho quando a API não responde, em vez de deixá-lo trancando o config', async function () {
    this.timeout(60000);
    const home = homeGerado(temp());
    const mortos = [];
    const d = new SyncthingDaemon({ home, installer: installerDuble() });

    // pickClient devolve um cliente que responde e uma porta livre.
    d.pickClient = async () => ({ ok: true, client: clienteMorto, port: 8384, running: false, executable: 'C:\\syncthing.exe', version: { major: 2, text: '2.1.5' } });
    // waitForApi falhando é o cenário: o binário subiu e a API não veio.
    d.waitForApi = async () => ({ ok: false, status: null });

    const child = new EventEmitter();
    child.pid = 999999;
    child.unref = () => {};
    d.spawn = () => child;

    const originalKill = process.kill;
    process.kill = (pid) => { mortos.push(pid); return true; };

    try {
      const r = await d._startOnce();
      expect(r.ok).to.equal(false);
      expect(r.reason).to.equal('start-timeout');
      expect(mortos, 'o filho tem de ser derrubado').to.include(999999);
      expect(d.process).to.equal(null);
    } finally {
      process.kill = originalKill;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('grava o PID quando o daemon sobe de verdade', () => {
    const home = homeGerado(temp());
    const d = new SyncthingDaemon({ home, installer: installerDuble() });
    return d.writePidFile(4242).then(() => {
      expect(d.readPidFile()).to.equal(4242);
      expect(fs.existsSync(path.join(home, 'daemon.pid'))).to.equal(true);
      return d.clearPidFile();
    }).then(() => {
      expect(d.readPidFile()).to.equal(null);
      fs.rmSync(home, { recursive: true, force: true });
    });
  });

  it('PID ausente ou corrompido não derruba nada ao ler', () => {
    const home = homeGerado(temp());
    const d = new SyncthingDaemon({ home, installer: installerDuble() });
    expect(d.readPidFile()).to.equal(null);
    fs.writeFileSync(path.join(home, 'daemon.pid'), 'lixo', 'utf8');
    expect(d.readPidFile(), 'lixo não é PID').to.equal(null);
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe('Daemon: parar encerra o processo quando a API não confirma', () => {
  it('usa o PID em disco quando o shutdown pela API não derruba nada', async function () {
    this.timeout(60000);
    const home = homeGerado(temp());
    const d = new SyncthingDaemon({ home, installer: installerDuble() });
    await d.writePidFile(31337);

    const mortos = [];
    const originalKill = process.kill;
    process.kill = (pid) => { mortos.push(pid); return true; };

    // A API nunca para de responder: o deadline de 20 s tem de estourar.
    const clienteTeimoso = {
      shutdown: async () => {},
      systemStatus: async () => ({ myID: 'AINDA-AQUI' }),
    };

    try {
      const r = await d.stop(clienteTeimoso);
      expect(r.ok).to.equal(true);
      expect(r.forced, 'sem confirmação da API, o PID tem de ser usado').to.equal(true);
      expect(mortos).to.include(31337);
      expect(d.readPidFile(), 'o arquivo de PID some depois').to.equal(null);
    } finally {
      process.kill = originalKill;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('quando a API confirma a queda, não há o que forçar', async () => {
    const home = homeGerado(temp());
    const d = new SyncthingDaemon({ home, installer: installerDuble() });
    await d.writePidFile(555);
    const mortos = [];
    const originalKill = process.kill;
    process.kill = (pid) => { mortos.push(pid); return true; };
    let chamadas = 0;
    try {
      const cliente = {
        shutdown: async () => {},
        systemStatus: async () => { chamadas++; throw new Error('fora'); },
      };
      const r = await d.stop(cliente);
      expect(r.forced).to.equal(undefined);
      expect(mortos, 'não se mata o que já morreu').to.deep.equal([]);
      expect(d.readPidFile()).to.equal(null);
    } finally {
      process.kill = originalKill;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});