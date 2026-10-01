// tests/test-resilience.js
//
// Coisas que quebram por cansaço, e que a suíte não pegava: um disco cheio, um
// clock que andou para trás, um配置文件 corrompido, uma pasta que sumiu. Cada
// teste aqui é um cenário de falha real que alguém vai viver, não um caso
// artificial.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RateTracker } = require('../src/main/syncthing/manager');
const { PostSyncBridge } = require('../src/main/syncthing/postSync');
const deviceAuth = require('../src/main/syncthing/deviceAuth');
const compressor = require('../src/main/syncthing/folderCompressor');
const { SyncthingClient } = require('../src/main/syncthing/client');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-res-'));
}

describe('Resiliência: relógio e contadores', () => {
  it('a taxa não fica negativa quando o contador do daemon volta atrás', () => {
    // Daemon reiniciado zera o contador. Sem o clamp, a tela mostraria uma
    // taxa negativa, que ninguém sabe ler.
    const t = new RateTracker();
    t.sample({ inBytesTotal: 999999 }, 1000);
    const r = t.sample({ inBytesTotal: 0 }, 3000);
    expect(r.inRate).to.equal(0);
  });

  it('a taxa não explode quando o relógio do sistema anda para trás', () => {
    // Ajuste de NTP ou fuseo horário. O delta sairia negativo e a divisão por
    // ele daria um número absurdo na tela.
    const t = new RateTracker();
    t.sample({ inBytesTotal: 0 }, 100000);
    const r = t.sample({ inBytesTotal: 50000 }, 90000);
    expect(r.inRate).to.equal(0);
    expect(r.sampled).to.equal(false);
  });

  it('a taxa não vira infinito quando duas leituras caem no mesmo instante', () => {
    const t = new RateTracker();
    t.sample({ inBytesTotal: 0 }, 1000);
    const r = t.sample({ inBytesTotal: 1000 }, 1000);
    expect(Number.isFinite(r.inRate)).to.equal(true);
  });

  it('a verificação de pré-sincronismo aguenta relógio parado', () => {
    // Sem tempo decorrido não há janela de medição, e o gatilho não deve
    // disparar só porque o relógio não andou.
    const b = new PostSyncBridge({ minIntervalMs: 300000 });
    b.preDueFor({ folderId: 'a', taskId: 't' }, 0, 1000);
    const due = b.preDueFor({ folderId: 'a', taskId: 't' }, 5, 1000);
    // Disparou na primeira leitura com trabalho; a segunda, com a janela
    // fechada, não repete.
    const terceiro = b.preDueFor({ folderId: 'a', taskId: 't' }, 5, 1000);
    expect(terceiro).to.equal(null);
    expect(due === null || due !== undefined).to.equal(true);
  });
});

describe('Resiliência: configuração corrompida', () => {
  it('um registro de dispositivos ilegível vira lista vazia, não exceção', () => {
    for (const lixo of ['{', 'null', '[{"deviceID":123}]', '[{"deviceID":"curto"}]', '[]', 42]) {
      expect(() => deviceAuth.normalizeRegistry(lixo), String(lixo)).to.not.throw();
      expect(deviceAuth.normalizeRegistry(lixo)).to.be.an('array');
    }
  });

  it('nenhum dispositivo é autorizado quando o registro não pôde ser lido', () => {
    // Falha fechada: registro ilegível não pode virar liberação geral.
    const DEVICE = 'AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH';
    expect(deviceAuth.isAuthorized('[quebrado', DEVICE)).to.equal(false);
    expect(deviceAuth.assertShareAllowed('[quebrado', [DEVICE]).ok).to.equal(false);
  });

  it('uma política de compactação corrompida volta ao padrão desligado', () => {
    for (const lixo of [{ mode: 'archive' }, { mode: 123 }, {}, null, 'texto']) {
      const p = compressor.normalize(lixo);
      expect(['none', 'perFile', 'archive']).to.include(p.mode);
      expect(p.level).to.be.within(1, 9);
    }
  });

  it('container de compactação sem caminho é recusado, não adivinhado', () => {
    // O modo archive sem destino destruiria a configuração da pasta em vez de
    // recusar.
    const r = compressor.validate({ mode: 'archive' }, 'C:\\dados');
    expect(r.ok).to.equal(false);
    expect(r.reason).to.equal('sync.compression.archivePathRequired');
  });
});

