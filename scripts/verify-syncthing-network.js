// Roteiro de validação: usa exatamente o instalador e o daemon que o app usa,
// para provar o caminho de produção em vez de uma reimplementação do script.
const path = require('path');
const { SyncthingInstaller } = require('../src/main/syncthing/installer');
const { SyncNetwork } = require('../src/main/syncthing/network');
const paths = require('../src/main/paths');

const log = (level, m) => console.log(`[${level}] ${m}`);
const fakeLogger = { log };

(async () => {
  const config = {
    store: {},
    getSetting(k, d) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : d; },
    setSetting(k, v) { this.store[k] = v; },
  };
  const network = new SyncNetwork({ logger: fakeLogger, config });

  console.log('home =', paths.syncthingHome());

  let status = await network.status();
  console.log('antes:', JSON.stringify(status));

  if (!status.installed) {
    console.log('instalando...');
    const result = await network.install();
    console.log('install:', JSON.stringify({ success: result.success, step: result.step, path: result.path, version: result.version, message: result.message }));
    status = await network.status();
    console.log('depois:', JSON.stringify(status));
    if (!status.installed) process.exit(1);
  }

  console.log('subindo daemon...');
  const started = await network.start();
  console.log('start:', JSON.stringify(started));
  if (!started.success) process.exit(2);

  const overview = await network.overview();
  console.log('overview:', JSON.stringify(overview, null, 2));
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e); process.exit(9); });
