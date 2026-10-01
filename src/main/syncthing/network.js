// syncthing/network.js - Ponto de entrada único da rede de sincronismo.
//
// Junta as quatro peças (installer, daemon, manager, deviceAuth) atrás de uma
// interface que o app, o serviço headless e o painel web chamam igual. Sem
// `electron`: o serviço Windows carrega este arquivo como Node puro.

const fs = require('fs');
const path = require('path');

const paths = require('../paths');
const { SyncthingInstaller } = require('./installer');
const { SyncthingManager, normalizeFolder, normalizeDevice } = require('./manager');
const { PostSyncBridge } = require('./postSync');
const { SyncInstances, DEFAULT_ID } = require('./instances');
const { FolderCompressor } = require('./folderCompressor');
const deviceAuth = require('./deviceAuth');

const DEVICE_REGISTRY_KEY = 'SyncNetworkDevices';

function reasonOf(result) {
  switch (result.reason) {
    case 'not-installed': return 'network.notInstalled';
    case 'not-generated': return 'network.notGenerated';
    case 'no-port': return 'network.noPort';
    case 'still-running': return 'network.stillRunning';
    default: return result.reason || 'network.unknownError';
  }
}

class SyncNetwork {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.config = options.config || null;
    this.installer = options.installer || new SyncthingInstaller(options.logger);
    this.manager = options.manager || new SyncthingManager({ logger: options.logger, installer: this.installer });
    this.instances = options.instances || new SyncInstances({ logger: options.logger, config: this.config, installer: this.installer });
    this.compressor = options.compressor || new FolderCompressor({ logger: options.logger, config: this.config });
    this.postSync = options.postSync || new PostSyncBridge({
      logger: options.logger,
      taskManager: options.taskManager,
      runRegistry: options.runRegistry,
      compressor: this.compressor,
      onPreFire: options.onPreFire,
      onFire: options.onFire,
    });
  }

  // Cada instancia e uma "maquina" para efeitos de pareamento. A padrao e a que
  // responde a rede; as demais sao a copia local para outro disco.
  managerFor(instanceId) {
    if (!instanceId || instanceId === DEFAULT_ID) return this.manager;
    return this.instances.managerFor(instanceId) || this.manager;
  }

  listInstances() {
    return this.instances.list().map((i) => Object.assign({}, i, {
      deviceID: this.instances.deviceIdOf(i),
      running: i.Id === DEFAULT_ID ? Boolean((this.statusCache || {}).running) : undefined,
    }));
  }

  // Chamado pelo dono do agendador a cada tique. Devolve as tarefas disparadas
  // para o chamador auditar; um erro aqui nunca deve derrubar o tique.
  async createInstance(name) {
    return this.instances.create(name);
  }

  async removeInstance(id) {
    return this.instances.remove(id);
  }

  async startInstance(id) {
    const manager = this.instances.managerFor(id);
    if (!manager) return { success: false, reason: 'network.instanceNotFound' };
    const result = await manager.daemon.start();
    if (!result.ok) return Object.assign({ success: false }, result, { reason: reasonOf(result) });
    manager.client = result.client;
    return { success: true, alreadyRunning: Boolean(result.alreadyRunning), port: result.port };
  }

  async stopInstance(id) {
    const manager = this.instances.managerFor(id);
    if (!manager) return { success: false, reason: 'network.instanceNotFound' };
    const ready = await manager.ready();
    if (!ready.ok) return Object.assign({ success: false }, ready, { reason: reasonOf(ready) });
    const result = await manager.daemon.stop(ready.client);
    if (!result.ok) return Object.assign({ success: false }, result, { reason: reasonOf(result) });
    manager.client = null;
    return { success: true };
  }

  async checkPostSync() {
    try {
      const ready = await this.manager.ready();
      if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
      const folders = await ready.client.folders();
      return { ok: true, fired: await this.postSync.check(ready.client, folders || []) };
    } catch (err) {
      this.log('WARN', `PostSync: varredura falhou: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  // A compressão roda depois que a pasta terminou de sincronizar, e nunca no
  // meio de uma transferência: comprimir um arquivo pela metade produziria um
  // container truncado com nome de completo.
  async compressFolder(id, policy) {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
    let folder = null;
    try { folder = await ready.client.folder(id); }
    catch (e) { return { ok: false, reason: 'network.folderNotFound' }; }

    const result = await this.compressor.compressFolder(folder.path, Object.assign({ mode: 'none' }, policy));
    if (!result.ok) this.log('WARN', `SYNC_COMPRESSION_FAILED folder=${id} reason=${result.reason} ${result.detail || ''}`);
    return result;
  }

  async restoreFolder(id, policy) {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
    let folder = null;
    try { folder = await ready.client.folder(id); }
    catch (e) { return { ok: false, reason: 'network.folderNotFound' }; }
    return this.compressor.restoreArchive(policy, folder.path);
  }

  log(level, message) { if (this.logger) this.logger.log(level, message); }

  deviceRegistry() {
    if (!this.config) return [];
    return deviceAuth.normalizeRegistry(this.config.getSetting(DEVICE_REGISTRY_KEY, []));
  }

  saveRegistry(registry) {
    if (this.config) this.config.setSetting(DEVICE_REGISTRY_KEY, registry);
    return registry;
  }

  // Instalado, profile gerado e daemon de pé são três estados diferentes: a UI
  // oferece uma ação diferente para cada um, e somar tudo num booleano
  // esconde justamente a etapa que falta.
  async status() {
    const installed = await this.installer.checkInstalled();
    if (!installed.installed) return { installed: false, running: false, reason: 'network.notInstalled' };

    const daemonStatus = await this.manager.daemon.status();
    if (!daemonStatus.ok) {
      return {
        installed: true, running: false, reason: reasonOf(daemonStatus),
        path: installed.path, version: installed.version, home: this.manager.daemon.home,
      };
    }
    return {
      installed: true,
      running: Boolean(daemonStatus.running),
      path: installed.path,
      version: installed.version,
      home: this.manager.daemon.home,
      port: daemonStatus.port,
      deviceID: daemonStatus.status ? daemonStatus.status.myID : '',
    };
  }

  async install() {
    const result = await this.installer.installSyncthing();
    return Object.assign({ success: false }, result);
  }

  async start() {
    const result = await this.manager.daemon.start();
    if (!result.ok) return Object.assign({ success: false }, result, { reason: reasonOf(result) });
    // Guardar o client é o que impede o próximo ready() de subir um segundo
    // daemon: sem isto, overview() logo depois de start() abria outra instância.
    this.manager.client = result.client;
    return { success: true, alreadyRunning: Boolean(result.alreadyRunning), port: result.port, version: result.version };
  }

  async stop() {
    const ready = await this.manager.ready();
    if (!ready.ok) return Object.assign({ success: false }, ready, { reason: reasonOf(ready) });
    const result = await this.manager.daemon.stop(ready.client);
    if (!result.ok) return Object.assign({ success: false }, result, { reason: reasonOf(result) });
    this.manager.client = null;
    return { success: true };
  }

  async overview() {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
    return { ok: true, ...(await this.manager.overview()) };
  }

  async folders() {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
    const list = await ready.client.folders();
    const registry = this.deviceRegistry();
    return {
      ok: true,
      folders: (list || []).map((f) => {
        const folder = normalizeFolder(f);
        return Object.assign(folder, {
          authorized: deviceAuth.assertShareAllowed(registry, (folder.devices || []).map((d) => d.deviceID)).ok,
        });
      }),
    };
  }

/**
 * O path da pasta vem do renderer, e essa é a única validação entre ele e o
 * que sai da máquina. Sem esta checagem, apontar a pasta para o home do
 * Syncthing replicaria cert.pem, key.pem e config.xml - e o config.xml
 * contém a <apikey>, que é o único controle de acesso do daemon - para
 * todos os dispositivos pareados.
 */
  validateFolderPath(folderPath) {
    if (typeof folderPath !== 'string' || !folderPath.trim()) return 'network.folderPathRequired';
    const raw = folderPath.trim();
    // A absolutidade é checada ANTES de resolver: path.resolve transformaria
    // "docs\sub" em um caminho dentro do diretório atual, que no serviço
    // (LocalSystem) é C:\Windows\System32.
    if (!path.isAbsolute(raw)) return 'network.folderPathNotAbsolute';
    const target = path.normalize(raw);

    // Recusa por substring seria errada: "C:\dados\syncthing-bkp" não está
    // dentro de "C:\dados\syncthing". O teste é o mesmo do backupArtifacts.
    // path.relative dá "" quando os dois caminhos são o mesmo, e esse caso
    // conta como dentro: apontar a pasta para o dataDir ou para a instalação
    // seria copiar os perfis e a senha do banco para os outros dispositivos.
    const contido = (pai) => {
      const rel = path.relative(pai, target);
      if (rel === '') return true;
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    };

    const zonasProibidas = [paths.syncthingHome(), paths.dataDir(), paths.appRoot()];
    for (const proibido of zonasProibidas) {
      if (contido(proibido)) return 'network.folderPathReserved';
    }
    return null;
  }

  async saveFolder(input) {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };

    const folder = normalizeFolder(input);
    if (!folder.id) return { ok: false, error: 'network.folderNeedsId' };

    const pathProblem = this.validateFolderPath(folder.path);
    if (pathProblem) return { ok: false, error: pathProblem };

    // Última barreira antes do dado cruzar a rede: uma pasta compartilhada com
    // um dispositivo que ninguém autorizado vazaria para a máquina dele.
    const deviceIDs = (folder.devices || []).map((d) => d.deviceID);
    const gate = deviceAuth.assertShareAllowed(this.deviceRegistry(), deviceIDs);
    if (!gate.ok) return { ok: false, error: 'network.deviceNotAuthorized', blocked: gate.blocked };

    await ready.client.putFolder(folder.id, folder);
    return { ok: true, folder: normalizeFolder(folder) };
  }

  async deleteFolder(id) {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
    await ready.client.deleteFolder(id);
    return { ok: true };
  }

  async rescanFolder(id) {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
    await ready.client.rescanFolder(id);
    return { ok: true };
  }

  async ignores(id) {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
    const list = await ready.client.get(`/rest/db/ignores?folder=${encodeURIComponent(id)}`);
    return { ok: true, ignores: (list && list.ignore) || [] };
  }

  async saveIgnores(id, lines) {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
    await ready.client.post(`/rest/db/ignores?folder=${encodeURIComponent(id)}`, { ignore: lines || [] });
    return { ok: true };
  }

  async devices() {
    const ready = await this.manager.ready();
    if (!ready.ok) return { ok: false, reason: reasonOf(ready) };
    const [list, stats] = await Promise.all([
      ready.client.devices().catch(() => []),
      ready.client.statsDevice().catch(() => ({})),
    ]);
    const registry = this.deviceRegistry();
    return {
      ok: true,
      devices: (list || []).map((d) => {
        const device = normalizeDevice(d);
        const entry = deviceAuth.find(registry, device.deviceID);
        return Object.assign(device, {
          authorized: deviceAuth.isAuthorized(registry, device.deviceID),
          githubLogin: entry ? entry.githubLogin : '',
          githubId: entry ? entry.githubId : null,
          lastSeen: (stats[device.deviceID] || {}).lastSeen || '',
          connected: Boolean((stats[device.deviceID] || {}).connected),
        });
      }),
    };
  }

  async authorizeDevice(input, actor) {
    const result = deviceAuth.authorize(input, actor);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.saveRegistry(deviceAuth.upsert(this.deviceRegistry(), result.entry));
    return { ok: true, entry: result.entry };
  }

  async revokeDevice(deviceID) {
    this.saveRegistry(deviceAuth.revoke(this.deviceRegistry(), deviceID));
    return { ok: true };
  }
}

module.exports = SyncNetwork;
module.exports.SyncNetwork = SyncNetwork;
module.exports.DEVICE_REGISTRY_KEY = DEVICE_REGISTRY_KEY;
module.exports.reasonOf = reasonOf;
