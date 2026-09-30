// tests/test-syncthing.js
//
// The Kyrios sync network drives an external Syncthing daemon. Three things
// here are load-bearing and easy to regress silently:
//
//  - the CLI flags changed shape between Syncthing v1 and v2, and getting them
//    wrong makes the binary silently open a brand new profile instead of ours;
//  - the folder metadata flags have invariants (send-only-to-others settings
//    are meaningless on a receive-only folder, and "send" is implied by
//    "sync"), which the Syncthing GUI only reports in a log line afterwards;
//  - the daemon home must not fall back to %LOCALAPPDATA%, or the service ends
//    up with a second identity.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseVersion, parseLatestVersion, candidatePaths, MIN_MAJOR } = require('../src/main/syncthing/installer');
const { readApiKey, isGenerated, SyncthingDaemon } = require('../src/main/syncthing/daemon');
const manager = require('../src/main/syncthing/manager');
const { syncthingHome } = require('../src/main/paths');

describe('Syncthing: deteccao de binario e versao', () => {
  it('reads the version out of the v1 "syncthing version" output', () => {
    const parsed = parseVersion('syncthing version v1.30.0 (go1.24.5 windows-amd64)');
    expect(parsed.major).to.equal(1);
    expect(parsed.text).to.equal('1.30.0');
  });

  it('reads the version out of the v2 output, which drops the "version" word', () => {
    const parsed = parseVersion('syncthing v2.1.4 (go1.24.5 windows-amd64)');
    expect(parsed.major).to.equal(2);
    expect(parsed.text).to.equal('2.1.4');
  });

  it('refuses to invent a version it cannot parse', () => {
    expect(parseVersion('command not found')).to.equal(null);
    expect(parseVersion('')).to.equal(null);
  });

  it('looks where chocolatey actually puts the executable', () => {
    const candidates = candidatePaths();
    expect(candidates.some((p) => p.includes('chocolatey') && p.endsWith('syncthing.exe'))).to.equal(true);
    expect(candidates.every((p) => p.toLowerCase().endsWith('syncthing.exe'))).to.equal(true);
  });

  it('pins the newest available version instead of whatever is latest at install time', () => {
    expect(parseLatestVersion('syncthing|2.1.5\n')).to.equal('2.1.5');
    expect(parseLatestVersion('syncthing|2.0.16\nsyncthing|2.1.5\n')).to.equal('2.0.16');
    expect(parseLatestVersion('nada aqui')).to.equal(null);
    expect(parseLatestVersion('')).to.equal(null);
  });

  it('targets the current Syncthing major line', () => {
    expect(MIN_MAJOR).to.be.at.least(2);
  });
});

