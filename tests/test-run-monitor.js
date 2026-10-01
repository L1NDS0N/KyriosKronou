// tests/test-run-monitor.js
//
// runMonitor é o rodapé que mostra o que está rodando e o log da execução. Não
// tinha teste nenhum, e é o ponto onde a saída de um processo - que o usuário
// não controla - vira DOM.
//
// A saída de um script é o pior lugar para confiar: um backup que imprime
// "<img onerror=...>" não pode virar elemento. Aqui isso é fixado.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'runMonitor.js'), 'utf8');

// DOM mínimo, com os ids que o rodapé escreve para poder conferir o texto.
function harness() {
  const elementos = new Map();
  function criaEl(tag) {
    let _html;
    return {
      tagName: tag,
      className: '',
      _text: '',
      children: [],
      checked: true,
      scrollTop: 0,
      scrollHeight: 100,
      appendChild(c) { this.children.push(c); return c; },
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k]; },
      addEventListener() {},
      removeEventListener() {},
      // refreshSummary escreve classList nos contadores; sem isso o TypeError
      // cai no catch e o teste passa a medir nada.
      classList: { _set: new Set(), add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); }, toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); }, contains(c) { return this._set.has(c); } },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = v == null ? '' : String(v); _html = undefined; },
      // O esc() do módulo depende de createElement().innerHTML reflecting
      // textContent, como o navegador faz. Sem isso o badge saía com o
      // atributo vazio e o teste mediria um dublê, não o componente.
      get innerHTML() {
        return this._html !== undefined ? this._html
          : this._text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      },
      set innerHTML(v) { this._html = v == null ? '' : String(v); this._text = ''; },
    };
  }
  for (const id of ['sb-tasks-value', 'sb-backups-value', 'sb-fails-value', 'sb-next-value',
    'sb-tasks', 'sb-backups', 'sb-fails', 'sb-next', 'sb-next-dot',
    'rv-name', 'rv-meta', 'rv-status', 'rv-pct', 'rv-steps', 'rv-log', 'rv-follow',
    'sb-runs', 'sb-runs-label', 'sb-runs-dot']) {
    elementos.set(id, criaEl(id));
  }

  const document = {
    _elementos: elementos,
    createElement: (tag) => criaEl(tag),
    getElementById: (id) => elementos.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    dispatchEvent() {},
    readyState: 'complete',
  };

  const api = {
    getActiveRuns: async () => [],
    // A execução do main empurra a lista por aqui; guardar o callback é o
    // caminho real que popula as execuções ativas.
    onRunsChanged(cb) { this._onRunsChanged = cb; },
    getTasks: async () => [],
    getBackupProfiles: async () => [],
    getHistory: async () => [],
    getBackupHistory: async () => ({ history: [] }),
    getTasksWithSchedules: async () => [],
    getBackupProfilesWithSchedules: async () => [],
  };

  const contexto = {
    document,
    i18n: { t: (k) => k },
    console,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    CustomEvent: function C(type, init) { this.type = type; this.detail = init && init.detail; },
    lucide: { createIcons() {} },
    showToast() {},
  };
  // O IIFE recebe `window` e escreve global.RunMonitor. O mesmo objeto precisa
  // estar nos dois lugares, senão a exportação some do contexto do vm.
  contexto.window = contexto;
  contexto.document = document;
  contexto.addEventListener = () => {};
  contexto.api = api;
  vm.createContext(contexto);
  vm.runInContext(SOURCE, contexto);
  const RunMonitor = contexto.RunMonitor;
  RunMonitor.init();
  return { RunMonitor, api, document, contexto };
}

// O caminho real da tela: o main empurra a lista de execuções pelo callback
// registrado em onRunsChanged.
function comExecucoes(h, runs) {
  h.api._onRunsChanged(runs);
  return h;
}

