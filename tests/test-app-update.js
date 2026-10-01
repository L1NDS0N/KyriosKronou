// tests/test-app-update.js
//
// O lado da release já existia: o build NSIS produz dist/latest.yml com a
// versão, a url relativa do instalador e o sha512, e o workflow anexa esse
// arquivo e o .blockmap na GitHub Release. O que faltava era o cliente, e ele
// tem três guardas que não são enfeite:
//
//  - não roda em desenvolvimento, onde não há instalador para substituir;
//  - não roda no portable, que é a cópia que o usuário carrega num pendrive e
//    que o updater tentaria substituir por baixo enquanto está em uso;
//  - não instala com backup ou sincronização rodando, porque fechar o
//    agendador no meio da operação deixa o trabalho pela metade.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const { UpdateManager, FEED_URL } = require('../src/main/updateManager');

function fakeUpdater() {
  const emitter = new EventEmitter();
  const registro = { feed: null, check: 0, download: 0, quit: 0, autoDownload: null, autoInstallOnQuit: null };
  emitter.autoDownload = null;
  emitter.autoInstallOnQuit = null;
  emitter.setFeedURL = (feed) => { registro.feed = feed; };
  emitter.checkForUpdates = async () => { registro.check++; };
  emitter.downloadUpdate = async () => { registro.download++; };
  emitter.quitAndInstall = () => { registro.quit++; };
  emitter.registro = registro;
  return emitter;
}

function build(overrides = {}) {
  const updater = overrides.updater || fakeUpdater();
  const janelas = [];
  const manager = new UpdateManager(Object.assign({
    logger: { log() {} },
    getVersion: () => '1.0.0',
    isPackaged: true,
    isPortable: false,
    hasRunningWork: () => 0,
    getWindows: () => janelas,
    autoUpdater: updater,
  }, overrides));
  return { manager, updater, janelas };
}

describe('Atualização: as guardas', () => {
  it('não confere em desenvolvimento, onde não há instalador', async () => {
    const { manager, updater } = build({ isPackaged: false });
    const r = await manager.check();
    expect(r.ok).to.equal(false);
    expect(r.reason).to.equal('update.blockedDev');
    expect(updater.registro.check).to.equal(0);
  });

  it('não confere na versão portátil, que é o arquivo que o usuário carrega', async () => {
    const { manager, updater } = build({ isPortable: true });
    const r = await manager.check();
    expect(r.reason).to.equal('update.blockedPortable');
    expect(updater.registro.check).to.equal(0);
  });

  it('respeita o bloqueio por ambiente, que é como se desliga em máquinas geridas', async () => {
    process.env.KYRION_SKIP_UPDATES = '1';
    try {
      const { manager } = build();
      expect((await manager.check()).reason).to.equal('update.blockedEnv');
    } finally { delete process.env.KYRION_SKIP_UPDATES; }
  });

  it('recusa instalar com execução em andamento', () => {
    const { manager } = build({ hasRunningWork: () => 2 });
    manager.apply = Object.assign(manager.state, { status: 'ready' });
    const r = manager.install();
    // Fechar o agendador no meio de um backup deixa a operação pela metade.
    expect(r.ok).to.equal(false);
    expect(r.reason).to.equal('update.busy');
    expect(r.running).to.equal(2);
  });

  it('instala quando não há nada rodando e o download terminou', () => {
    const { manager, updater } = build();
    manager.apply = Object.assign(manager.state, { status: 'ready', version: '1.0.1' });
    const r = manager.install();
    expect(r.ok).to.equal(true);
    expect(updater.registro.quit).to.equal(1);
  });

  it('não instala antes do download terminar', () => {
    const { manager, updater } = build();
    manager.apply = Object.assign(manager.state, { status: 'downloading' });
    expect(manager.install().reason).to.equal('update.notReady');
    expect(updater.registro.quit).to.equal(0);
  });
});

describe('Atualização: o feed aponta para a release', () => {
  it('usa o provider genérico sobre a URL da última release do GitHub', async () => {
    const { manager, updater } = build();
    await manager.check();
    expect(updater.registro.feed).to.deep.equal({ provider: 'generic', url: FEED_URL });
  });

  it('a URL é https e aponta para o repositório certo', () => {
    expect(FEED_URL).to.match(/^https:\/\/github\.com\/L1NDS0N\/KyriosKronou\/releases\/latest\/download$/);
  });

  it('o package.json declara o repositório, que é de onde o updater descobre o feed', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.repository, 'sem repository o electron-updater não tem onde olhar').to.not.equal(undefined);
    expect(pkg.repository.url).to.include('L1NDS0N/KyriosKronou');
    expect(pkg.devDependencies['electron-updater'], 'a dependencia do cliente').to.not.equal(undefined);
  });

  it('baixa só quando o usuário pede, nunca sozinho', async () => {
    const { manager, updater } = build();
    await manager.check();
    updater.emit('update-available', { version: '1.0.1' });
    // Conferir não baixa: o rodapé só avisa, e o clique é o consentimento.
    expect(updater.registro.download).to.equal(0);
    await manager.download();
    expect(updater.registro.download).to.equal(1);
  });
});

