// tests/test-syncthing-network.js
//
// O controller é onde as duas metades se encontram: o cliente REST do Syncthing
// e o registro de autorização por GitHub. O ponto sensível é a interseção -
// salvar uma pasta compartilhada com um dispositivo não autorizado precisa
// falhar ANTES de a configuração chegar ao daemon.

const { expect } = require('chai');
const { SyncNetwork } = require('../src/main/syncthing/network');

const DEVICE_A = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
const DEVICE_B = 'IIIIIII-JJJJJJJ-KKKKKKK-LLLLLLL-MMMMMMM-NNNNNNN-OOOOOOO-PPPPPPP';
const ACTOR = { githubId: 4242, githubLogin: 'l1nds0n', isAdmin: false };

function fakeClient(overrides = {}) {
  return Object.assign({
    folders: async () => ([
      { id: 'docs', label: 'Docs', path: 'C:\\docs', type: 'sendreceive', devices: [{ deviceID: DEVICE_A }] },
    ]),
    devices: async () => ([
      { deviceID: DEVICE_A, name: 'Servidor', addresses: ['dynamic'] },
      { deviceID: DEVICE_B, name: 'Notebook', addresses: ['dynamic'] },
    ]),
    statsDevice: async () => ({ [DEVICE_A]: { deviceID: DEVICE_A, connected: true, lastSeen: '2026-01-01T00:00:00Z' } }),
    putFolder: async () => null,
    deleteFolder: async () => null,
    rescanFolder: async () => null,
    get: async () => null,
    post: async () => null,
  }, overrides);
}

function build(client, registry = []) {
  const config = {
    store: {},
    getSetting(key, def) { return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : def; },
    setSetting(key, value) { this.store[key] = value; },
  };
  config.setSetting('SyncNetworkDevices', registry);
  const manager = {
    ready: async () => ({ ok: true, client }),
    daemon: { status: async () => ({ ok: true, running: true, port: 8384, status: { myID: 'LOCAL' } }) },
  };
  const network = new SyncNetwork({ config });
  network.manager = manager;
  return network;
}

describe('Rede de sincronismo: controller', () => {
  it('marca como nao autorizada a pasta que compartilha com um dispositivo sem liberacao', async () => {
    const client = fakeClient({
      folders: async () => ([{ id: 'docs', label: 'Docs', path: 'C:\\docs', type: 'sendreceive', devices: [{ deviceID: DEVICE_B }] }]),
    });
    const network = build(client, [{ deviceID: DEVICE_A, githubId: 1, githubLogin: 'a' }]);
    const result = await network.folders();
    expect(result.folders[0].authorized).to.equal(false);
  });

  it('libera a pasta quando o unico dispositivo dela foi autorizado', async () => {
    const client = fakeClient();
    const network = build(client, [{ deviceID: DEVICE_A, githubId: 1, githubLogin: 'a' }]);
    const result = await network.folders();
    expect(result.folders[0].authorized).to.equal(true);
  });

  it('recusa gravar uma pasta compartilhada com dispositivo nao autorizado', async () => {
    let written = null;
    const client = fakeClient({ putFolder: async (id, folder) => { written = { id, folder }; } });
    const network = build(client, []);
    const result = await network.saveFolder({ id: 'docs', label: 'Docs', path: 'C:\\docs', type: 'sendreceive', devices: [{ deviceID: DEVICE_B }] });
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('network.deviceNotAuthorized');
    expect(result.blocked).to.deep.equal([DEVICE_B]);
    expect(written).to.equal(null);
  });

  it('grava a pasta quando todos os dispositivos estao autorizados', async () => {
    let written = null;
    const client = fakeClient({ putFolder: async (id, folder) => { written = { id, folder }; } });
    const network = build(client, [{ deviceID: DEVICE_A, githubId: 1, githubLogin: 'a' }]);
    const result = await network.saveFolder({ id: 'docs', label: 'Docs', path: 'C:\\docs', type: 'sendreceive', devices: [{ deviceID: DEVICE_A }] });
    expect(result.ok).to.equal(true);
    expect(written.id).to.equal('docs');
  });

  it('exige um id de pasta', async () => {
    const network = build(fakeClient(), []);
    const result = await network.saveFolder({ label: 'Sem id', path: 'C:\\x' });
    expect(result.ok).to.equal(false);
    expect(result.error).to.equal('network.folderNeedsId');
  });

  it('normaliza a pasta antes de gravar, em vez de confiar no renderer', async () => {
    let written = null;
    const client = fakeClient({ putFolder: async (id, folder) => { written = folder; } });
    const network = build(client, []);
    await network.saveFolder({ id: 'docs', path: 'C:\\docs', type: 'receiveonly', sendOwnership: true, syncOwnership: true });
    expect(written.type).to.equal('receiveonly');
    expect(written.sendOwnership).to.equal(false);
    expect(written.fsWatcherEnabled).to.equal(true);
    expect(written.rescanIntervalS).to.equal(3600);
  });

  it('cruza a autorização do dispositivo com os dados de conexão', async () => {
    const network = build(fakeClient(), [{ deviceID: DEVICE_A, githubId: 7, githubLogin: 'l1nds0n' }]);
    const result = await network.devices();
    const a = result.devices.find((d) => d.deviceID === DEVICE_A);
    const b = result.devices.find((d) => d.deviceID === DEVICE_B);
    expect(a.authorized).to.equal(true);
    expect(a.githubLogin).to.equal('l1nds0n');
    expect(a.connected).to.equal(true);
    expect(b.authorized).to.equal(false);
    expect(b.githubLogin).to.equal('');
  });

  it('persiste e revoga a autorização', async () => {
    const network = build(fakeClient(), []);
    const granted = await network.authorizeDevice({ deviceID: DEVICE_A, githubId: 4242, githubLogin: 'l1nds0n' }, ACTOR);
    expect(granted.ok).to.equal(true);
    expect(network.deviceRegistry()).to.have.length(1);

    await network.revokeDevice(DEVICE_A);
    expect(network.deviceRegistry()).to.have.length(0);
  });

  it('nao persiste uma autorização recusada', async () => {
    const network = build(fakeClient(), []);
    const refused = await network.authorizeDevice({ deviceID: DEVICE_A, githubLogin: 'l1nds0n' }, ACTOR);
    expect(refused.ok).to.equal(false);
    expect(network.deviceRegistry()).to.have.length(0);
  });

  it('traduz o motivo do daemon para uma chave de i18n em vez de vazar string técnica', async () => {
    const network = build(fakeClient(), []);
    network.installer.checkInstalled = async () => ({ installed: false });
    const result = await network.status();
    expect(result.installed).to.equal(false);
    expect(result.reason).to.equal('network.notInstalled');
  });

  it('lê e grava os filtros de exclusão da pasta', async () => {
    let posted = null;
    const client = fakeClient({
      get: async () => ({ ignore: ['*.tmp', '.git/'] }),
      post: async (route, body) => { posted = { route, body }; },
    });
    const network = build(client, []);
    const read = await network.ignores('docs');
    expect(read.ignores).to.deep.equal(['*.tmp', '.git/']);

    await network.saveIgnores('docs', ['*.log']);
    expect(posted.body).to.deep.equal({ ignore: ['*.log'] });
    expect(posted.route).to.contain('/rest/db/ignores');
  });
});
