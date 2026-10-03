// tests/test-main-startup.js
//
// O menu da bandeja virou função e sobrou código ajustando checkbox por índice
// na variável do menu antigo. O app não subia mais: "contextMenu is not
// defined", e nada pegou porque os testes de UI sobem o *renderer*, que nunca
// executa createTray.
//
// A suíte roda o processo main de verdade, sem abrir janela, e falha se ele não
// chegar ao ponto de dizer que está pronto.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main', 'main.js');

// Main sobe com app e as janelas de mentira. O que importa é que evaluate e
// não atire na cara antes de registrar os handlers.
const HARNESS = `
const Module = require('module');
const caminhoApp = ${JSON.stringify(path.join(ROOT, 'src', 'main', 'main.js'))};
const app = {
  isPackaged: false,
  getVersion: () => '0.0.0-test',
  getPath: (n) => require('path').join(process.cwd(), 'tmp-appdata', n),
  getLoginItemSettings: () => ({ openAtLogin: false }),
  setLoginItemSettings: () => {},
  on: () => {},
  once: () => {},
  quit: () => {},
  exit: () => {},
  requestSingleInstanceLock: () => true,
  whenReady: () => Promise.resolve(),
  commandLine: { appendSwitch: () => {} },
  getLocale: () => 'pt-BR',
  setAppUserModelId: () => {},
  dock: { hide() {}, show() {} },
};
const electron = {
  app,
  BrowserWindow: class { constructor() { this.webContents = { on() {}, send() {}, setWindowOpenHandler() {}, isDestroyed: () => false }; } loadFile() {} show() {} focus() {} on() {} once() {} isDestroyed() { return false; } isMinimized() { return false; } restore() {} },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} destroy() {} },
  Menu: { buildFromTemplate: (t) => ({ template: t, items: t }) },
  Notification: class { show() {} },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
  ipcMain: { handle: () => {} },
  dialog: { showErrorBox: () => {} },
  shell: { openExternal() {}, openPath() {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  powerMonitor: { on() {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, isMain, opts) {
  if (req === 'electron') return 'electron';
  return origResolve.call(this, req, parent, isMain, opts);
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return electron;
  return origLoad.call(this, req, parent, isMain);
};
process.env.KYRION_SKIP_UPDATES = '1';
try {
  require(caminhoApp);
  process.stdout.write('MAIN_LOADOU_OK');
} catch (e) {
  process.stdout.write('MAIN_FALHOU: ' + (e && e.message));
  process.stdout.write('\\n' + (e && e.stack || '').split('\\n').slice(0, 4).join('\\n'));
}
`;

describe('O processo main sobe', () => {
  it('carrega sem ReferenceError, que derrubaria o app inteiro', function () {
    this.timeout(60000);
    const r = spawnSync(process.execPath, ['-e', HARNESS], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 50000,
      env: Object.assign({}, process.env, { NODE_ENV: 'test' }),
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    expect(out, 'main.js deveria carregar sem erro').to.not.contain('MAIN_FALHOU');
    expect(out).to.contain('MAIN_LOADOU_OK');
  });

  it('a funcao que monta o menu da bandeja nao depende da variavel do menu antigo', () => {
    // O crash veio daqui: o menu virou funcao e sobrou contextMenu.items[n].
    // Um teste que le o fonte pega isso em vez de esperar o app nao subir.
    const src = fs.readFileSync(MAIN, 'utf8');
    // Sem os comentários: o que sobrou do crash está citado neles, e um teste
    // que lê o arquivo inteiro accusaria a própria explicação.
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(codigo, 'contextMenu nao existe mais desde que o menu virou função').to.not.match(/contextMenu\.items/);
    expect(src).to.include('function buildTrayMenu()');
  });

  it('nao ha nenhum item de menu ajustado por indice', () => {
    // Ajustar checkbox por posicao quebrava sozinho a cada item novo; o
    // menu agora le a config no momento em que e montado.
    const src = fs.readFileSync(MAIN, 'utf8');
    const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(codigo).to.not.match(/\.items\[\d+\]\.checked/);
  });
});