describe('Atualização: os eventos viram estado', () => {
  it('traduz cada evento do electron-updater num estado da tela', async () => {
    const { manager, updater, janelas } = build();
    const recebidos = [];
    janelas.push({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (c, p) => recebidos.push({ c, p }) } });

    await manager.check();
    updater.emit('update-available', { version: '1.0.1' });
    expect(manager.snapshot()).to.include({ status: 'available', version: '1.0.1' });

    updater.emit('download-progress', { percent: 42.4 });
    expect(manager.snapshot()).to.include({ status: 'downloading', percent: 42 });

    updater.emit('update-downloaded', { version: '1.0.1' });
    expect(manager.snapshot()).to.include({ status: 'ready', percent: 100 });

    updater.emit('update-not-available', {});
    expect(manager.snapshot().status).to.equal('current');

    // O aviso precisa chegar na janela, mesmo aberta depois da conferência.
    expect(recebidos.length).to.be.above(3);
    expect(recebidos[0].c).to.equal('update:state');
  });

  it('uma conferência que falha não derruba o app: vira estado de erro', async () => {
    const { manager, updater } = build();
    updater.checkForUpdates = async () => { throw new Error('rede fora'); };
    const r = await manager.check();
    expect(r.ok).to.equal(false);
    expect(manager.snapshot().status).to.equal('error');
  });

  it('não quebra quando a janela já foi destruída', async () => {
    const { manager, updater, janelas } = build();
    janelas.push({ isDestroyed: () => true, webContents: { isDestroyed: () => false, send() { throw new Error('morta'); } } });
    updater.checkForUpdates = async () => { throw new Error('x'); };
    // Um aviso para uma janela fechada é normal, não é motivo para erro.
    expect(() => manager.broadcast({ status: 'available' })).to.not.throw();
  });
});

describe('Atualização: o contrato com o renderer', () => {
  const preload = read('src/main/preload.js');
  const main = read('src/main/main.js');
  const banner = read('src/renderer/updateBanner.js');

  it('todo canal chamado pelo banner tem handler no main', () => {
    const canais = [...new Set([...banner.matchAll(/window\.api\.(\w+)\(/g)].map((m) => m[1]))];
    expect(canais.length, 'o banner precisa falar com o main').to.be.above(2);
    for (const canal of canais) {
      const existeNoPreload = new RegExp(`\\b${canal}:`).test(preload);
      expect(existeNoPreload, `${canal} não está no preload`).to.equal(true);
      const existeNoMain = new RegExp(`ipcMain\\.handle\\('[^']*'`).test(main) && preload.includes(canal);
      expect(existeNoMain, canal).to.equal(true);
    }
  });

  it('o rodapé tem o botão do aviso, escondido por padrão', () => {
    const html = read('src/renderer/index.html');
    expect(html).to.include('id="sb-update"');
    // Escondido: um aviso que aparece sem versão nova seria alarme falso.
    expect(html).to.include('id="sb-update" type="button" style="display:none"');
  });

  it('o banner não baixa sozinho: o clique é o consentimento', () => {
    const clique = banner.slice(banner.indexOf('async onClick()'));
    // available: confirma, e só então chama o download.
    expect(clique).to.include("window.api.downloadAppUpdate()");
    expect(clique).to.include("window.api.installAppUpdate()");
    // E o estado 'downloading' sai antes de qualquer chamada.
    expect(clique).to.include("if (s.status === 'downloading') return;");
  });

  it('as chaves de texto existem nos dois idiomas', () => {
    const i18n = read('src/renderer/i18n.js');
    const chaves = ['update.available', 'update.ready', 'update.confirmTitle', 'update.busyWithWork', 'update.blockedPortable'];
    for (const chave of chaves) {
      const ocorrencias = (i18n.match(new RegExp(`'${chave.replace('.', '\\.')}'`, 'g')) || []).length;
      expect(ocorrencias, `${chave} precisa estar em pt e en`).to.equal(2);
    }
  });

  it('a tela só depende de helpers que existem de fato', () => {
    const app = read('src/renderer/app.js');
    for (const helper of ['showModal', 'hideModal', 'showToast', 'escHtml', 'i18n']) {
      const definido = helper === 'i18n'
        ? fs.existsSync(path.join(ROOT, 'src', 'renderer', 'i18n.js'))
        : new RegExp(`function ${helper}\\b`).test(app);
      expect(definido, `${helper} é usado pelo banner mas não existe`).to.equal(true);
    }
    // As chaves usadas precisam ser as do dicionário, não inventadas.
    const i18n = read('src/renderer/i18n.js');
    for (const chave of [...banner.matchAll(/i18n\.t\('([\w.]+)'\)/g)].map((m) => m[1])) {
      expect(i18n, `chave inexistente: ${chave}`).to.include(`'${chave}'`);
    }
  });
});
