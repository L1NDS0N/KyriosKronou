// updateManager.js - Conferência e instalação de atualizações do próprio app.
//
// O lado da release já existia: o build NSIS produz dist/latest.yml com a
// versão, a url relativa do instalador e o sha512, e o workflow anexa esse
// arquivo e o .blockmap na GitHub Release. O que faltava era o cliente.
//
// Três guardas, e nenhuma delas é decorativa:
//
//  - Em desenvolvimento (`app.isPackaged` falso) não há instalador para
//    substituir: o electron-updater baixaria um .exe para um app rodando de
//    uma pasta de fontes, e a instalação não faria sentido.
//  - O build portable não se atualiza. Um .exe portátil não tem um diretório de
//    instalação para reescrever; ele é a cópia que o usuário carrega num
//    pendrive. A atualização automática aqui trocaria o arquivo que está em uso.
//  - Não pode instalar com trabalho rodando. O app é um agendador: fechar no
//    meio de um backup ou de uma sincronização deixa a operação pela metade.
//
// O feed é fixado explicitamente em vez de inferred do package.json: o
// usuário pode estar num fork, e um fork não deve baixar o binário de outro.
const { app, BrowserWindow } = require('electron');

const FEED_URL = 'https://github.com/L1NDS0N/KyriosKronou/releases/latest/download';

class UpdateManager {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.getVersion = options.getVersion || (() => app.getVersion());
    this.isPackaged = options.isPackaged === undefined ? app.isPackaged : options.isPackaged;
    this.isPortable = options.isPortable || null;
    this.hasRunningWork = options.hasRunningWork || (() => 0);
    this.quitAndInstall = options.quitAndInstall || null;
    this.autoUpdater = options.autoUpdater || null;
    // Pergunta ao Electron em vez de mantener uma lista à mão: a janela é criada
    // antes dos componentes existirem, e o aviso precisa chegar tanto na janela
    // aberta quanto numa que só existe na bandeja.
    this.getWindows = options.getWindows || (() => BrowserWindow.getAllWindows());
    this.state = { status: 'idle', version: '', percent: 0, error: '' };
  }

  log(level, message) { if (this.logger) this.logger.log(level, message); }

  /**
   * Por que a atualização não pode rodar agora, ou null quando pode.
   * Devolver o motivo em vez de um booleano é o que permite à tela explicar
   * "não há como atualizar a versão portátil" em vez de sumir em silêncio.
   */
  blockReason() {
    if (process.env.KYRION_SKIP_UPDATES === '1') return 'update.blockedEnv';
    if (!this.isPackaged) return 'update.blockedDev';
    // electron-packager define esta variável no portable; no instalador NSIS
    // ela não existe.
    if (this.isPortable === null ? Boolean(process.env.PORTABLE_EXECUTABLE_DIR) : this.isPortable) {
      return 'update.blockedPortable';
    }
    return null;
  }

  broadcast(payload) {
    const message = Object.assign({ channel: 'update:state' }, payload);
    let janelas = [];
    try { janelas = this.getWindows() || []; } catch (e) { janelas = []; }
    for (const win of janelas) {
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('update:state', message);
      }
    }
  }

  set(patch) {
    this.state = Object.assign({}, this.state, patch);
    this.broadcast(this.state);
    return this.state;
  }

  // Configurar é separado de obter: um autoUpdater injetado (nos testes) já
  // vem pronto, mas Continua precisando do feed e dos mesmos ouvintes. Pular
  // a configuração quando a instância já existia deixava o app silencioso:
  // sem feed não há consulta e sem ouvintes não há aviso no rodapé.
  configure(updater) {
    if (updater.__kyriosConfigured) return;
    updater.__kyriosConfigured = true;
    updater.autoDownload = false;   // o usuário decide, o rodapé só avisa
    updater.autoInstallOnAppQuit = false;
    updater.setFeedURL({ provider: 'generic', url: FEED_URL });

    updater.on('update-available', (info) => {
      this.log('INFO', `UPDATE_AVAILABLE version=${info && info.version}`);
      this.set({ status: 'available', version: (info && info.version) || '', percent: 0, error: '' });
    });
    updater.on('update-not-available', () => {
      this.set({ status: 'current', version: this.getVersion(), percent: 0, error: '' });
    });
    updater.on('download-progress', (progress) => {
      this.set({ status: 'downloading', percent: Math.round((progress && progress.percent) || 0) });
    });
    updater.on('update-downloaded', (info) => {
      this.set({ status: 'ready', version: (info && info.version) || this.getVersion(), percent: 100, error: '' });
    });
    updater.on('error', (err) => {
      this.log('ERROR', `UPDATE_ERROR ${err && err.message}`);
      this.set({ status: 'error', error: (err && err.message) || 'update.failed' });
    });
  }

  // Só o serviço de "atualização" (GitHubProvider) é carregado aqui, e mesmo
  // assim fora do desenvolvimento - no resto do app isso nunca é chamado.
  updater() {
    if (this.autoUpdater) {
      this.configure(this.autoUpdater);
      return this.autoUpdater;
    }
    // eslint-disable-next-line global-require
    const { autoUpdater } = require('electron-updater');
    this.configure(autoUpdater);
    this.autoUpdater = autoUpdater;
    return autoUpdater;
  }

  async check() {
    const blocked = this.blockReason();
    if (blocked) {
      this.set({ status: 'blocked', reason: blocked, error: '' });
      return Object.assign({ ok: false }, this.state);
    }
    try {
      this.set({ status: 'checking', error: '' });
      await this.updater().checkForUpdates();
      return Object.assign({ ok: true }, this.state);
    } catch (err) {
      // Uma conferência que falha não pode derrubar o app: o rodapé simplesmente
      // não mostra nada.
      this.set({ status: 'error', error: err.message || 'update.failed' });
      return { ok: false, status: 'error', error: err.message || 'update.failed' };
    }
  }

  async download() {
    if (this.blockReason()) return { ok: false, reason: this.blockReason() };
    if (this.state.status !== 'available' && this.state.status !== 'error') {
      return { ok: false, reason: 'update.nothingToDownload' };
    }
    try {
      this.set({ status: 'downloading', percent: 0, error: '' });
      await this.updater().downloadUpdate();
      return { ok: true, status: this.state.status };
    } catch (err) {
      this.set({ status: 'error', error: err.message || 'update.failed' });
      return { ok: false, error: err.message || 'update.failed' };
    }
  }

  /**
   * Instala e fecha. Recusa com trabalho em andamento: o app é o agendador e
   * sair no meio de um backup deixa a operação incompleta e o registro de
   * execução sem fim.
   */
  install() {
    const running = this.hasRunningWork() || 0;
    if (running > 0) return { ok: false, reason: 'update.busy', running };
    if (this.state.status !== 'ready') return { ok: false, reason: 'update.notReady' };
    this.log('INFO', `UPDATE_INSTALL version=${this.state.version}`);
    if (this.quitAndInstall) this.quitAndInstall();
    else this.updater().quitAndInstall();
    return { ok: true };
  }

  snapshot() {
    return Object.assign({ current: this.getVersion() }, this.state);
  }
}

module.exports = UpdateManager;
module.exports.UpdateManager = UpdateManager;
module.exports.FEED_URL = FEED_URL;
