// tests/test-tray-menu-runtime.js
//
// O teste anterior só lia o fonte do menu. Este executa a função de verdade,
// com o Electron simulado, e olha a árvore de itens que sai - que é a única
// forma de provar que o menu monta e não quebra em runtime.
//
// Extrair a função e rodá-la num vm é o que permite testar o main sem subir o
// Electron: main.js faz require('electron') e costura metade da aplicação no
// load, e não dá para carregá-lo num require comum.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
const trayI18n = require('../src/main/trayI18n');

function extrair(inicio) {
  const a = MAIN.indexOf(inicio);
  expect(a, `nao achei ${inicio}`).to.be.above(-1);
  const b = MAIN.indexOf('\nfunction ', a + 1);
  return MAIN.slice(a, b < 0 ? MAIN.length : b);
}

// Monta as mesmas funcoes com o Electron falso e as dependencias do main.
function montar(opcoes = {}) {
  const chamadas = [];
  const estado = { template: null };

  const contexto = {
    console,
    Menu: {
      buildFromTemplate(t) {
        estado.template = t;
        return { template: t };
      },
    },
    trayI18n,
    taskManager: opcoes.taskManager || {
      getDueTasks: () => opcoes.vencidas || [],
      executeTask: async (t) => { chamadas.push(['executeTask', t.Id]); return { Success: true }; },
    },
    backupManager: opcoes.backupManager || {
      getAllProfiles: () => opcoes.backups || [],
      executeBackup: async (id) => { chamadas.push(['backup', id]); return { ok: true }; },
    },
    retentionManager: opcoes.retentionManager || {
      getAllProfiles: () => opcoes.retencoes || [],
      runProfile: async (id) => { chamadas.push(['retention', id]); return { ok: true }; },
    },
    runs: opcoes.runs || { active: () => opcoes.ativos || [] },
    config: opcoes.config || {
      getSetting: (k, d) => (opcoes.settings && opcoes.settings[k] !== undefined ? opcoes.settings[k] : d),
      setSetting: () => {},
      save: () => {},
    },
    app: { getLoginItemSettings: () => ({ openAtLogin: false }), quit: () => {} },
    updateManager: opcoes.updateManager || { check: async () => ({ ok: false, reason: 'update.blockedDev' }) },
    logger: opcoes.logger || { auditSettingsChanged: () => {}, auditTaskExecuted: () => {} },
    shell: { openPath: async () => {} },
    paths: { ensureDirs: () => ({ logsDir: 'C:\\logs', configDir: 'C:\\cfg' }) },
    applyLoginItem() {},
    // mainWindow é uma variável de topo do main, e showWindow a usa direto. Sem
    // declará-la no vm, clicar em qualquer item que abra a janela estoura um
    // ReferenceError - exatamente o que aconteceria em runtime.
    // mainWindow e createWindow são do topo do main. showWindow usa as duas, e
    // sem declará-las no vm clicar em qualquer item que abra a janela estoura um
    // ReferenceError - o que aconteceria em runtime.
    mainWindow: opcoes.janelaExistente === false ? null : {
      isMinimized: () => false,
      restore() { chamadas.push(['restore']); },
      show() { chamadas.push(['show']); },
      focus() { chamadas.push(['focus']); },
      webContents: { send: (canal, arg) => chamadas.push(['send', canal, arg]) },
    },
    createWindow() { chamadas.push(['createWindow']); },
    runDueTasksFromTray() { chamadas.push(['runDue']); },
    sendTaskNotification() {},
    showWindow(page) { chamadas.push(['show', page]); },
    notifyTray(title, body) { chamadas.push(['notify', title, body]); },
    refreshTrayMenu() { chamadas.push(['refresh']); },
    isQuitting: false,
    setTimeout,
  };
  contexto.window = contexto;
  vm.createContext(contexto);

  const fonte = [
    extrair('function showWindow(page)'),
    extrair('function notifyTray(title, body)'),
    extrair('function refreshTrayMenu()'),
    extrair('function listaLimitada(itens, vazio, limite'),
    extrair('function buildTrayMenu()'),
  ].join('\n\n');
  vm.runInContext(fonte, contexto);
  // "function" num contexto vm é escopo léxico: não vira propriedade do
  // contexto. Sem expor explicitamente, buildTrayMenu fica inacessível de fora
  // e todo teste passa por cima de um null.
  vm.runInContext(';this.__buildTrayMenu = buildTrayMenu;', contexto);
  contexto.buildTrayMenu = contexto.__buildTrayMenu;

  return {
    menu: () => contexto.buildTrayMenu(),
    // estado e um objeto do lado de fora do vm: um let do contexto de fora nao
    // é a mesma variavel que o codigo dentro do vm atribui, e o template
    // voltaria null sempre.
    template: () => { contexto.buildTrayMenu(); return estado.template; },
    chamadas,
  };
}

