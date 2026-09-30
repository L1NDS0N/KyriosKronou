const fs = require('fs');
const path = require('path');
const { SyncthingClient } = require('../src/main/syncthing/client');

const home = path.join(process.env.ProgramData, 'KyriosChronos', 'syncthing');
const apiKey = fs.readFileSync(path.join(home, 'config.xml'), 'utf8').match(/<apikey>([^<]*)<\/apikey>/)[1].trim();
const client = new SyncthingClient({ port: 8384, apiKey });

const ENDPOINTS = [
  '/rest/metrics',
  '/rest/stats/folder',
  '/rest/db/completion',
  '/rest/system/discovery',
  '/rest/config',
  '/rest/debug',
];

(async () => {
  for (const ep of ENDPOINTS) {
    try {
      const body = await client.get(ep);
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      console.log(`\n### ${ep} -> OK (${text.length})`);
      console.log('  ' + text.slice(0, 600).replace(/\n/g, '\n  '));
    } catch (e) {
      console.log(`\n### ${ep} -> ${e.status}`);
    }
  }
})();
