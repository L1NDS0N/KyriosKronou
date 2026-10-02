// tests/test-tray-menu.js
//
// O menu da bandeja é montado no processo main e é a única interface que
// precisa funcionar com a janela escondida - que é justamente o estado em que
// ela é usada. Duas coisas quebraram aqui antes e nenhuma delas aparece em
// teste de renderer:
//
//  - Os rótulos eram literais de inglês dentro de um app em português. A bandeja
//    nunca viu o dicionário. Ela agora carrega o i18n.js do renderer e o idioma
//    chega pela preferência guardada na config, não pelo renderer, porque a
//    bandeja aparece antes da janela no autostart.
//  - "Run due tasks" rodava tudo num item só. A pessoa clicava sem saber o quê
//    e o backup de vinte minutos começava sem confirmação possível.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const trayI18n = require('../src/main/trayI18n');

const MAIN = read('src/main/main.js');

function achatar(template, prefix = '') {
  const linhas = [];
  const visitar = (itens, caminho) => {
    itens.forEach((item, i) => {
      const aqui = `${caminho}/${i}`;
      if (item.label !== undefined) linhas.push({ chave: aqui, label: String(item.label) });
      if (item.submenu) visitar(item.submenu, `${aqui}/sub`);
    });
  };
  visitar(template, prefix);
  return linhas;
}

// Recorta o corpo de uma função pelo proximo "function " de topo. createTray,
// createWindow e buildTrayMenu ficam em qualquer ordem no arquivo, e um slice
// por par de marcadores acaba pegando a função do meio sem querer.
function corpo(inicio) {
  const a = MAIN.indexOf(inicio);
  expect(a, `marcador nao encontrado: ${inicio}`).to.be.above(-1);
  const proxima = MAIN.indexOf('\nfunction ', a + 1);
  return proxima < 0 ? MAIN.slice(a) : MAIN.slice(a, proxima);
}

describe('Menu da bandeja: os itens', () => {
  it('e montado por uma função, e nao mais inline na criacao', () => {
    expect(MAIN).to.include('function buildTrayMenu()');
    // O menu inline era um array de 40 linhas dentro de createTray: não dava
    // para testar nada dele.
    const criar = corpo('function createTray()');
    expect(criar).to.include('buildTrayMenu()');
    expect(criar).not.to.include('Menu.buildFromTemplate');
  });

  it('expõe o que já existe no app, não botões decorativos', () => {
    // Cada item precisa chamar algo de verdade. Um item que só mostra texto é
    // pior do que a ausência dele: a pessoa clica e nada acontece.
    const b = corpo('function buildTrayMenu()');
    for (const acao of ['taskManager.executeTask', 'runDueTasksFromTray',
      'backupManager.executeBackup', 'retentionManager.runProfile', 'updateManager.check']) {
      expect(b, acao).to.include(acao);
    }
  });

  it('lista as tarefas vencidas pelo nome, e não só "rode tudo"', () => {
    // Um item único e irreversível é o pior formato para uma ação que roda
    // trabalho de verdade.
    const b = corpo('function buildTrayMenu()');
    expect(b).to.include('vencidas.map');
    expect(b).to.include('task.Name || task.Id');
    // E o item que roda todas continua existindo, abaixo de um separador.
    expect(b).to.include('tray.runDue');
  });

  it('limita a lista e resume o resto, porque um menu de 40 itens nao e um menu', () => {
    const b = corpo('function listaLimitada');
    expect(b).to.include('limite');
    expect(b).to.include('+${resto.length}');
  });

  it('cada item do submenu e seguro quando o componente ainda nao existe', () => {
    // A bandeja é criada antes de initComponents terminar; um manager undefined
    // derrubaria o app inteiro em vez de mostrar um item vazio.
    const b = corpo('function buildTrayMenu()');
    expect(b).to.include('taskManager ? taskManager.getDueTasks() : []');
    expect(b).to.include('backupManager ? backupManager.getAllProfiles() : []');
    expect(b).to.include('retentionManager ? retentionManager.getAllProfiles() : []');
  });

  it('atualiza o menu depois de rodar algo, para o que esta rodando aparecer', () => {
    expect(MAIN).to.include('function refreshTrayMenu()');
    expect(MAIN).to.include('refreshTrayMenu();');
  });
});