function achatar(template, prefix = '') {
  const saida = [];
  template.forEach((item, i) => {
    const chave = `${prefix}${i}`;
    if (item.label !== undefined) saida.push({ chave, label: String(item.label), item });
    if (item.submenu) achatar(item.submenu, `${chave}.`).forEach((s) => saida.push(s));
  });
  return saida;
}

function acharSubmenu(template, fragmento) {
  return template.find((i) => i.submenu && String(i.label).toLowerCase().includes(fragmento));
}

describe('Menu da bandeja: monta de verdade', () => {
  beforeEach(() => trayI18n.setLang('pt-BR'));
  it('constroi um template sem erro, mesmo sem nenhum componente pronto', () => {
    // A bandeja é criada antes de initComponents terminar. Um manager
    // undefined aqui derrubaria o app inteiro.
    const m = montar({ taskManager: null, backupManager: null, retentionManager: null, runs: null, config: null, updateManager: null });
    const t = m.template();
    expect(t).to.be.an('array').with.length.above(5);
  });

  it('lista as tarefas vencidas pelo nome e executa a escolhida', () => {
    const m = montar({ vencidas: [{ Id: 't1', Name: 'Backup do banco' }, { Id: 't2', Name: 'Limpeza' }] });
    const t = m.template();
    const sub = acharSubmenu(t, 'vencidas');
    expect(sub, 'o item "executar tarefas vencidas" tem submenu').to.not.equal(undefined);

    const porNome = achatar(sub.submenu).filter((i) => i.label === 'Backup do banco');
    expect(porNome).to.have.lengthOf(1);

    porNome[0].item.click();
    expect(m.chamadas).to.deep.include(['executeTask', 't1']);
  });

it('cada item de acao chama algo de verdade, nenhum e decorativo', () => {
    const m = montar({
      vencidas: [{ Id: 't1', Name: 'A' }],
      backups: [{ Id: 'b1', Name: 'MySQL' }],
      retencoes: [{ Id: 'r1', Name: 'Logs antigos' }],
    });
    const todos = achatar(m.template())
      .filter((i) => i.item.type !== 'separator' && i.item.enabled !== false)
      // Um item que abre um submenu não tem click: ele só abre. A regra vale
      // para quem age diretamente.
      .filter((i) => !i.item.submenu);
    expect(todos.length, 'todo item que age diretamente precisa ter um click').to.be.above(4);
    for (const { label, item } of todos) {
      expect(item.click, `item sem acao: ${label}`).to.be.a('function');
    }
  });

  it('o submenu de backup roda o perfil escolhido', () => {
    const m = montar({ backups: [{ Id: 'b7', Name: 'MySQL diario' }] });
    const sub = acharSubmenu(m.template(), 'backup');
    expect(sub).to.not.equal(undefined);
    achatar(sub.submenu).find((i) => i.label === 'MySQL diario').item.click();
    expect(m.chamadas).to.deep.include(['backup', 'b7']);
  });

  it('resume a lista longa em vez de listar 40 itens', () => {
    const muitos = Array.from({ length: 15 }, (_, i) => ({ Id: `b${i}`, Name: `Perfil ${i}` }));
    const m = montar({ backups: muitos });
    const sub = acharSubmenu(m.template(), 'backup');
    const itens = achatar(sub.submenu);
    // 8 visíveis, um separador e o resumo do resto.
    expect(itens.length).to.be.at.most(11);
    expect(itens.some((i) => /^\+\d+$/.test(i.label)), 'o resto aparece resumido').to.equal(true);
  });

  it('mostra o que esta rodando agora, que e como a pessoa acha um backup longo', () => {
    const m = montar({ ativos: [{ runId: 'x1', targetId: 't1', name: 'Backup do banco' }] });
    const sub = acharSubmenu(m.template(), 'executando agora');
    expect(sub, 'o submenu de "executando agora" existe').to.not.equal(undefined);
    expect(achatar(sub.submenu).some((i) => i.label.includes('Backup do banco'))).to.equal(true);
  });

  it('esconde "executando agora" quando nada roda', () => {
    const m = montar({ ativos: [] });
    expect(acharSubmenu(m.template(), 'executando agora')).to.equal(undefined);
  });

  it('navegar pela bandeja abre a aba pedida', () => {
    // Com a janela já aberta - o caso comum, a pessoa está no tray com o app
    // minimizado - o clique mostra, foca e manda para a aba via navigate-to.
    const m = montar({ janelaExistente: true });
    const rede = achatar(m.template()).find((i) => /sincronismo|rede de/i.test(i.label));
    expect(rede, 'o item da rede existe').to.not.equal(undefined);
    rede.item.click();
    expect(m.chamadas, 'manda navigate-to com a aba').to.deep.include(['send', 'navigate-to', 'network']);
    expect(m.chamadas.map((c) => c[0]), 'não recria a janela que já existe').to.not.include('createWindow');
  });

  it('sem janela aberta, cria uma em vez de fazer nada', () => {
    const m = montar({ janelaExistente: false });
    achatar(m.template()).find((i) => /sincronismo|rede de/i.test(i.label)).item.click();
    expect(m.chamadas.map((c) => c[0])).to.include('createWindow');
  });
});

