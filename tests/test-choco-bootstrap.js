// tests/test-choco-bootstrap.js
//
// A instalação do Chocolatey era uma linha só:
//
//   iex ((New-Object System.Net.WebClient).DownloadString(
//        'https://community.chocolatey.org/install.ps1'))
//
// Roda como LocalSystem no serviço, e o caminho é alcançável por
// POST /api/network/daemon/install no painel. Como a chave de API pula escopo
// por desenho, quem respondesse no lugar do community.chocolatey.org executava
// o próprio código como SYSTEM.
//
// Agora o corpo vai para um arquivo, o SHA-256 é conferido contra uma
// constante, e a execução usa -File num caminho que o próprio processo escolheu.

const { expect } = require('chai');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const installer = require('../src/main/syncthing/installer');
const { SyncthingInstaller } = require('../src/main/syncthing/installer');

const SCRIPT_BOM = '# script oficial do chocolatey\nWrite-Host "instalando"\n';
const HASH_BOM = crypto.createHash('sha256').update(SCRIPT_BOM).digest('hex');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-choco-'));
}

// Registra os process.execFile sem rodar nada: o que importa aqui é o que
// SERIA executado, não a instalação.
function build(overrides = {}) {
  const registros = [];
  const logger = { linhas: [], log: (l, m) => logger.linhas.push(`${l}: ${m}`) };
  const inst = new SyncthingInstaller(logger, Object.assign({
    execFileSync: () => '',
    execFile: (exe, args, opts, cb) => { registros.push({ exe, args, opts }); cb(null, 'ok', ''); },
  }, overrides));
  return { inst, registros, logger };
}

describe('Bootstrap do chocolatey: o hash é conferido antes de executar', () => {
  it('não usa iex nem embute o corpo num -Command', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'syncthing', 'installer.js'), 'utf8');
    // O comentário que explica a remoção cita iex de propósito; o que importa
    // é o código, não a prosa.
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(codigo, 'iex executa o que vier na resposta').to.not.match(/\biex\b/);
    expect(codigo).to.not.match(/DownloadString/);
  });

  it('o hash fixado é um SHA-256 de 64 dígitos', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'syncthing', 'installer.js'), 'utf8');
    const hash = /CHOCO_SCRIPT_SHA256[\s\S]*?'([a-f0-9]{64})'/.exec(fonte);
    expect(hash, 'a constante tem de ser um sha256 completo').to.not.equal(null);
  });

  it('a URL é https e o corpo nunca é montado como comando', () => {
    expect(installer.CHOCO_SCRIPT_URL).to.match(/^https:\/\//);
  });

  it('executa por -File, num caminho que o processo escolheu', async () => {
    const dir = temp();
    const anterior = process.env.KYRION_CHOCO_SCRIPT_SHA256;
    process.env.KYRION_CHOCO_SCRIPT_SHA256 = HASH_BOM;
    try {
      const { inst, registros } = build();
      // O download entrega o script bom.
      inst.downloadChocoScript = (destino) => { fs.writeFileSync(destino, SCRIPT_BOM); return Promise.resolve(destino); };

      const r = await inst.installChocolatey();
      expect(r.success).to.equal(true);
      expect(registros).to.have.length(1);
      expect(registros[0].exe).to.equal('powershell');
      expect(registros[0].args).to.include('-File');
      expect(registros[0].args).to.not.include('-Command');
    } finally {
      if (anterior === undefined) delete process.env.KYRION_CHOCO_SCRIPT_SHA256;
      else process.env.KYRION_CHOCO_SCRIPT_SHA256 = anterior;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NÃO executa nada quando o hash não bate, e diz qual foi o visto', async () => {
    const anterior = process.env.KYRION_CHOCO_SCRIPT_SHA256;
    process.env.KYRION_CHOCO_SCRIPT_SHA256 = crypto.createHash('sha256').update('outra coisa').digest('hex');
    try {
      const { inst, registros, logger } = build();
      // O corpo veio adulterado: o mesmo caminho, resposta controlada por outro.
      inst.downloadChocoScript = (destino) => {
        fs.writeFileSync(destino, 'Write-Host "pwned"');
        return Promise.resolve(destino);
      };

      const r = await inst.installChocolatey();
      expect(r.success).to.equal(false);
      expect(r.reason).to.equal('sync.install.chocoHashMismatch');
      expect(registros, 'nada pode ser executado com hash errado').to.have.length(0);
      // O hash visto volta para o operador, que é quem tem o script oficial
      // do lado de lá para conferir.
      expect(r.hash).to.match(/^[a-f0-9]{64}$/);
      expect(logger.linhas.some((l) => l.startsWith('ERROR'))).to.equal(true);
    } finally {
      if (anterior === undefined) delete process.env.KYRION_CHOCO_SCRIPT_SHA256;
      else process.env.KYRION_CHOCO_SCRIPT_SHA256 = anterior;
    }
  });

  it('não deixa o script baixado para trás depois de executar', async () => {
    const anterior = process.env.KYRION_CHOCO_SCRIPT_SHA256;
    process.env.KYRION_CHOCO_SCRIPT_SHA256 = HASH_BOM;
    // O caminho é derivado do pid, e uma execução anterior que falhou no meio
    // pode ter deixado o arquivo dele. O teste compara antes e depois em vez
    // de esperar zero, senão falha por lixo que não é dele.
    const listar = () => fs.readdirSync(os.tmpdir())
      .filter((f) => f.startsWith(`chocolatey-install-${process.pid}.`));
    const antes = listar().length;
    try {
      const { inst } = build();
      inst.downloadChocoScript = (destino) => { fs.writeFileSync(destino, SCRIPT_BOM); return Promise.resolve(destino); };
      await inst.installChocolatey();
      expect(listar().length, 'o script temporário tem de sumir').to.equal(antes);
    } finally {
      if (anterior === undefined) delete process.env.KYRION_CHOCO_SCRIPT_SHA256;
      else process.env.KYRION_CHOCO_SCRIPT_SHA256 = anterior;
    }
  });

  it('falha fechada quando o download não dá certo, sem tentar executar', async () => {
    const { inst, registros } = build();
    inst.downloadChocoScript = () => Promise.reject(new Error('rede fora'));
    const r = await inst.installChocolatey();
    expect(r.success).to.equal(false);
    expect(r.message).to.match(/Falha ao baixar/);
    expect(registros).to.have.length(0);
  });

  it('recusa redirecionamento para fora de https', async () => {
    const { inst, registros } = build();
    inst.downloadChocoScript = () => Promise.reject(new Error('redirecionamento para fora de https: http://x/install.ps1'));
    const r = await inst.installChocolatey();
    expect(r.success).to.equal(false);
    expect(registros).to.have.length(0);
  });
});

