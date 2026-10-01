// tests/test-syncthing-client.js
//
// O cliente do Syncthing fala com uma API que não tem autenticação real: a API
// key é o único controle de acesso, e a proteção inteira depende de a requisição
// nunca sair da máquina. Até agora todo teste injetava um dublê e essa barreira
// nunca era exercitada de verdade.
//
// Aqui sobe um HTTP de verdade em 127.0.0.1 e o cliente conversa com ele.

const { expect } = require('chai');
const http = require('http');
const net = require('net');

const { SyncthingClient, SyncthingApiError } = require('../src/main/syncthing/client');

// Servidor mínimo que registra o que recebeu e devolve o que o teste pedir.
function fakeServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

describe('Syncthing client: a barreira de loopback', () => {
  it('fala com o daemon real na porta que foi passada', async () => {
    let seen = null;
    const server = await fakeServer((req, res) => {
      seen = { url: req.url, method: req.method, key: req.headers['x-api-key'] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ myID: 'LOCAL-ID', uptime: 42 }));
    });
    const port = server.address().port;
    try {
      const client = new SyncthingClient({ port, apiKey: 'chave-de-teste' });
      const status = await client.systemStatus();
      expect(status.myID).to.equal('LOCAL-ID');
      expect(seen.method).to.equal('GET');
      expect(seen.url).to.equal('/rest/system/status');
      // A API key viaja no cabeçalho; sem ela o Syncthing devolve 403.
      expect(seen.key).to.equal('chave-de-teste');
    } finally { server.close(); }
  });

  it('a URL da requisição é sempre loopback, mesmo se outro host for informado', async () => {
    // Passar um host de rede é um erro de configuração que abriria a porta;
    // a cliente recusa antes de sair.
    const client = new SyncthingClient({ host: '192.168.0.50', port: 8384, apiKey: 'x' });
    const resultado = await client.systemStatus().then(() => ({ ok: true }), (e) => ({ ok: false, erro: e }));
    expect(resultado.ok).to.equal(false);
    expect(resultado.erro.message).to.match(/loopback/i);
  });

  it('aceita os nomes que o loopback costuma assumir', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.53']) {
      const client = new SyncthingClient({ host, port: 8384 });
      expect(client.host).to.equal(host);
    }
  });

  it('recusa 0.0.0.0, que escuta em toda interface', () => {
    const client = new SyncthingClient({ host: '0.0.0.0', port: 8384 });
    expect(() => new SyncthingClient({ host: '0.0.0.0', port: 8384 }).assertLoopback()).to.throw(/loopback/i);
    expect(client.host).to.equal('0.0.0.0');
  });
});

describe('Syncthing client: erros e tempo', () => {
  it('transforma um erro do Syncthing em erro com status e corpo', async () => {
    const server = await fakeServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'folder not found' }));
    });
    const port = server.address().port;
    try {
      const client = new SyncthingClient({ port, apiKey: 'k' });
      let recebido = null;
      try { await client.folder('inexistente'); } catch (e) { recebido = e; }
      expect(recebido).to.be.instanceOf(SyncthingApiError);
      expect(recebido.status).to.equal(404);
      // A mensagem do Syncthing vale mais que o código: ela diz o que faltou.
      expect(recebido.message).to.equal('folder not found');
      expect(recebido.body.error).to.equal('folder not found');
    } finally { server.close(); }
  });

  it('não some com um corpo não-JSON', async () => {
    const server = await fakeServer((req, res) => {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<html>deu ruim</html>');
    });
    const port = server.address().port;
    try {
      const client = new SyncthingClient({ port, apiKey: 'k' });
      let recebido = null;
      try { await client.config(); } catch (e) { recebido = e; }
      expect(recebido.status).to.equal(500);
      expect(recebido.message).to.equal('HTTP 500');
    } finally { server.close(); }
  });

  it('devolve null quando a resposta é vazia em vez de quebrar o parse', async () => {
    const server = await fakeServer((req, res) => { res.writeHead(200); res.end(); });
    const port = server.address().port;
    try {
      const client = new SyncthingClient({ port, apiKey: 'k' });
      expect(await client.shutdown()).to.equal(null);
    } finally { server.close(); }
  });

  it('devolve o texto quando a resposta não é JSON', async () => {
    const server = await fakeServer((req, res) => { res.writeHead(200); res.end('texto simples'); });
    const port = server.address().port;
    try {
      const client = new SyncthingClient({ port, apiKey: 'k' });
      expect(await client.get('/qualquer')).to.equal('texto simples');
    } finally { server.close(); }
  });

  it('desiste no tempo configurado em vez de esperar para sempre', async function () {
    this.timeout(15000);
    // Um servidor que aceita a conexão e nunca responde é o caso real de um
    // daemon travado: sem timeout, a chamada ficaria pendurada para sempre e
    // o serviço inteiro pararia de responder.
    const server = await fakeServer(() => { /* de propósito não responde */ });
    const port = server.address().port;
    try {
      const client = new SyncthingClient({ port, apiKey: 'k', timeout: 600 });
      let erro = null;
      try { await client.systemStatus(); } catch (e) { erro = e; }
      expect(erro, 'a requisição precisa desistir').to.not.equal(null);
      expect(erro.message).to.match(/timeout/i);
    } finally { server.close(); }
  });

  it('diz que não respondeu quando a porta está fechada', async () => {
    const livre = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    });
    const client = new SyncthingClient({ port: livre, apiKey: 'k', timeout: 3000 });
    let erro = null;
    try { await client.systemStatus(); } catch (e) { erro = e; }
    expect(erro).to.not.equal(null);
    // Conexão recusada é diferente de timeout: a UI precisa distinguir
    // "daemon parado" de "daemon travado".
    expect(erro.code).to.match(/ECONNREFUSED|EINVAL|ECONNRESET/);
  });
});

