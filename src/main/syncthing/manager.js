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

// A v2 removeu inRate/outRate do snapshot REST: /rest/stats/connection nem
// existe mais, e /rest/system/connections devolve só os totais. A taxa é então
// o que o nome diz - bytes por segundo -, medida como diferença entre duas
// leituras do total. Sem amostra anterior não há taxa, e o campo diz 0 em vez
// de um número inventado.
class RateTracker {
  constructor() { this.previous = null; }

  sample(total, now = Date.now()) {
    const incoming = (total && total.inBytesTotal) || 0;
    const outgoing = (total && total.outBytesTotal) || 0;
    const previous = this.previous;
    this.previous = { at: now, incoming, outgoing };

    if (!previous) return { inRate: 0, outRate: 0, inBytesTotal: incoming, outBytesTotal: outgoing, sampled: false };
    const seconds = (now - previous.at) / 1000;
    // Um salto de relógio ou um reinício do contador producingia uma taxa
    // absurda; menos de meio segundo de janela não dá base confiável.
    if (seconds < 0.5) return { inRate: 0, outRate: 0, inBytesTotal: incoming, outBytesTotal: outgoing, sampled: false };
    return {
      inRate: Math.max(0, (incoming - previous.incoming) / seconds),
      outRate: Math.max(0, (outgoing - previous.outgoing) / seconds),
      inBytesTotal: incoming,
      outBytesTotal: outgoing,
      sampled: true,
    };
  }
}

// "Escutadores 3/3" é a mesma conta do painel do Syncthing: quantos dos
// serviços de conexão responderam sem erro.
function listenerSummary(status) {
  const services = (status && status.connectionServiceStatus) || {};
  const entries = Object.values(services);
  return {
    ok: entries.filter((service) => !service || !service.error).length,
    total: entries.length,
  };
}

// "Descoberta 4/5": dos métodos anunciados, quantos responderam. O objeto
// antigo (global/local com enabled/ok) foi substituído por este mapa.
function discoverySummary(status) {
  if (!status || !status.discoveryStatus) return { available: false, ok: 0, total: 0 };
  const services = Object.values(status.discoveryStatus);
  const failing = Object.keys(status.discoveryStatus).filter((key) => status.discoveryStatus[key] && status.discoveryStatus[key].error);
  return {
    available: true,
    ok: services.filter((service) => !service || !service.error).length,
    total: Number(status.discoveryMethods) || services.length,
    enabled: status.discoveryEnabled !== false,
    errors: failing,
  };
}

function uptimeMs(status, now) {
  // A v1 dava epoch em ms, a v2 dá string ISO - e `Date.now() - "2026-..."` dá
  // NaN, que o JSON serializa como null e a tela mostrava vazio.
  if (status && typeof status.uptime === 'number') return status.uptime * 1000;
  if (status && status.startTime) {
    const started = Date.parse(status.startTime);
    if (!Number.isNaN(started)) return Math.max(0, now - started);
  }
  return 0;
}

// A tela de métricas pede os mesmos números do painel do Syncthing, com os
// mesmos rótulos. Tudo vem do daemon; nada é estimado aqui.
async function overview(client, extra = {}) {
  const now = Date.now();
  const [status, connections, deviceStats, version, discovered] = await Promise.all([
    client.systemStatus().catch(() => null),
    client.get('/rest/system/connections').catch(() => null),
    client.statsDevice().catch(() => {}),
    client.get('/rest/system/version').catch(() => null),
    client.discovery().catch(() => null),
  ]);

  // stats/folder responde 404 quando não há pasta nenhuma; absence is not zero
  // é o mesmo erro do resto: um 0 aqui seria uma métrica que ninguém mediu.
  const folderStats = await client.statsFolder().catch(() => null);
  const aggregate = Object.values(folderStats || {}).reduce((acc, f) => {
    acc.files += f.files || 0;
    acc.directories += f.dirs || 0;
    acc.bytes += f.bytes || 0;
    return acc;
  }, { files: 0, directories: 0, bytes: 0 });

  const tracker = extra.tracker || new RateTracker();
  const rates = tracker.sample((connections && connections.total) || {}, now);
  const total = (connections && connections.total) || {};

  return {
    tracker,
    deviceID: (status && status.myID) || '',
    version: version
      ? { long: version.longVersion || '', os: version.os || '', arch: version.arch || '', number: version.version || '' }
      : { long: '', os: '', arch: '', number: '' },
    uptimeMs: uptimeMs(status, now),
    running: Boolean(status),
    receive: { rate: rates.inRate, bytes: rates.inBytesTotal },
    send: { rate: rates.outRate, bytes: rates.outBytesTotal },
    localState: aggregate,
    listeners: listenerSummary(status),
    discovery: discoverySummary(status),
    connections: Object.keys((connections && connections.connections) || {}).length,
    // v2 devolve chaves vazias no stats/device quando nada foi visto ainda;
    // um dispositivo sem ID não é um dispositivo.
    devices: Object.entries(deviceStats || {})
      .filter(([id]) => /^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/.test(id))
      .map(([id, stats]) => normalizeDeviceStats(Object.assign({ deviceID: id }, stats))),
    discovered: Object.keys(discovered || {}).filter((id) => id !== status.myID).length,
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
    this.tracker = new RateTracker();
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
    return overview(ready.client, { tracker: this.tracker });
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
module.exports.RateTracker = RateTracker;
module.exports.uptimeMs = uptimeMs;
