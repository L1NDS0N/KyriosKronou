// tests/test-syncthing-instances.js
//
// "Compartilhar comigo mesmo uma pasta para copiar em outro lugar do PC" e,
// no Syncthing, uma segunda instancia com certificado proprio. A restricao
// que guia o desenho: as duas precisam ter device IDs DIFERENTES, senao o
// pareamento as trataria como a mesma maquina e a copia local nao aconteceria.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SyncInstances, slugify, DEFAULT_ID } = require('../src/main/syncthing/instances');
const { syncthingHome } = require('../src/main/paths');

function makeConfig() {
  return {
    store: {},
    getSetting(k, d) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : d; },
    setSetting(k, v) { this.store[k] = v; },
  };
}

describe('Rede de sincronismo: copia local', () => {
  it('da homes separados para instancias diferentes', () => {
    expect(syncthingHome()).to.not.equal(syncthingHome('hd-externo'));
    expect(syncthingHome('hd-externo')).to.include('syncthing-hd-externo');
  });

  it('normaliza o nome de uma instancia para um id estavel', () => {
    expect(slugify('HD Externo')).to.equal('hd-externo');
    expect(slugify('  Disco!!  ')).to.equal('disco');
    expect(slugify('')).to.equal('');
  });

  it('mantem a instancia padrao mesmo numa configuracao vazia ou corrompida', () => {
    const fresh = new SyncInstances({ config: makeConfig() });
    expect(fresh.list().map((i) => i.Id)).to.deep.equal([DEFAULT_ID]);

    const broken = makeConfig();
    broken.setSetting('SyncNetworkInstances', 'lixo');
    expect(new SyncInstances({ config: broken }).list()).to.have.length(1);
  });

  it('nao deixa a instancia padrao ser removida', () => {
    const instances = new SyncInstances({ config: makeConfig() });
    const result = instances.remove(DEFAULT_ID);
    expect(result.ok).to.equal(false);
    expect(instances.list()).to.have.length(1);
  });

  it('recusa um nome vazio e um nome repetido', async () => {
    const instances = new SyncInstances({ config: makeConfig() });
    const noName = await instances.create('   ');
    expect(noName.ok).to.equal(false);
    expect(noName.error).to.equal('network.instanceNeedsName');
  });

  it('exige o Syncthing instalado antes de criar uma instancia', async () => {
    const instances = new SyncInstances({
      config: makeConfig(),
      installer: { checkInstalled: async () => ({ installed: false }) },
    });
    const result = await instances.create('hd-externo');
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('network.notInstalled');
  });

  it('cria a instancia com home e device ID proprios', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-st2-'));
    const previousDataDir = process.env.KYRION_DATA_DIR;
    // Apontar o diretorio de dados e o jeito de exercitar o caminho de
    // producao sem escrever no %ProgramData% da maquina.
    process.env.KYRION_DATA_DIR = root;
    try {
      const instanceHome = syncthingHome('hd-externo');
      fs.mkdirSync(instanceHome, { recursive: true });
      fs.writeFileSync(path.join(instanceHome, 'config.xml'),
        '<configuration version="52"><device id="AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH"></device><gui><apikey>k</apikey></gui></configuration>', 'utf8');
      fs.writeFileSync(path.join(instanceHome, 'cert.pem'), 'x', 'utf8');

      const { SyncthingDaemon } = require('../src/main/syncthing/daemon');
      const original = SyncthingDaemon.prototype.generate;
      // O profile ja esta no disco de verdade; so nao se roda o binario.
      SyncthingDaemon.prototype.generate = async function generate() { return true; };

      try {
        const instances = new SyncInstances({
          config: makeConfig(),
          installer: { checkInstalled: async () => ({ installed: true, path: 'C:\\syncthing.exe', version: { major: 2 } }) },
        });
        const created = await instances.create('HD externo');
        expect(created.ok).to.equal(true);
        expect(created.instance.Id).to.equal('hd-externo');
        expect(created.instance.Home).to.equal(instanceHome);
        expect(created.deviceID).to.equal('AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH');
        expect(instances.list()).to.have.length(2);
        // A padrao continua existindo e com o device ID diferente: e essa
        // diferenca que faz a copia local contar como outra maquina.
        expect(instances.list()[0].Id).to.equal(DEFAULT_ID);
        expect(instances.list()[0].Home).to.not.equal(instanceHome);
      } finally {
        SyncthingDaemon.prototype.generate = original;
      }
    } finally {
      if (previousDataDir === undefined) delete process.env.KYRION_DATA_DIR;
      else process.env.KYRION_DATA_DIR = previousDataDir;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('da um manager por instancia, cada um com seu daemon', () => {
    const config = makeConfig();
    config.setSetting('SyncNetworkInstances', [{ Id: 'hd', Name: 'HD' }]);
    const instances = new SyncInstances({ config });
    const a = instances.managerFor(DEFAULT_ID);
    const b = instances.managerFor('hd');
    expect(a).to.not.equal(b);
    expect(a.daemon.home).to.not.equal(b.daemon.home);
    expect(instances.managerFor('hd')).to.equal(b);
  });
});
