// syncthing/postSync.js - Dispara tarefas do Kyrios quando uma pasta termina de sincronizar.
//
// A direção inversa do que já existe: syncManager.maybeTriggerForTask roda um
// sync depois de uma tarefa; aqui uma tarefa roda depois de um sync. A tarefa é
// uma que já está registrada no Agendador pelo usuário - o sync não cria nem
// edita tarefa nenhuma, só referencia uma pelo id.
//
// O gatilho é a transição, não o estado: só dispara ao passar de "incompleto"
// para "completo". Disparar enquanto já está em 100 transformaria a tarefa
// periódica, e uma pasta parada dispararia a cada tique.

const COMPLETE = 100;

function normalizeTargets(folders) {
  return (folders || [])
    .filter((f) => f && f.id && f.PostSyncTaskId)
    .map((f) => ({ folderId: f.id, taskId: f.PostSyncTaskId, type: f.type, label: f.label || f.id }));
}

class PostSyncBridge {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.taskManager = options.taskManager || null;
    this.runRegistry = options.runRegistry || null;
    this.state = new Map();   // folderId -> { completion, lastRunAt }
    this.minIntervalMs = Number(options.minIntervalMs) || 300000;
    this.onFire = options.onFire || null;
  }

  log(level, message) { if (this.logger) this.logger.log(level, message); }

  isComplete(completion) { return Number(completion) >= COMPLETE; }

  /**
   * Decide se a pasta transitioned para completo e devolve a tarefa a rodar.
   * Separado do disparo para que a decisão seja testável sem daemon e sem
   * registrar nada.
   */
  dueFor(target, completion, now) {
    const previous = this.state.get(target.folderId);
    this.state.set(target.folderId, { completion, lastRunAt: previous ? previous.lastRunAt : 0 });

    if (!this.isComplete(completion)) return null;
    if (!previous) return null;
    if (this.isComplete(previous.completion)) return null;
    // A mesma pasta pode ficar oscilando perto de 100 enquanto o indexador
    // recalcula; sem esta janela um retrabalho curto dispararia a tarefa duas
    // vezes seguidas.
    if (previous.lastRunAt && now - previous.lastRunAt < this.minIntervalMs) return null;
    return target;
  }

  async check(client, folders) {
    const targets = normalizeTargets(folders);
    const fired = [];

    for (const target of targets) {
      let completion = 0;
      try {
        const status = await client.dbCompletion(target.folderId);
        completion = status && status.completion;
      } catch (e) {
        this.log('WARN', `PostSync: falha ao ler progresso de ${target.folderId}: ${e.message}`);
        continue;
      }

      const due = this.dueFor(target, completion, Date.now());
      if (!due) continue;

      const state = this.state.get(target.folderId);
      state.lastRunAt = Date.now();
      const result = await this.run(due);
      fired.push({ folderId: due.folderId, taskId: due.taskId, result });
    }
    return fired;
  }

  async run(target) {
    if (!this.taskManager) return { ok: false, reason: 'postSync.noTaskManager' };

    const task = this.taskManager.getTask(target.taskId);
    if (!task) return { ok: false, reason: 'postSync.taskNotFound' };
    if (!task.Enabled) return { ok: false, reason: 'postSync.taskDisabled' };

    const runId = this.runRegistry
      ? this.runRegistry.start({ kind: 'sync', targetId: target.folderId, name: task.Name || target.taskId })
      : null;
    this.log('INFO', `POST_SYNC_TRIGGER folder=${target.folderId} task=${target.taskId} run=${runId || 'sem-registry'}`);

    try {
      const entry = await this.taskManager.executeTask(task);
      if (this.runRegistry) this.runRegistry.finish(runId, entry && entry.Success === false ? 'Error' : 'Success');
      if (this.onFire) this.onFire(target, entry);
      return { ok: true, runId };
    } catch (err) {
      if (this.runRegistry) this.runRegistry.failStep(runId, err.message);
      this.log('ERROR', `PostSync: tarefa ${target.taskId} falhou: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }
}

module.exports = PostSyncBridge;
module.exports.PostSyncBridge = PostSyncBridge;
module.exports.COMPLETE = COMPLETE;
module.exports.normalizeTargets = normalizeTargets;