describe('RunMonitor: a saída do processo vira texto, nunca markup', () => {
  it('escreve cada linha de log com textContent', () => {
    // A defesa que importa: textContent não interpreta HTML, então qualquer
    // coisa que o script imprima continua sendo texto.
    expect(SOURCE).to.include('el.textContent = line.text');
  });

  it('não monta linha de log por concatenação em innerHTML', () => {
    const bloco = SOURCE.slice(SOURCE.indexOf('for (const line of detail.lines)'));
    expect(bloco.slice(0, 500)).to.not.match(/innerHTML\s*=\s*line\./);
    expect(bloco.slice(0, 500)).to.not.match(/innerHTML\s*\+?=\s*`/);
  });

  it('escapa rótulo e detalhe de cada passo', () => {
    // Um passo nomeia o banco de dados do perfil; passo com HTML viraria
    // elemento.
    const bloco = SOURCE.slice(SOURCE.indexOf("$('rv-steps')"), SOURCE.indexOf('// Append only'));
    expect(bloco).to.include('esc(s.label)');
    expect(bloco).to.include('esc(s.detail)');
  });

  it('escapa identificador de execução e rótulo no badge', () => {
    expect(SOURCE).to.include('esc(run.runId)');
  });

  it('usa textContent para o nome e os metadados da execução', () => {
    expect(SOURCE).to.include("$('rv-name').textContent = detail.name");
  });
});

describe('RunMonitor: o badge de execução', () => {
  it('some quando não há nada rodando', () => {
    const { RunMonitor, api } = harness();
    api.getActiveRuns = async () => [];
    return RunMonitor.refreshSummary().then(() => {
      expect(RunMonitor.runningBadge('task-1')).to.equal('');
    });
  });

  it('traz o id de execução para que o clique possa observar', () => {
    const h = harness();
    // Quem popula a lista de execuções ativas é o evento do main, não o
    // resumo do rodapé: são dois caminhos distintos.
    comExecucoes(h, [{ targetId: 'task-1', runId: 'run-7', percent: 40 }]);
    const badge = h.RunMonitor.runningBadge('task-1');
    expect(badge).to.contain('data-watch-run="run-7"');
    expect(badge).to.contain('40%');
  });

  it('não deixa um id de execução com aspas fechar o atributo', () => {
    const h = harness();
    comExecucoes(h, [{ targetId: 'task-1', runId: 'a" onmouseover="alert(1)', percent: 10 }]);
    const badge = h.RunMonitor.runningBadge('task-1');
    expect(badge).to.not.match(/onmouseover="alert/);
    expect(badge).to.contain('&quot;');
  });
});

describe('RunMonitor: o resumo do rodapé', () => {
  it('não estoura quando a resposta do main vem vazia', async () => {
    const { RunMonitor, api } = harness();
    api.getActiveRuns = async () => [];
    api.getTasks = async () => [];
    api.getBackupProfiles = async () => [];
    api.getTasksWithSchedules = async () => [];
    api.getBackupProfilesWithSchedules = async () => [];
    await RunMonitor.refreshSummary();
    expect(RunMonitor.activeRuns).to.deep.equal([]);
  });

  it('conta as habilitadas sobre o total, em tarefas e perfis', async () => {
    const { RunMonitor, api, document } = harness();
    api.getTasks = async () => [{ Id: 't1', Enabled: false }, { Id: 't2' }];
    api.getBackupProfiles = async () => [{ Id: 'b1', Enabled: true }, { Id: 'b2', Enabled: false }];
    api.getHistory = async () => [];
    api.getBackupHistory = async () => ({ history: [] });
    await RunMonitor.refreshSummary();
    expect(document.getElementById('sb-tasks-value').textContent).to.equal('1/2');
    expect(document.getElementById('sb-backups-value').textContent).to.equal('1/2');
  });

  it('conta falhas das últimas 24h, de tarefa e de backup', async () => {
    const { RunMonitor, api, document } = harness();
    const agora = new Date().toISOString();
    const antigo = new Date(Date.now() - 3 * 86400000).toISOString();
    api.getTasks = async () => [];
    api.getBackupProfiles = async () => [];
    api.getHistory = async () => [
      { Status: 'Error', Timestamp: agora },
      { Status: 'Error', Timestamp: antigo },
      { Status: 'Success', Timestamp: agora },
    ];
    api.getBackupHistory = async () => ({ history: [{ Status: 'Error', Timestamp: agora }] });
    await RunMonitor.refreshSummary();
    expect(document.getElementById('sb-fails-value').textContent).to.equal('2');
  });
});