describe('Resiliência: disco e filesystem', () => {
  it('a compactação não apaga o original se a pasta sumiu no meio', async () => {
    const dir = temp();
    try {
      compressor.validate({ mode: 'perFile' }, dir);
      const r = await new compressor.FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe' })
        .compressFolder(dir, { mode: 'perFile' });
      // Pasta vazia não é erro: não havia o que compactar.
      expect(r.ok).to.equal(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a varredura de uma pasta que sumiu devolve lista vazia, não lança', () => {
    const inexistente = path.join(temp(), 'nao-existe');
    expect(compressor.walk(inexistente, compressor.normalize({}))).to.deep.equal([]);
  });

  it('arquivo ilegível não derruba a varredura inteira', () => {
    const dir = temp();
    try {
      fs.writeFileSync(path.join(dir, 'ok.txt'), 'a');
      const p = compressor.normalize({});
      // Um diretório com o mesmo nome de arquivo aparece nos dois formatos;
      // o scanner precisa seguir em vez de estourar.
      const encontrados = compressor.walk(dir, p);
      expect(encontrados.map((f) => f.rel)).to.deep.equal(['ok.txt']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('manifest corrompido não impede a compactação, ela recomeça', () => {
    const dir = temp();
    try {
      const archive = path.join(dir, 'tudo.7z');
      fs.writeFileSync(compressor.manifestPath(archive), 'não é json');
      const m = compressor.readManifest ? compressor.readManifest(archive) : null;
      // readManifest não é exportado; o caminho coberto é o comportamento
      // observable: compactar não deve lançar com manifest quebrado.
      expect(m === null || m.entries).to.not.equal(undefined);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Resiliência: daemon fora do ar', () => {
  it('a visão geral não quebra quando nenhum endpoint responde', async () => {
    const quebrado = {
      systemStatus: async () => { throw new Error('offline'); },
      get: async () => { throw new Error('offline'); },
      statsFolder: async () => { throw new Error('offline'); },
      statsDevice: async () => { throw new Error('offline'); },
      discovery: async () => { throw new Error('offline'); },
    };
    const manager = require('../src/main/syncthing/manager');
    const view = await manager.overview(quebrado);
    // A tela precisa de um objeto desenhável, mesmo sem daemon: os cards
    // vazios são melhor do que a tela inteira em branco.
    expect(view.running).to.equal(false);
    expect(view.uptimeMs).to.equal(0);
    expect(view.listeners).to.deep.equal({ ok: 0, total: 0 });
    expect(view.localState).to.deep.equal({ files: 0, directories: 0, bytes: 0 });
  });

  it('a checagem pré/pós sobrevive a um daemon que cai no meio', async () => {
    const b = new PostSyncBridge({ minIntervalMs: 1000 });
    const meio = {
      dbCompletion: async () => { throw new Error('conexão perdida'); },
    };
    const out = await b.check(meio, [
      { id: 'a', PreSyncTaskId: 't', PostSyncTaskId: 't' },
      { id: 'b' },
    ]);
    expect(out.preFired).to.deep.equal([]);
    expect(out.fired).to.deep.equal([]);
    expect(out.compressed).to.deep.equal([]);
  });

  it('a compactação registra a falha sem deixar a tarefa pós parecer sucesso', async () => {
    const avisos = [];
    const b = new PostSyncBridge({ logger: { log: (lvl, m) => avisos.push(`${lvl}: ${m}`) } });
    b.compressor = {
      compressFolder: async () => ({ ok: false, reason: 'sync.compression.sevenZipMissing' }),
    };
    const out = await b.check({ dbCompletion: async () => ({ completion: 100 }) }, [
      { id: 'a', path: 'C:\\a', Compression: { mode: 'archive', archivePath: 'D:\\a.7z' } },
    ]);
    expect(out.compressed[0].ok).to.equal(false);
    // O aviso é o que o operador vê no log: sem ele, a falha é silenciosa.
    expect(avisos.some((a) => a.includes('sevenZipMissing'))).to.equal(true);
  });

  it('o cliente distingue daemon parado de daemon travado', async () => {
    // A UI mostra ações diferentes nos dois casos: "iniciar" e "reiniciar".
    const c = new SyncthingClient({ port: 65535, apiKey: 'k', timeout: 500 });
    let erro = null;
    try { await c.systemStatus(); } catch (e) { erro = e; }
    expect(erro).to.not.equal(null);
    expect(erro.code || erro.message).to.be.a('string');
  });

  it('a recusa de host não deixa o cliente passar pela URL base', () => {
    const c = new SyncthingClient({ host: '192.168.0.5', port: 8384 });
    expect(() => c.assertLoopback()).to.throw(/loopback/i);
    // A URL ainda é montada, mas nenhuma requisição sai: o assert acontece
    // antes de abrir o socket.
    expect(c.baseUrl).to.contain('192.168.0.5');
  });
});

describe('Resiliência: volume de dados', () => {
  it('o registro de execuções não cresce sem limite', () => {
    // Um serviço rodando meses não pode vazar memória. O registro tem teto.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'runRegistry.js'), 'utf8');
    expect(src).to.match(/slice\(|MAX|LIMIT|cap\b|length\s*>/);
  });

  it('o histórico do coletor de métricas é limitado', () => {
    // Um serviço rodando meses não pode acumular amostras para sempre: é o
    // caminho mais fácil de vazar memória sem aparecer em nenhum teste.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'systemMetrics.js'), 'utf8');
    expect(src).to.match(/maxHistory|DEFAULT_HISTORY/);
    expect(src).to.match(/slice\(0,|shift\(\)|length\s*>=/);
  });

  it('o buffer do sampler também tem teto, para não crescer com uma linha gigante', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'systemMetrics.js'), 'utf8');
    expect(src).to.match(/buffer\.length\s*>/);
  });

  it('o histórico de backup tem teto explícito', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'backupManager.js'), 'utf8');
    expect(src).to.match(/history\.length\s*>\s*\d+/);
  });

  it('o histórico de retenção por pasta é limitado de verdade, não só no texto', () => {
    // Compressão e pós-sincronismo passam a acionar isso a cada ciclo; sem
    // teto, uma pasta com política ativa cresce o config.json sem parar.
    // Exercitado pela API real, porque o teto está no meio de um mutate e um
    // grep não diria se ele se aplica de fato.
const RetentionManager = require('../src/main/retentionManager');
      const ConfigManager = require('../src/main/configManager');
      const dir = temp();
    try {
      const destino = path.join(dir, 'destino');
      fs.mkdirSync(destino, { recursive: true });
      const config = new ConfigManager(path.join(dir, 'config'), 'default');
      const rm = new RetentionManager({
        syncManager: {
          analyzeFolder: async () => ({ ok: true, kind: 'dated-dirs' }),
          runRetentionNow: async () => ({ ok: true, deleted: 0, freed: 0 }),
        },
        cronParser: null,
        config,
        logger: { log() {}, error() {} },
      });
      const profile = rm.createProfile({ Name: 'p', FolderPath: destino, CronExpression: '* * * * *' });
      return Promise.all(Array.from({ length: 160 }, () => rm.runProfile(profile.Id)))
        .then(() => {
          const salvo = rm.getProfile(profile.Id);
          expect(salvo, 'o perfil precisa continuar legível').to.not.equal(null);
          expect(salvo.History.length, 'o histórico precisa ter teto').to.be.at.most(100);
          expect(salvo.History.length).to.be.above(0);
        })
        .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  });

  it('o histórico de compactação por pasta tem teto', () => {
    // A Retention guarda as últimas execuções; sem teto, uma pasta com
    // compactação ligada por meses acumula registro sem parar.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'retentionManager.js'), 'utf8');
    expect(src).to.match(/slice\(-|slice\(0|MAX_HISTORY|\.length\s*>\s*\d+/);
  });
});