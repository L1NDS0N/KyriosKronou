// syncthing/client.js - Cliente REST do Syncthing.
//
// Só Node puro, sem `electron`: o mesmo objeto é usado pelo app, pelo serviço
// headless e pelos testes. Nunca fala com um host que não seja o loopback - o
// Syncthing não tem autenticação real na API, e a API key dele é o único
// controle de acesso, então expô-la numa interface de rede seria uma porta
// aberta (a UI do Syncthing em si escuta em 127.0.0.1 por padrão).

const http = require('http');

const DEFAULT_PORT = 8384;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT = 10000;

class SyncthingApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'SyncthingApiError';
    this.status = status;
    this.body = body;
  }
}

class SyncthingClient {
  constructor(options = {}) {
    this.host = options.host || DEFAULT_HOST;
    this.port = Number(options.port) || DEFAULT_PORT;
    this.apiKey = options.apiKey || '';
    this.timeout = Number(options.timeout) || DEFAULT_TIMEOUT;
  }

  get baseUrl() { return `http://${this.host}:${this.port}`; }

  request(method, restPath, body) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const req = http.request({
        host: this.host,
        port: this.port,
        path: restPath,
        method,
        headers: Object.assign(
          { 'X-API-Key': this.apiKey },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
        ),
        timeout: this.timeout,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let parsed = text;
            try { parsed = JSON.parse(text); } catch (e) { /* resposta não-JSON */ }
            const message = parsed && parsed.error ? parsed.error : `HTTP ${res.statusCode}`;
            reject(new SyncthingApiError(message, res.statusCode, parsed));
            return;
          }
          if (!text) { resolve(null); return; }
          try { resolve(JSON.parse(text)); } catch (e) { resolve(text); }
        });
      });

      req.on('timeout', () => req.destroy(new Error(`Timeout apos ${this.timeout}ms em ${restPath}`)));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(p) { return this.request('GET', p); }
  post(p, body) { return this.request('POST', p, body); }
  put(p, body) { return this.request('PUT', p, body); }
  patch(p, body) { return this.request('PATCH', p, body); }
  del(p) { return this.request('DELETE', p); }

  systemStatus() { return this.get('/rest/system/status'); }
  connections() { return this.get('/rest/system/connections'); }
  discovery() { return this.get('/rest/system/discovery'); }
  shutdown() { return this.post('/rest/system/shutdown'); }

  config() { return this.get('/rest/config'); }
  replaceConfig(config) { return this.put('/rest/config', config); }
  restartRequired() { return this.get('/rest/config/restart-required'); }

  folders() { return this.get('/rest/config/folders'); }
  folder(id) { return this.get(`/rest/config/folders/${encodeURIComponent(id)}`); }
  putFolder(id, folder) { return this.put(`/rest/config/folders/${encodeURIComponent(id)}`, folder); }
  patchFolder(id, changes) { return this.patch(`/rest/config/folders/${encodeURIComponent(id)}`, changes); }
  deleteFolder(id) { return this.del(`/rest/config/folders/${encodeURIComponent(id)}`); }

  devices() { return this.get('/rest/config/devices'); }
  device(id) { return this.get(`/rest/config/devices/${encodeURIComponent(id)}`); }
  putDevice(id, device) { return this.put(`/rest/config/devices/${encodeURIComponent(id)}`, device); }
  patchDevice(id, changes) { return this.patch(`/rest/config/devices/${encodeURIComponent(id)}`, changes); }
  deleteDevice(id) { return this.del(`/rest/config/devices/${encodeURIComponent(id)}`); }

  // POST guarda a pasta como "send & receive" - o caminho feliz, o usuário
  // escolhe o tipo depois na UI.
  addFolder(folder) { return this.post('/rest/config/folders', folder); }

  statsDevice() { return this.get('/rest/stats/device'); }
  statsFolder() { return this.get('/rest/stats/folder'); }
  statsConnection() { return this.get('/rest/stats/connection'); }
  dbStatus(folder) {
    return this.get(`/rest/db/status${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`);
  }
  rescanFolder(folder) {
    return this.post(`/rest/db/scan?folder=${encodeURIComponent(folder)}`);
  }
}

module.exports = SyncthingClient;
module.exports.SyncthingClient = SyncthingClient;
module.exports.SyncthingApiError = SyncthingApiError;
module.exports.DEFAULT_PORT = DEFAULT_PORT;
module.exports.DEFAULT_HOST = DEFAULT_HOST;
