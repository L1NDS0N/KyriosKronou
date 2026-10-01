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

// Pré-sincronismo: roda quando a pasta tem trabalho a fazer e estava parada.
// É o gatilho útil para "gerar os arquivos antes de mandar", e o espelho exato
// do pós.
function normalizePreTargets(folders) {
  return (folders || [])
    .filter((f) => f && f.id && f.PreSyncTaskId)
    .map((f) => ({ folderId: f.id, taskId: f.PreSyncTaskId, type: f.type, label: f.label || f.id }));
}

class PostSyncBridge {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.taskManager = options.taskManager || null;
    this.runRegistry = options.runRegistry || null;
    this.state = new Map();   // folderId -> { completion, lastRunAt }
    this.preState = new Map(); // folderId -> { hadWork, lastRunAt }
    this.minIntervalMs = Number(options.minIntervalMs) || 300000;
    this.onFire = options.onFire || null;
    this.onPreFire = options.onPreFire || null;
    // RODA DEPOIS da tarefa: comprimir um arquivo que ainda está chegando
    // produziria um container truncado com cara de completo.
    this.compressor = options.compressor || null;
    // A tarefa de pré tem que poder recusar a sincronização: é o que permite
    // "gere o dump, e só mande se o dump passou". Sem isso a tarefa roda, mas
    // não tem poder nenhum sobre o que vem depois.
    this.preBlocksSync = options.preBlocksSync === true;
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

  /**
   * Dispara a tarefa de pré-sincronismo quando a pasta tem trabalho a fazer e
   * não tinha antes. O gatilho é a borda: entra em "precisa sincronizar" uma
   * vez por surto de trabalho, e não a cada tique com a pasta parada.
   */
  preDueFor(target, needItems, now) {
    const previous = this.preState.get(target.folderId);
    const hasWork = Number(needItems) > 0;
    this.preState.set(target.folderId, { hasWork, lastRunAt: previous ? previous.lastRunAt : 0 });

    if (!hasWork) return null;
    if (previous && previous.hasWork) return null;
    if (previous && previous.lastRunAt && now - previous.lastRunAt < this.minIntervalMs) return null;
    return target;
  }

  async runPre(target) {
    const result = await this.run(target, 'sync:pre');
    if (this.onPreFire) this.onPreFire(target, result);
    return result;
  }

  async check(client, folders) {
    const targets = normalizeTargets(folders);
    const preTargets = normalizePreTargets(folders);
    const fired = [];
    const preFired = [];
    const compressed = [];

    // O pré roda ANTES de tudo: se ele falhar e for bloqueante, a pasta fica
    // pausada e nada mais acontece com ela neste ciclo.
    const blocked = [];
    for (const target of preTargets) {
      let needItems = 0;
      try {
        const status = await client.dbCompletion(target.folderId);
        needItems = (status && status.needItems) || 0;
      } catch (e) {
        this.log('WARN', `PreSync: falha ao ler progresso de ${target.folderId}: ${e.message}`);
        continue;
      }
      const due = this.preDueFor(target, needItems, Date.now());
      if (!due) continue;
      this.preState.get(target.folderId).lastRunAt = Date.now();

      const result = await this.runPre(due);
      preFired.push({ folderId: due.folderId, taskId: due.taskId, result });

      if (this.preBlocksSync && !result.ok) {
        blocked.push(due.folderId);
        this.log('WARN', `PRE_SYNC_BLOCKED folder=${due.folderId} task=${due.taskId} reason=${result.reason}`);
        if (typeof client.patchFolder === 'function') {
          try { await client.patchFolder(due.folderId, { paused: true }); }
          catch (e) { this.log('WARN', `PreSync: não consegui pausar ${due.folderId}: ${e.message}`); }
        }
      }
    }

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

    // A compactação não é a tarefa pós-sincronismo: é o passo que vem DEPOIS
    // dela, e roda para toda pasta com política de compactação, mesmo sem
    // tarefa associada.
    //
    // Só quando a pasta está em 100%. Este laço roda a cada tique do
    // agendador, e comprimir um arquivo pela metade produziria um container
    // truncado com cara de completo - com o original já apagado logo abaixo.
    // Sem esta checagem era exatamente a perda de dado que o comentário
    // dizia evitar.
    if (this.compressor) {
      for (const folder of folders || []) {
        const policy = folder && folder.Compression;
        if (!policy || policy.mode === 'none') continue;

        let completion = null;
        try {
          const status = await client.dbCompletion(folder.id);
          completion = status && status.completion;
        } catch (e) {
          this.log('WARN', `Compactação: não consegui ler o progresso de ${folder.id}: ${e.message}`);
          continue;
        }
        if (!this.isComplete(completion)) continue;

        try {
          const outcome = await this.compressor.compressFolder(folder.path, policy);
          compressed.push({ folderId: folder.id, ok: Boolean(outcome.ok), result: outcome });
          if (!outcome.ok) {
            this.log('WARN', `Compactação de ${folder.id} falhou: ${outcome.reason} ${outcome.detail || ''}`);
          }
        } catch (err) {
          this.log('WARN', `Compactação de ${folder.id} lançou: ${err.message}`);
        }
      }
    }

    return { fired, preFired, compressed, blocked };
  }

  async run(target, kind) {
    if (!this.taskManager) return { ok: false, reason: 'postSync.noTaskManager' };

    const task = this.taskManager.getTask(target.taskId);
    if (!task) return { ok: false, reason: 'postSync.taskNotFound' };
    if (!task.Enabled) return { ok: false, reason: 'postSync.taskDisabled' };

    const runId = this.runRegistry
      ? this.runRegistry.start({ kind: kind || 'sync', targetId: target.folderId, name: task.Name || target.taskId })
      : null;
    this.log('INFO', `SYNC_TASK_TRIGGER phase=${kind || 'post'} folder=${target.folderId} task=${target.taskId} run=${runId || 'sem-registry'}`);

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
module.exports.normalizePreTargets = normalizePreTargets;
