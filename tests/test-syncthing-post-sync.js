// tests/test-syncthing-post-sync.js
//
// O gatilho é a transição para completo, não o estado. Disparar enquanto a
// pasta já está em 100% transformaria a tarefa em periódica, e uma pasta
// parada que reencontrasse 100% dispararia de novo a cada tique.

const { expect } = require('chai');
const { PostSyncBridge, normalizeTargets, COMPLETE } = require('../src/main/syncthing/postSync');

const FOLDER = 'docs-abc';
const TASK = 'task-1';

function bridge(options = {}) {
  return new PostSyncBridge(Object.assign({ minIntervalMs: 300000 }, options));
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

describe('Rede de sincronismo: execucao da tarefa pos-sincronismo', () => {
  function fakeClient(completion) {
    return { dbCompletion: async () => ({ completion, needItems: 0, needBytes: 0 }) };
  }

  it('executa a tarefa registrada e devolve o que disparou', async () => {
    const executed = [];
    const b = bridge({
      taskManager: { getTask: () => ({ Id: TASK, Name: 'Compactar', Enabled: true }), executeTask: async (t) => { executed.push(t.Id); return { Success: true }; } },
    });
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 10, 1000);
    const fired = await b.check(fakeClient(COMPLETE), [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(fired).to.have.length(1);
    expect(fired[0].result.ok).to.equal(true);
    expect(executed).to.deep.equal([TASK]);
  });

  it('nao executa uma tarefa que nao existe mais no agendador', async () => {
    const b = bridge({ taskManager: { getTask: () => null, executeTask: async () => ({}) } });
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 10, 1000);
    const fired = await b.check(fakeClient(COMPLETE), [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(fired[0].result.reason).to.equal('postSync.taskNotFound');
  });

  it('respeita uma tarefa desabilitada', async () => {
    let ran = false;
    const b = bridge({ taskManager: { getTask: () => ({ Id: TASK, Enabled: false }), executeTask: async () => { ran = true; } } });
    b.dueFor({ folderId: FOLDER, taskId: TASK }, 10, 1000);
    const fired = await b.check(fakeClient(COMPLETE), [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(ran).to.equal(false);
    expect(fired[0].result.reason).to.equal('postSync.taskDisabled');
  });

  it('nao engasga a varredura quando a leitura de progresso falha', async () => {
    const b = bridge({ taskManager: { getTask: () => ({}), executeTask: async () => ({}) } });
    const broken = { dbCompletion: async () => { throw new Error('daemon fora'); } };
    const fired = await b.check(broken, [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(fired).to.deep.equal([]);
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
    const fired = await b.check(fakeClient(70), [{ id: FOLDER, PostSyncTaskId: TASK }]);
    expect(fired).to.deep.equal([]);
    expect(ran).to.equal(false);
  });
});