describe('Syncthing: home do daemon', () => {
  it('lives under %ProgramData% so the service and the GUI share one identity', () => {
    expect(syncthingHome().toLowerCase()).to.not.include('appdata');
    expect(path.basename(syncthingHome())).to.equal('syncthing');
  });

  it('reads the API key out of config.xml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-st-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'config.xml'),
        '<configuration version="37"><gui enabled="true"><address>127.0.0.1:8384</address><apikey>abc123XYZ</apikey></gui></configuration>',
        'utf8'
      );
      expect(readApiKey(dir)).to.equal('abc123XYZ');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty key rather than throwing on a missing or broken config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-st-'));
    try {
      expect(readApiKey(dir)).to.equal('');
      fs.writeFileSync(path.join(dir, 'config.xml'), 'lixo sem apikey', 'utf8');
      expect(readApiKey(dir)).to.equal('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('knows a profile is only usable once config and certificate both exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-st-'));
    try {
      expect(isGenerated(dir)).to.equal(false);
      fs.writeFileSync(path.join(dir, 'config.xml'), '<configuration/>', 'utf8');
      expect(isGenerated(dir)).to.equal(false);
      fs.writeFileSync(path.join(dir, 'cert.pem'), 'x', 'utf8');
      expect(isGenerated(dir)).to.equal(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Syncthing: argumentos de CLI por versao', () => {
  const daemon = new SyncthingDaemon({ home: 'C:\\data\\syncthing', installer: null });

  it('uses the v1 flags for a v1 binary', () => {
    const args = daemon.serveArgs(1, 8384);
    expect(args).to.include('-home=C:\\data\\syncthing');
    expect(args).to.include('-gui-address=127.0.0.1:8384');
    expect(args).to.not.include('serve');
  });

  it('uses the v2 subcommand flags for a v2 binary', () => {
    const args = daemon.serveArgs(2, 8384);
    expect(args[0]).to.equal('serve');
    expect(args).to.include('--home');
    expect(args).to.include('C:\\data\\syncthing');
    expect(args.some((a) => a.startsWith('-home='))).to.equal(false);
  });

  it('never lets Syncthing upgrade its own binary behind our back', () => {
    expect(daemon.serveArgs(1, 8384)).to.include('-no-upgrade');
    expect(daemon.serveArgs(2, 8384)).to.include('--no-upgrade');
  });

  it('generates the profile in the same home it later serves from', () => {
    expect(daemon.generateArgs(1)).to.include('-home=C:\\data\\syncthing');
    expect(daemon.generateArgs(2).slice(0, 2)).to.deep.equal(['generate', '--home']);
    expect(daemon.generateArgs(2)).to.include('C:\\data\\syncthing');
  });
});

describe('Syncthing: invariantes de pasta', () => {
  const base = { id: 'docs', label: 'Docs', path: 'C:\\docs', type: 'sendreceive' };

  it('defaults to watch enabled and a sane rescan interval', () => {
    const folder = manager.normalizeFolder(base);
    expect(folder.fsWatcherEnabled).to.equal(true);
    expect(folder.rescanIntervalS).to.equal(3600);
  });

  it('keeps a valid folder type and rejects an unknown one', () => {
    expect(manager.normalizeFolder(base).type).to.equal('sendreceive');
    expect(manager.normalizeFolder(Object.assign({}, base, { type: 'readwrite' })).type).to.equal('sendreceive');
    expect(manager.normalizeFolder(Object.assign({}, base, { type: 'receiveonly' })).type).to.equal('receiveonly');
    expect(manager.normalizeFolder(Object.assign({}, base, { type: 'receiveencrypted' })).type).to.equal('receiveencrypted');
  });

  it('turns ownership sending off on a receive-only folder', () => {
    const folder = manager.normalizeFolder(Object.assign({}, base, {
      type: 'receiveonly', syncOwnership: true, syncXattrs: true,
    }));
    expect(folder.syncOwnership).to.equal(true);
    expect(folder.sendOwnership).to.equal(false);
    expect(folder.syncXattrs).to.equal(true);
    expect(folder.sendXattrs).to.equal(false);
  });

  it('implies send when sync is on, for both ownership and extended attributes', () => {
    const folder = manager.normalizeFolder(Object.assign({}, base, { syncOwnership: 'true', syncXattrs: true }));
    expect(folder.sendOwnership).to.equal(true);
    expect(folder.sendXattrs).to.equal(true);
  });

  it('normalizes versioning and fills the params each type requires', () => {
    expect(manager.normalizeVersioning(null).type).to.equal('off');
    expect(manager.normalizeVersioning({ type: 'nao-existe' }).type).to.equal('off');
    const staggered = manager.normalizeVersioning({ type: 'staggered', params: {} });
    expect(staggered.params.maxAge).to.be.above(0);
    expect(staggered.params.cleanIntervalDays).to.equal(30);
    expect(manager.normalizeVersioning({ type: 'simple', params: {} }).params.keep).to.equal(5);
    expect(manager.normalizeVersioning({ type: 'trashcan', params: {} }).params.cleanoutDays).to.equal(30);
  });
});

describe('Syncthing: leitura de dispositivos', () => {
  it('normalizes the device ID and detects a dynamic address', () => {
    const device = manager.normalizeDevice({ id: 'AAA-BBB', name: 'Notebook', addresses: ['dynamic'] });
    expect(device.deviceID).to.equal('AAA-BBB');
    expect(device.dynamic).to.equal(true);
    expect(device.paused).to.equal(false);
  });

  it('treats a fixed address as not dynamic', () => {
    const device = manager.normalizeDevice({ deviceID: 'AAA-BBB', addresses: ['tcp://192.168.0.10:22000'] });
    expect(device.dynamic).to.equal(false);
  });
});

describe('Syncthing: dashboard de metricas', () => {
  const client = {
    systemStatus: async () => ({ myID: 'LOCAL-ID', startTime: Date.now() - 5000 }),
    statsConnection: async () => ({
      total: {
        inRate: 1, outRate: 2, inBytesTotal: 1024, outBytesTotal: 2048,
        inListenAddrsOk: 3, inListenAddrsCount: 3, connections: 2,
      },
    }),
    statsFolder: async () => ({ docs: { files: 100, dirs: 10, bytes: 500 }, fotos: { files: 33, dirs: 4, bytes: 100 } }),
    statsDevice: async () => ({ 'REMOTE-1': { deviceID: 'REMOTE-1', deviceName: 'Servidor', connected: true, lastSeen: '2026-01-01T00:00:00Z' } }),
    get: async () => ({ version: 'v2.1.4', os: 'windows', arch: 'amd64', longVersion: 'syncthing v2.1.4' }),
    discovery: async () => ({ global: { enabled: true, ok: true, devices: ['a', 'b', 'c', 'd'] } }),
  };

  it('summarises the dashboard rows', async () => {
    const view = await manager.overview(client);
    expect(view.deviceID).to.equal('LOCAL-ID');
    expect(view.running).to.equal(true);
    expect(view.receive).to.deep.equal({ rate: 1, bytes: 1024 });
    expect(view.send).to.deep.equal({ rate: 2, bytes: 2048 });
    expect(view.localState).to.deep.equal({ files: 133, directories: 14, bytes: 600 });
    expect(view.listeners).to.deep.equal({ ok: 3, total: 3 });
    expect(view.discovery.devices).to.equal(4);
    expect(view.uptimeMs).to.be.above(0);
  });

  it('still renders when some stats endpoints are unavailable', async () => {
    const flaky = Object.assign({}, client, {
      statsFolder: async () => { throw new Error('offline'); },
      discovery: async () => { throw new Error('offline'); },
    });
    const view = await manager.overview(flaky);
    expect(view.localState).to.deep.equal({ files: 0, directories: 0, bytes: 0 });
    expect(view.discovery.available).to.equal(false);
    expect(view.discovery.devices).to.equal(0);
  });

  it('reports the device list with its connection state', async () => {
    const view = await manager.overview(client);
    expect(view.devices).to.have.length(1);
    expect(view.devices[0].name).to.equal('Servidor');
    expect(view.devices[0].connected).to.equal(true);
  });
});