describe('Bootstrap do chocolatey: propagação do motivo', () => {
  it('o motivo de hash atravessa até o retorno de installSyncthing', async () => {
    const anterior = process.env.KYRION_CHOCO_SCRIPT_SHA256;
    process.env.KYRION_CHOCO_SCRIPT_SHA256 = crypto.createHash('sha256').update('x').digest('hex');
    try {
      const { inst } = build();
      inst.hasChocolatey = () => false;
      inst.installChocolatey = async () => ({
        success: false, step: 'chocolatey', reason: 'sync.install.chocoHashMismatch',
        expected: 'aa', hash: 'bb', message: 'hash',
      });
      const r = await inst.installSyncthing();
      // Sem o reason, a tela mostraria só "não foi possível instalar" e o
      // operador não saberia que nada foi executado por decisão de segurança.
      expect(r.reason).to.equal('sync.install.chocoHashMismatch');
      expect(r.expected).to.equal('aa');
    } finally {
      if (anterior === undefined) delete process.env.KYRION_CHOCO_SCRIPT_SHA256;
      else process.env.KYRION_CHOCO_SCRIPT_SHA256 = anterior;
    }
  });
});

describe('Bootstrap do chocolatey: a tela fala o motivo', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'networkPage.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');

  it('a tela usa o reason em vez de um "falhou" genérico', () => {
    const bloco = renderer.slice(renderer.indexOf('async install()'), renderer.indexOf('async start()'));
    expect(bloco).to.include('result.reason');
    expect(bloco).to.include('chocoHashMismatchHint');
  });

  it('as duas chaves existem nos dois idiomas', () => {
    const conta = (chave) => (i18n.match(new RegExp(`'${chave}'`, 'g')) || []).length;
    expect(conta('sync.install.chocoHashMismatch'), 'tem que estar nos dois dicionários').to.equal(2);
    expect(conta('network.chocoHashMismatchHint')).to.equal(2);
  });
});