describe('Menu da bandeja: idioma', () => {
  it('a bandeja le o mesmo dicionario da janela', () => {
    // Antes os rótulos eram literais em inglês: a única interface do app que
    // não falava a língua do usuário.
    expect(MAIN).to.include("require('./trayI18n')");
    expect(MAIN).to.not.match(/label:\s*'(Show Window|Quick Actions|Run Due Tasks|Exit)'/);
  });

  it('o idioma vem da config no arranque, nao so do renderer', () => {
    // No autostart minimizado a bandeja aparece antes da janela; se o idioma
    // só chegasse pelo renderer, o primeiro menu veria seria em inglês.
    const criar = corpo('function createTray()');
    expect(criar).to.include("trayI18n.setLang(config ? config.getSetting('Language', 'en') : 'en')");
  });

  it('trocar o idioma na tela reconstroi o menu', () => {
    expect(MAIN).to.include("ipcMain.handle('set-ui-language'");
    expect(read('src/renderer/app.js')).to.include('setUiLanguage');
    expect(read('src/main/preload.js')).to.include('setUiLanguage');
  });

  it('o carregador devolve o mesmo texto dos dois idiomas', () => {
    trayI18n.setLang('pt-BR');
    const pt = trayI18n.t('tray.show');
    trayI18n.setLang('en');
    const en = trayI18n.t('tray.show');
    expect(pt).to.be.a('string').and.not.equal(en);
    expect(en.toLowerCase()).to.contain('open');
    trayI18n.setLang('en');
  });

  it('substitui os placeholders, com o mesmo {{chave}} do resto do app', () => {
    // Uma chave com {v} simples passaria pelo teste de "existe nos dois
    // idiomas" e imprimiria "{v}" literalmente na bandeja.
    trayI18n.setLang('pt-BR');
    expect(trayI18n.t('tray.updateAvailable', { v: '1.2.3' })).to.contain('1.2.3');
    expect(trayI18n.t('tray.updateAvailable', { v: '1.2.3' })).to.not.contain('{');
  });

  it('devolve a chave quando a traducao nao existe, em vez de quebrar', () => {
    expect(trayI18n.t('tray.naoExiste')).to.equal('tray.naoExiste');
  });
});

describe('Menu da bandeja: navegacao e recursos', () => {
  it('abre a janela na aba certa, e o renderer escuta', () => {
    // Sem o listener no renderer o item funciona, a janela abre e a pessoa cai
    // no painel sem saber onde procurou.
    expect(MAIN).to.include("mainWindow.webContents.send('navigate-to', page)");
    expect(read('src/renderer/app.js')).to.include("window.addEventListener('navigate-to'");
  });

  it('minimizado volta para o tamanho normal, e nao fica atras da barra', () => {
    expect(MAIN).to.include('if (mainWindow.isMinimized()) mainWindow.restore()');
  });

  it('oferece atalho para as pastas que o usuario procura quando algo falha', () => {
    const b = corpo('function buildTrayMenu()');
    expect(b).to.include('tray.openLogs');
    expect(b).to.include('shell.openPath');
  });

  it('nao instala nem desinstala nada pelo menu', () => {
    // Instalar serviço e serviço do Windows com elevação não é uma coisa que
    // deva acontecer por um clique acidental num menu de bandeja.
    const b = corpo('function buildTrayMenu()');
    for (const perigoso of ['install-kyrion-service', 'uninstall-kyrion-service', 'install-service']) {
      expect(b, perigoso).to.not.include(perigoso);
    }
  });
});

describe('Contrato IPC: os canais novos da bandeja', () => {
  it('set-ui-language tem par dos dois lados', () => {
    expect(MAIN).to.include("ipcMain.handle('set-ui-language'");
    expect(read('src/main/preload.js')).to.include("invoke('set-ui-language'");
  });

  it('navigate-to e consumido pelo renderer', () => {
    expect(MAIN).to.include("send('navigate-to'");
    expect(read('src/renderer/app.js')).to.include('navigate-to');
  });
});