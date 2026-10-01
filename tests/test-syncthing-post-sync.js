// tests/test-syncthing-post-sync.js
//
// O gatilho é a transição para completo, não o estado. Disparar enquanto a
// pasta já está em 100% transformaria a tarefa em periódica, e uma pasta
// parada que reencontrasse 100% dispararia de novo a cada tique.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PostSyncBridge, normalizeTargets, normalizePreTargets, COMPLETE } = require('../src/main/syncthing/postSync');

const FOLDER = 'docs-abc';
const TASK = 'task-1';

// O cooldown passou a ser consultado no disco, compartilhado entre GUI e
// serviço. Cada teste precisa do seu próprio diretório, senão o carimbo de um
// teste segura o gatilho do seguinte.
let raizDeTeste;

function bridge(options = {}) {
  return new PostSyncBridge(Object.assign({ minIntervalMs: 300000 }, options));
}

beforeEach(() => {
  raizDeTeste = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-hook-'));
  process.env.KYRION_DATA_DIR = raizDeTeste;
});

afterEach(() => {
  try { fs.rmSync(raizDeTeste, { recursive: true, force: true }); } catch (e) { /* já sumiu */ }
  delete process.env.KYRION_DATA_DIR;
});

// O `needItems` é o que distingue "parada" de "tem trabalho": a completion fica
// em 100 durante uma transferência longa, então só ele diz se há o que fazer.
function fakeClient(completion, needItems = 0) {
  return { dbCompletion: async () => ({ completion, needItems, needBytes: 0 }) };
}

function fakeTaskManager(log, enabled = true) {
  return {
    getTask: () => ({ Id: TASK, Name: 'Tarefa', Enabled: enabled }),
    executeTask: async (task) => { log.push(task.Id); return { Success: true }; },
  };
}

describe('Rede de sincronismo: tarefas pos-sincronismo', () => {
  it('so considera pastas que tem tarefa associada', () => {
    const targets = normalizeTargets([
      { id: FOLDER, PostSyncTaskId: TASK },
      { id: 'sem-tarefa' },
      { id: '', PostSyncTaskId: TASK },
      null,
    ]);
    expect(targets).to.have.length(1);
    expect(targets[0]).to.include({ folderId: FOLDER, taskId: TASK });
  });

  it('nao dispara na primeira leitura, antes de existir uma transicao', () => {
    const b = bridge();
    expect(b.dueFor({ folderId: FOLDER, taskId: TASK }, COMPLETE, 1000)).to.equal(null);
  });

  it('dispara ao passar de incompleto para completo', () => {
    const b = bridge();
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 40, 1000);
    const due = b.dueFor({ folderId: FOLDER, taskId: TASK }, COMPLETE, 2000);
    expect(due).to.not.equal(null);
    expect(due.taskId).to.equal(TASK);
  });

  it('nao repete enquanto a pasta continua completa', () => {
    const b = bridge();
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 40, 1000);
    expect(b.dueFor({ folderId: FOLDER, taskId: TASK }, COMPLETE, 2000)).to.not.equal(null);
    expect(b.dueFor({ folderId: FOLDER, taskId: TASK }, COMPLETE, 3000)).to.equal(null);
    expect(b.dueFor({ folderId: FOLDER, taskId: TASK }, COMPLETE, 4000)).to.equal(null);
  });

  it('ignora uma pasta que nunca sincronizou', () => {
    const b = bridge();
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 10, 1000);
    expect(b.dueFor({ folderId: FOLDER, taskId: TASK }, 90, 2000)).to.equal(null);
  });

  it('nao deixa duas Folderes se confundirem no estado', () => {
    const b = bridge();
    b.dueFor({ folderId: 'a', taskId: TASK }, 10, 1000);
    b.dueFor({ folderId: 'b', taskId: TASK }, 10, 1000);
    expect(b.dueFor({ folderId: 'a', taskId: TASK }, COMPLETE, 2000)).to.not.equal(null);
    expect(b.dueFor({ folderId: 'b', taskId: TASK }, COMPLETE, 2000)).to.not.equal(null);
  });
});

