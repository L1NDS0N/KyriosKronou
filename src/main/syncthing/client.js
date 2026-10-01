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

// Nomes que o loopback assume no Windows. 'localhost' passa porque o resolução
// local nunca sai da máquina, e o Syncthing ouve em todas as formas de
// loopback ao mesmo tempo.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1', '127.0.0.53']);

function isLoopback(host) {
  const h = String(host || '').trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  // Todo o bloco 127.0.0.0/8 é loopback, não só o .1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

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

  // A única proteção que a API key do Syncthing tem: o Syncthing não
  // autentica requisição nenhuma, e quem tiver a key controla tudo. A barreira
  // é não sair da máquina. '0.0.0.0' parece loopback e não é: é o endereço que
  // o daemon escuta em TODA interface, então um host remoto apontando para ele
  // receberia a key num pacote que sai da máquina.
  assertLoopback() {
    if (!isLoopback(this.host)) {
      throw new Error(`Refusing to talk to Syncthing at a non-loopback host (${this.host}): the API key is the only access control`);
    }
    return true;
  }

  request(method, restPath, body) {
    return new Promise((resolve, reject) => {
      try { this.assertLoopback(); } catch (e) { reject(e); return; }
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
  // /rest/db/status devolve 404 na v2; acompletion é o que responde agora e é
  // o que diz se a pasta terminou de sincronizar.
  dbCompletion(folder) {
    return this.get(`/rest/db/completion?folder=${encodeURIComponent(folder)}`);
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
module.exports.isLoopback = isLoopback;