describe('Syncthing client: verbos e rotas', () => {
  let server;
  let recebidas;

  beforeEach(async () => {
    recebidas = [];
    server = await fakeServer((req, res) => {
      recebidas.push({ method: req.method, url: req.url });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
  });
  afterEach(() => { server.close(); });

  const client = () => new SyncthingClient({ port: server.address().port, apiKey: 'k' });

  it('mapeia cada método no verbo HTTP certo', async () => {
    const c = client();
    await c.get('/a');
    await c.post('/b', { x: 1 });
    await c.put('/c', { x: 1 });
    await c.patch('/d', { x: 1 });
    await c.del('/e');
    expect(recebidas.map((r) => `${r.method} ${r.url}`)).to.deep.equal([
      'GET /a', 'POST /b', 'PUT /c', 'PATCH /d', 'DELETE /e',
    ]);
  });

  it('envia o corpo como JSON', async () => {
    const corpos = [];
    const s2 = await fakeServer((req, res) => {
      readBody(req).then((corpo) => {
        corpos.push({ tipo: req.headers['content-type'], corpo });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    try {
      const c = new SyncthingClient({ port: s2.address().port, apiKey: 'k' });
      await c.putFolder('docs', { label: 'Docs', type: 'sendreceive' });
      expect(corpos[0].tipo).to.equal('application/json');
      expect(JSON.parse(corpos[0].corpo)).to.deep.equal({ label: 'Docs', type: 'sendreceive' });
    } finally { s2.close(); }
  });

  it('codifica o id da pasta na rota, para não quebrar com barra ou espaço', async () => {
    const c = client();
    await c.folder('minha pasta/com barra');
    await c.patchFolder('minha pasta/com barra', { paused: true });
    await c.deleteFolder('minha pasta/com barra');
    expect(recebidas[0].url).to.equal('/rest/config/folders/minha%20pasta%2Fcom%20barra');
    expect(recebidas[1].url).to.equal('/rest/config/folders/minha%20pasta%2Fcom%20barra');
    expect(recebidas[2].url).to.equal('/rest/config/folders/minha%20pasta%2Fcom%20barra');
  });

  it('leva a pasta como parâmetro nas rotas de db', async () => {
    const c = client();
    await c.dbCompletion('minha pasta');
    await c.rescanFolder('minha pasta');
    expect(recebidas[0].url).to.equal('/rest/db/completion?folder=minha%20pasta');
    expect(recebidas[1].url).to.equal('/rest/db/scan?folder=minha%20pasta');
    expect(recebidas[1].method).to.equal('POST');
  });

  it('cobre as rotas que a tela e o controlador usam', () => {
    const c = client();
    const metodos = ['systemStatus', 'connections', 'discovery', 'config', 'folders', 'devices',
      'statsDevice', 'statsFolder', 'dbCompletion', 'restartRequired'];
    for (const m of metodos) {
      expect(typeof c[m], m).to.equal('function');
    }
  });
});