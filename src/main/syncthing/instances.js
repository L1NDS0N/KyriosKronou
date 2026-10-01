// syncthing/instances.js - Copia local: a pasta compartilhada com a propria maquina.
//
// "Compartilhar comigo mesmo uma pasta para sincronizar em outro lugar do PC,
// como num HD externo" e, no Syncthing, uma segunda instancia com o proprio
// device ID. Nao existe caminho de uma pasta apontar para dois destinos dentro
// da mesma instancia, e apontar a mesma pasta para dois lugares faria o
// Syncthing brigar com ele mesmo no indice.
//
// Por isso a solucao e uma segunda instancia, com home separado e certificado
// proprio. As duas se pareiam pelo mesmo caminho de autorizacao por GitHub das
// maquinas remotas - nada de espelhar em disco por fora do protocolo.

const fs = require('fs');
const path = require('path');
const { syncthingHome } = require('../paths');
const { SyncthingDaemon, isGenerated } = require('./daemon');
const { SyncthingManager } = require('./manager');
const { SyncthingInstaller } = require('./installer');

const INSTANCES_KEY = 'SyncNetworkInstances';
const DEFAULT_ID = 'default';

function slugify(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeInstance(input) {
  const instance = Object.assign({ Id: DEFAULT_ID, Name: 'Local', Auto: true }, input);
  instance.Id = slugify(instance.Id) || DEFAULT_ID;
  instance.Name = String(instance.Name || instance.Id);
  instance.Home = instance.Home || syncthingHome(instance.Id === DEFAULT_ID ? null : instance.Id);
  return instance;
}

class SyncInstances {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.config = options.config || null;
    this.installer = options.installer || new SyncthingInstaller(options.logger);
    this.managers = new Map();
  }

  list() {
    const configured = this.config ? this.config.getSetting(INSTANCES_KEY, []) : [];
    const instances = (Array.isArray(configured) ? configured : []).map(normalizeInstance);
    // A instancia padrao sempre existe: e a que a GUI e o servico ja
    // compartilham, e remove-la derrubaria o pareamento existente.
    if (!instances.some((i) => i.Id === DEFAULT_ID)) instances.unshift(normalizeInstance({ Id: DEFAULT_ID, Name: 'Local', Auto: true }));
    return instances;
  }

  save(list) {
    if (this.config) this.config.setSetting(INSTANCES_KEY, list);
    return list;
  }

  find(id) {
    return this.list().find((i) => i.Id === id) || null;
  }

  managerFor(id) {
    if (this.managers.has(id)) return this.managers.get(id);
    const instance = this.find(id);
    if (!instance) return null;
    const manager = new SyncthingManager({
      logger: this.logger,
      installer: this.installer,
      daemon: new SyncthingDaemon({ logger: this.logger, installer: this.installer, home: instance.Home }),
    });
    this.managers.set(id, manager);
    return manager;
  }

  // Le o device ID direto do config.xml: nao exige daemon rodando, e sem isso
  // nao haveria como parear as duas instancias antes de subir qualquer uma.
  deviceIdOf(instance) {
    if (!isGenerated(instance.Home)) return '';
    return readInstanceId(instance.Home);
  }

  async create(name) {
    const slug = slugify(name);
    if (!slug) return { ok: false, error: 'network.instanceNeedsName' };
    if (this.find(slug)) return { ok: false, error: 'network.instanceExists' };

    const installed = await this.installer.checkInstalled();
    if (!installed.installed) return { ok: false, error: 'network.notInstalled' };

    const instance = normalizeInstance({ Id: slug, Name: name });
    const daemon = new SyncthingDaemon({ logger: this.logger, installer: this.installer, home: instance.Home });
    const generated = await daemon.generate(installed.path, installed.version.major);
    if (!generated) return { ok: false, error: 'network.instanceGenerateFailed' };

    this.save(this.list().concat([instance]));
    return { ok: true, instance, deviceID: this.deviceIdOf(instance) };
  }

  remove(id) {
    if (id === DEFAULT_ID) return { ok: false, error: 'network.cannotRemoveDefault' };
    const list = this.list().filter((i) => i.Id !== id);
    this.managers.delete(id);
    this.save(list);
    return { ok: true };
  }
}

// O device ID tambem esta no config.xml, no atributo do device local.
function readInstanceId(home) {
  const xmlPath = path.join(home, 'config.xml');
  if (!fs.existsSync(xmlPath)) return '';
  try {
    const match = fs.readFileSync(xmlPath, 'utf8').match(/<device id="([A-Z2-7-]+)"/);
    return match ? match[1] : '';
  } catch (e) {
    return '';
  }
}

module.exports = SyncInstances;
module.exports.SyncInstances = SyncInstances;
module.exports.INSTANCES_KEY = INSTANCES_KEY;
module.exports.DEFAULT_ID = DEFAULT_ID;
module.exports.slugify = slugify;
module.exports.normalizeInstance = normalizeInstance;