describe('Rede de sincronismo: tarefas pre-sincronismo', () => {
  it('so considera pastas que tem tarefa de pre associada', () => {
    const targets = normalizePreTargets([
      { id: FOLDER, PreSyncTaskId: TASK },
      { id: 'so-pos', PostSyncTaskId: TASK },
      { id: '', PreSyncTaskId: TASK },
      null,
    ]);
    expect(targets).to.have.length(1);
    expect(targets[0]).to.include({ folderId: FOLDER, taskId: TASK });
  });

  it('dispara já na primeira leitura se houver trabalho pendente', () => {
    // Diferente do pós, aqui a primeira leitura NÃO é só referência: se o
    // Kyrios sobe com a pasta já pendente, essa é justamente a hora de gerar
    // o que a sincronização precisa. Esperar uma transição de "parada para
    // com trabalho" deixaria a tarefa nunca rodando depois de um reinício.
    const b = bridge();
    expect(b.preDueFor({ folderId: FOLDER, taskId: TASK }, 5, 1000)).to.not.equal(null);
  });

  it('nao dispara na primeira leitura quando a pasta já está parada', () => {
    const b = bridge();
    expect(b.preDueFor({ folderId: FOLDER, taskId: TASK }, 0, 1000)).to.equal(null);
  });

  it('dispara quando a pasta passa a ter trabalho', () => {
    const b = bridge();
    b.preDueFor({ folderId: FOLDER, taskId: TASK }, 0, 1000);
    const due = b.preDueFor({ folderId: FOLDER, taskId: TASK }, 12, 2000);
    expect(due).to.not.equal(null);
    expect(due.taskId).to.equal(TASK);
  });

  it('nao repete enquanto a pasta continuar com trabalho', () => {
    // Uma transferencia longa tem needItems > 0 durante minutos; sem isto a
    // tarefa de pre rodaria a cada tique.
    const b = bridge();
    b.preDueFor({ folderId: FOLDER, taskId: TASK }, 0, 1000);
    expect(b.preDueFor({ folderId: FOLDER, taskId: TASK }, 12, 2000)).to.not.equal(null);
    expect(b.preDueFor({ folderId: FOLDER, taskId: TASK }, 8, 3000)).to.equal(null);
    expect(b.preDueFor({ folderId: FOLDER, taskId: TASK }, 3, 4000)).to.equal(null);
  });

  it('volta a ter trabalho de novo e dispara outra vez', () => {
    const b = bridge();
    b.preDueFor({ folderId: FOLDER, taskId: TASK }, 0, 1000);
    b.preDueFor({ folderId: FOLDER, taskId: TASK }, 5, 2000);
    b.preDueFor({ folderId: FOLDER, taskId: TASK }, 0, 3000);
    expect(b.preDueFor({ folderId: FOLDER, taskId: TASK }, 7, 4000)).to.not.equal(null);
  });

  it('nao dispara quando a pasta esta parada, mesmo que o filtro exija o contrario', () => {
    const b = bridge();
    expect(b.preDueFor({ folderId: FOLDER, taskId: TASK }, 0, 1000)).to.equal(null);
    expect(b.preDueFor({ folderId: FOLDER, taskId: TASK }, 0, 2000)).to.equal(null);
  });

  it('nao deixa uma pasta com pre misturar o estado de outra', () => {
    const b = bridge();
    b.preDueFor({ folderId: 'a', taskId: TASK }, 0, 1000);
    b.preDueFor({ folderId: 'b', taskId: TASK }, 0, 1000);
    expect(b.preDueFor({ folderId: 'a', taskId: TASK }, 4, 2000)).to.not.equal(null);
    expect(b.preDueFor({ folderId: 'b', taskId: TASK }, 4, 2000)).to.not.equal(null);
  });
});

