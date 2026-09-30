// syncthing/manager.js - Traduz o Syncthing para o modelo do Kyrios.
//
// Fica entre o daemon e a UI: normaliza pastas e dispositivos para os nomes que
// o Kyrios já usa, e valida as invariantes que o Syncthing também impõe mas só
// acusa em log depois que a config já foi gravada.

const { SyncthingDaemon } = require('./daemon');

// receiveonly não aceita metadata de outros: enviar ownership/xattrs para uma
// pasta que só recebe não tem efeito nenhum e a UI do Syncthing trata como erro.
const RECEIVE_ONLY = 'receiveonly';

const FOLDER_TYPES = [
  { value: 'sendreceive', key: 'sync.folderTypeSendReceive' },
  { value: 'sendonly', key: 'sync.folderTypeSendOnly' },
  { value: RECEIVE_ONLY, key: 'sync.folderTypeReceiveOnly' },
  { value: 'receiveencrypted', key: 'sync.folderTypeReceiveEncrypted' },
];

const VERSIONING_TYPES = ['off', 'trashcan', 'simple', 'staggered'];

function bool(value) { return value === true || value === 'true'; }

function normalizeFolder(input) {
  const folder = Object.assign({}, input);

  folder.type = FOLDER_TYPES.some((t) => t.value === folder.type) ? folder.type : 'sendreceive';
  folder.ignorePerms = bool(folder.ignorePerms);
  folder.syncOwnership = bool(folder.syncOwnership);
  folder.sendOwnership = bool(folder.sendOwnership);
  folder.syncXattrs = bool(folder.syncXattrs);
  folder.sendXattrs = bool(folder.sendXattrs);
  folder.fsWatcherEnabled = folder.fsWatcherEnabled === undefined ? true : bool(folder.fsWatcherEnabled);
  folder.rescanIntervalS = Number(folder.rescanIntervalS) > 0 ? Number(folder.rescanIntervalS) : 3600;
  folder.fsWatcherDelayS = Number(folder.fsWatcherDelayS) > 0 ? Number(folder.fsWatcherDelayS) : 10;

  // "Sempre habilitado quando o sync correspondente está habilitado": quem
  // pediu para aplicar o metadatareceived também precisa enviar o próprio.
  if (folder.syncOwnership) folder.sendOwnership = true;
  if (folder.syncXattrs) folder.sendXattrs = true;

  // Vem por último de propósito: em "receber somente" o envio de metadata é
  // proibido, e essa regra vence a implicação acima.
  if (folder.type === RECEIVE_ONLY) {
    folder.sendOwnership = false;
    folder.sendXattrs = false;
  }

  folder.devices = Array.isArray(folder.devices) ? folder.devices : [];
  folder.versioning = normalizeVersioning(folder.versioning);

  return folder;
}

function normalizeVersioning(versioning) {
  const source = versioning || {};
  const type = VERSIONING_TYPES.includes(source.type) ? source.type : 'off';
  const params = Object.assign({}, source.params);
  if (type === 'staggered') {
    params.maxAge = Number(params.maxAge) > 0 ? Number(params.maxAge) : 365 * 24 * 60;
    params.cleanIntervalDays = Number(params.cleanIntervalDays) > 0 ? Number(params.cleanIntervalDays) : 30;
  }
  if (type === 'simple') params.keep = Number(params.keep) > 0 ? Number(params.keep) : 5;
  if (type === 'trashcan') params.cleanoutDays = Number(params.cleanoutDays) > 0 ? Number(params.cleanoutDays) : 30;
  return { type, params };
}

function normalizeDevice(input) {
  const device = Object.assign({}, input);
  device.deviceID = device.deviceID || device.id || '';
  device.name = device.name || '';
  device.paused = bool(device.paused);
  device.autoAcceptFolders = bool(device.autoAcceptFolders);
  device.introducer = bool(device.introducer);
  device.addresses = Array.isArray(device.addresses) ? device.addresses : [];
  // "dynamic" faz o Syncthing usar a porta aleatória e aparecer nos outros;
  // um endereço fixo é o caso do roteador/NAT.
  device.dynamic = device.addresses.some((a) => a === 'dynamic');
  return device;
}