describe('Menu da bandeja: idioma, no menu montado', () => {
  afterEach(() => trayI18n.setLang('en'));
  it('todos os rotulos saem traduzidos, sem nenhum literal em ingles', () => {
    trayI18n.setLang('pt-BR');
    const m = montar();
    const labels = achatar(m.template()).map((i) => i.label);
    // Palavras que são iguais nos dois idiomas não dizem nada: "Backups" é
    // "Backups" em português também. O que accuse texto solto é um rótulo que
    // SÓ existe em inglês.
    const soEmIngles = [
      /^show window$/i, /^quick actions$/i, /^run due tasks$/i, /^exit$/i,
      /^open window$/i, /^start with windows$/i, /^minimize to tray on close$/i,
      /^check for updates$/i, /^nothing due right now$/i, /^no backup profiles$/i,
    ];
    const intrusos = labels.filter((l) => soEmIngles.some((rx) => rx.test(l)));
    expect(intrusos, 'rotulos em ingles: ' + intrusos.join(' | ')).to.deep.equal([]);
    expect(labels.some((l) => l.includes('Sair')), 'Sair presente em pt').to.equal(true);
    expect(labels.some((l) => l.includes('Configurações')), 'Configurações presente em pt').to.equal(true);
  });

  it('trocar o idioma troca o menu inteiro', () => {
    trayI18n.setLang('en');
    const en = achatar(montar().template()).map((i) => i.label);
    trayI18n.setLang('pt-BR');
    const pt = achatar(montar().template()).map((i) => i.label);
    expect(en).to.not.deep.equal(pt);
    trayI18n.setLang('en');
  });
});