describe('Rede de sincronismo: execucao da tarefa pre-sincronismo', () => {
  it('executa a tarefa antes de qualquer coisa da pasta', async () => {
    const executadas = [];
    const b = bridge({ taskManager: fakeTaskManager(executadas) });
    const out = await b.check(fakeClient(50, 7), [{ id: FOLDER, PreSyncTaskId: TASK }]);
    expect(out.preFired).to.have.length(1);
    expect(out.preFired[0].result.ok).to.equal(true);
    expect(executadas).to.deep.equal([TASK]);
    expect(out.fired).to.deep.equal([]);
  });

  it('respeita uma tarefa de pre desabilitada', async () => {
    let ran = false;
    const b = bridge({ taskManager: { getTask: () => ({ Id: TASK, Enabled: false }), executeTask: async () => { ran = true; } } });
    const out = await b.check(fakeClient(50, 7), [{ id: FOLDER, PreSyncTaskId: TASK }]);
    expect(ran).to.equal(false);
    expect(out.preFired[0].result.reason).to.equal('postSync.taskDisabled');
  });

  it('nao dispara quando a pasta esta completa e parada', async () => {
    let ran = false;
    const b = bridge({ taskManager: { getTask: () => ({ Id: TASK, Enabled: true }), executeTask: async () => { ran = true; } } });
    const out = await b.check(fakeClient(COMPLETE, 0), [{ id: FOLDER, PreSyncTaskId: TASK }]);
    expect(out.preFired).to.deep.equal([]);
    expect(ran).to.equal(false);
  });

  it('registra a execucao com a fase, para o log dizer de onde veio', async () => {
    const iniciadas = [];
    const b = bridge({
      taskManager: fakeTaskManager([]),
      runRegistry: { start: (meta) => { iniciadas.push(meta); return 'run-1'; }, finish: () => {}, failStep: () => {} },
    });
    await b.check(fakeClient(50, 3), [{ id: FOLDER, PreSyncTaskId: TASK }]);
    expect(iniciadas[0].kind).to.equal('sync:pre');
  });

  it('pausa a pasta quando a tarefa de pre falha e ela e bloqueante', async () => {
    // Este e o que da poder real a tarefa de pre: sem isso ela roda e nao
    // muda nada, e "gere o dump e so mande se deu certo" seria decorativo.
    const b = bridge({
      preBlocksSync: true,
      taskManager: { getTask: () => ({ Id: TASK, Enabled: true }), executeTask: async () => { throw new Error('dump falhou'); } },
    });
    const pausadas = [];
    const client = Object.assign(fakeClient(50, 4), {
      patchFolder: async (id, patch) => { pausadas.push({ id, patch }); },
    });
    const out = await b.check(client, [{ id: FOLDER, PreSyncTaskId: TASK }]);
    expect(out.blocked).to.deep.equal([FOLDER]);
    expect(pausadas[0]).to.deep.equal({ id: FOLDER, patch: { paused: true } });
  });

  it('nao pausa a pasta quando a tarefa de pre teve sucesso', async () => {
    const b = bridge({ preBlocksSync: true, taskManager: fakeTaskManager([]) });
    const pausadas = [];
    const client = Object.assign(fakeClient(50, 4), {
      patchFolder: async (id, patch) => { pausadas.push({ id, patch }); },
    });
    const out = await b.check(client, [{ id: FOLDER, PreSyncTaskId: TASK }]);
    expect(out.blocked).to.deep.equal([]);
    expect(pausadas).to.deep.equal([]);
  });

  it('nao pausa a pasta quando o pre nao esta configurado como bloqueante', async () => {
    const b = bridge({ preBlocksSync: false, taskManager: { getTask: () => ({ Id: TASK, Enabled: true }), executeTask: async () => { throw new Error('falhou'); } } });
    const pausadas = [];
    const client = Object.assign(fakeClient(50, 4), {
      patchFolder: async (id, patch) => { pausadas.push({ id, patch }); },
    });
    const out = await b.check(client, [{ id: FOLDER, PreSyncTaskId: TASK }]);
    expect(out.blocked).to.deep.equal([]);
    expect(pausadas).to.deep.equal([]);
  });

  it('nao engasga a varredura quando a leitura de progresso falha', async () => {
    const b = bridge({ taskManager: fakeTaskManager([]) });
    const quebrado = { dbCompletion: async () => { throw new Error('daemon fora'); } };
    const out = await b.check(quebrado, [{ id: FOLDER, PreSyncTaskId: TASK, PostSyncTaskId: TASK }]);
    expect(out.preFired).to.deep.equal([]);
    expect(out.fired).to.deep.equal([]);
  });

  it('roda pre e pos na mesma pasta, cada uma na sua vez', async () => {
    const executadas = [];
    const b = bridge({ taskManager: fakeTaskManager(executadas) });
    const folder = { id: FOLDER, PreSyncTaskId: TASK, PostSyncTaskId: TASK };
    await b.check(fakeClient(50, 5), [folder]);
    await b.check(fakeClient(COMPLETE, 0), [folder]);
    expect(executadas).to.have.length(2);
  });

  // O cooldown em disco existe por causa disto: duas pontes em processos
  // diferentes, como a GUI e o serviço na troca de lease. Com a janela só na
  // memória de cada processo, as duas disparavam o mesmo gatilho.
  it('dois processos não disparam o mesmo gatilho', async () => {
    const executadas = [];
    const taskManager = fakeTaskManager(executadas);
    const gui = bridge({ taskManager });
    const servico = bridge({ taskManager });

    // O serviço vê a pasta com trabalho; a GUI, logo depois, já completa.
    await servico.check(fakeClient(40, 9), [{ id: FOLDER, PreSyncTaskId: TASK }]);
    await gui.check(fakeClient(COMPLETE, 0), [{ id: FOLDER, PreSyncTaskId: TASK }]);

    expect(executadas).to.have.length(1);
  });

  it('o carimbo no disco sobrevive a um processo que renasce', () => {
    // Depois de um reinício do app, a ponte nova não tem memória nenhuma. O
    // carimbo em disco é o que impede o gatilho de rodar de novo logo após.
    const primeira = bridge();
    primeira.preDueFor({ folderId: FOLDER, taskId: TASK }, 0, Date.now());
    primeira.markFired(FOLDER, 'pre', Date.now());

    const segunda = bridge();
    segunda.preState.clear();
    expect(segunda.alreadyFired(FOLDER, 'pre', Date.now())).to.equal(true);
  });
});