// A tela de métricas pede os mesmos números do painel do Syncthing, com os
// mesmos rótulos. Tudo vem do daemon; nada é estimado aqui.
async function overview(client, extra = {}) {
  const [status, connection, folderStats, deviceStats, version, discovery] = await Promise.all([
    client.systemStatus().catch(() => null),
    client.statsConnection().catch(() => null),
    client.statsFolder().catch(() => null),
    client.statsDevice().catch(() => ({})),
    client.get('/rest/system/version').catch(() => null),
    client.discovery().catch(() => null),
  ]);

  const total = (connection && connection.total) || {};
  const folders = folderStats || {};
  const aggregate = Object.values(folders).reduce((acc, f) => {
    acc.files += f.files || 0;
    acc.directories += f.dirs || 0;
    acc.bytes += f.bytes || 0;
    return acc;
  }, { files: 0, directories: 0, bytes: 0 });

  const listeners = {
    ok: total.inListenAddrsOk || 0,
    total: total.inListenAddrsCount || 0,
  };
  const discoveryState = (discovery && discovery.global) || {};

  return {
    deviceID: (status && status.myID) || '',
    version: version
      ? { long: version.longVersion || '', os: version.os || '', arch: version.arch || '', number: version.version || '' }
      : { long: '', os: '', arch: '', number: '' },
    uptimeMs: status && status.startTime ? Date.now() - status.startTime : 0,
    running: Boolean(status),
    receive: { rate: total.inRate || 0, bytes: total.inBytesTotal || 0 },
    send: { rate: total.outRate || 0, bytes: total.outBytesTotal || 0 },
    localState: aggregate,
    listeners,
    // `available` false quando o endpoint de descoberta não respondeu: a UI
    // mostra "—" em vez de um número inventado a partir de outra métrica.
    discovery: {
      available: Boolean(discovery),
      enabled: discoveryState.enabled !== false,
      globalOK: discoveryState.ok === true,
      devices: discoveryState.devices ? discoveryState.devices.length : 0,
    },
    connections: total.connections || 0,
    devices: Object.values(deviceStats || {}).map(normalizeDeviceStats),
    folders: Object.entries(folders).map(([id, f]) => ({ id, ...f })),
  };
}

function normalizeDeviceStats(stats) {
  return {
    deviceID: stats.deviceID || '',
    name: stats.deviceName || '',
    lastSeen: stats.lastSeen || '',
    at: stats.at || '',
    connected: Boolean(stats.connected),
    paused: Boolean(stats.paused),
  };
}

class SyncthingManager {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.installer = options.installer;
    this.daemon = options.daemon || new SyncthingDaemon({ logger: options.logger, installer: options.installer });
    this.client = null;
  }

  async ready() {
    if (this.client) return { ok: true, client: this.client };
    const started = await this.daemon.start();
    if (!started.ok) return started;
    this.client = started.client;
    return started;
  }

  async overview() {
    const ready = await this.ready();
    if (!ready.ok) return ready;
    return overview(ready.client);
  }

  async folders() {
    const ready = await this.ready();
    if (!ready.ok) return ready;
    const list = await ready.client.folders();
    return (list || []).map(normalizeFolder);
  }

  async devices() {
    const ready = await this.ready();
    if (!ready.ok) return ready;
    const list = await ready.client.devices();
    return (list || []).map(normalizeDevice);
  }
}

module.exports = SyncthingManager;
module.exports.SyncthingManager = SyncthingManager;
module.exports.FOLDER_TYPES = FOLDER_TYPES;
module.exports.VERSIONING_TYPES = VERSIONING_TYPES;
module.exports.normalizeFolder = normalizeFolder;
module.exports.normalizeVersioning = normalizeVersioning;
module.exports.normalizeDevice = normalizeDevice;
module.exports.overview = overview;