describe('Rede de sincronismo: execucao da tarefa pos-sincronismo', () => {

  it('executa a tarefa registrada e devolve o que disparou', async () => {
    const executed = [];
    const b = bridge({
      taskManager: { getTask: () => ({ Id: TASK, Name: 'Compactar', Enabled: true }), executeTask: async (t) => { executed.push(t.Id); return { Success: true }; } },
    });
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 10, 1000);
    const out = await b.check(fakeClient(COMPLETE), [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(out.fired).to.have.length(1);
    expect(out.fired[0].result.ok).to.equal(true);
    expect(executed).to.deep.equal([TASK]);
  });

  it('nao executa uma tarefa que nao existe mais no agendador', async () => {
    const b = bridge({ taskManager: { getTask: () => null, executeTask: async () => ({}) } });
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 10, 1000);
    const out = await b.check(fakeClient(COMPLETE), [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(out.fired[0].result.reason).to.equal('postSync.taskNotFound');
  });

  it('respeita uma tarefa desabilitada', async () => {
    let ran = false;
    const b = bridge({ taskManager: { getTask: () => ({ Id: TASK, Enabled: false }), executeTask: async () => { ran = true; } } });
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 10, 1000);
    const out = await b.check(fakeClient(COMPLETE), [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(ran).to.equal(false);
    expect(out.fired[0].result.reason).to.equal('postSync.taskDisabled');
  });

  it('nao engasga a varredura quando a leitura de progresso falha', async () => {
    const b = bridge({ taskManager: { getTask: () => ({}), executeTask: async () => ({}) } });
    const broken = { dbCompletion: async () => { throw new Error('daemon fora'); } };
    const out = await b.check(broken, [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(out.fired).to.deep.equal([]);
  });

  // Este era o pior bug da compactação: o laço roda a cada tique do
  // agendador e comprimia a pasta sem olhar se ela tinha terminado. Um
  // arquivo pela metade vira um container truncado com cara de completo, e o
  // original é apagado logo em seguida.
  describe('Compactação só depois que a pasta terminou', () => {
    const PASTA = 'docs';
    const politica = { mode: 'perFile' };

    function comCompressor() {
      const estado = { chamadas: [], logs: [] };
      const b = bridge({
        compressor: {
          compressFolder: async (pasta) => { estado.chamadas.push(pasta); return { ok: true, added: 1 }; },
        },
        logger: { log: (lvl, m) => estado.logs.push(`${lvl}: ${m}`) },
      });
      return { b, estado };
    }

    it('não comprime uma pasta que ainda está sincronizando', async () => {
      const { b, estado } = comCompressor();
      const out = await b.check(fakeClient(40, 10), [{ id: PASTA, path: 'C:\\docs', Compression: politica }]);
      expect(out.compressed).to.deep.equal([]);
      expect(estado.chamadas).to.deep.equal([]);
    });

    it('comprime quando a pasta está completa e parada', async () => {
      const { b, estado } = comCompressor();
      const out = await b.check(fakeClient(COMPLETE, 0), [{ id: PASTA, path: 'C:\\docs', Compression: politica }]);
      expect(out.compressed).to.have.length(1);
      expect(estado.chamadas).to.deep.equal(['C:\\docs']);
    });

    it('não comprime enquanto houver item pendente, mesmo com 99%', async () => {
      const { b, estado } = comCompressor();
      await b.check(fakeClient(99, 3), [{ id: PASTA, path: 'C:\\docs', Compression: politica }]);
      expect(estado.chamadas).to.deep.equal([]);
    });

    it('não comprime a pasta se não conseguir ler o progresso dela', async () => {
      // Sem o número, compactar seria adivinhar; não compactar é o estado
      // seguro, e o motivo precisa ir para o log.
      const { b, estado } = comCompressor();
      const client = { dbCompletion: async () => { throw new Error('conexão perdida'); } };
      const out = await b.check(client, [{ id: PASTA, path: 'C:\\docs', Compression: politica }]);
      expect(out.compressed).to.deep.equal([]);
      expect(estado.logs.some((l) => l.includes('conexão perdida'))).to.equal(true);
    });

    it('pula a pasta sem política de compactação', async () => {
      const { b, estado } = comCompressor();
      await b.check(fakeClient(COMPLETE, 0), [
        { id: PASTA, path: 'C:\\docs', Compression: { mode: 'none' } },
        { id: PASTA, path: 'C:\\docs' },
      ]);
      expect(estado.chamadas).to.deep.equal([]);
    });
  });

  it('registra a execucao no log de execucoes quando ha registry', async () => {
    const started = [];
    const finished = [];
    const b = bridge({
      taskManager: { getTask: () => ({ Id: TASK, Enabled: true }), executeTask: async () => ({ Success: true }) },
      runRegistry: {
        start: (meta) => { started.push(meta); return 'run-1'; },
        finish: (id, status) => finished.push({ id, status }),
        failStep: () => {},
      },
    });
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 10, 1000);
    await b.check(fakeClient(COMPLETE), [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(started[0]).to.include({ kind: 'sync', targetId: FOLDER });
    expect(finished[0]).to.deep.equal({ id: 'run-1', status: 'Success' });
  });

  it('nao dispara quando a pasta continua incompleta', async () => {
    let ran = false;
    const b = bridge({ taskManager: { getTask: () => ({ Id: TASK, Enabled: true }), executeTask: async () => { ran = true; } } });
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 10, 1000);
    const out = await b.check(fakeClient(70), [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(out.fired).to.deep.equal([]);
    expect(ran).to.equal(false);
  });
});
