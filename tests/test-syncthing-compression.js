// tests/test-syncthing-compression.js
//
// As decisões de projeto aqui vieram de medir o 7-Zip 25.01, não de ler a
// lista de comandos: `u` anexa incrementalmente (181 -> 194 bytes) e `d`
// realmente reescreve o container (194 -> 174). Sem o `d`, apagar na origem
// deixaria peso morto preso para sempre.
//
// Os testes usam um 7z de mentira que registra os argumentos. O comportamento
// do binário real é medido num teste separado, contra o executável da máquina.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const compressor = require('../src/main/syncthing/folderCompressor');
const { FolderCompressor } = require('../src/main/syncthing/folderCompressor');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-comp-'));
}

// O mtime é fixado a cada escrita, com um segundo de diferença entre elas.
// A regra de atualização do container decide por mtime, e deixar isso a cargo
// do relógio tornava o teste instável: duas escritas seguidas podem cair no
// mesmo tick e o arquivo pareceria não ter mudado - foi assim que este teste
// falhou uma vez só, numa máquina em que a suíte rodou mais rápido.
let mtimeSeq = 1700000000000;
function arquivo(dir, rel, conteudo, mtimeMs) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, conteudo);
  const quando = mtimeMs === undefined ? (mtimeSeq += 1000) : mtimeMs;
  fs.utimesSync(full, new Date(quando), new Date(quando));
  return full;
}

// 7z de mentira: não produz container de verdade, so registra o que foi pedido
// e finge que o arquivo saiu. Assim o teste verifica a ORDEM e o QUE, não o
// compressor. `criar` escreve um container vazio para o caminho feliz, porque o
// compressor confere que o .7z existe antes de apagar o original - sem isso o
// teste pararia exatamente na proteção que ele existe para verificar.
function fakeSeven(estado, criar = false) {
  return async (args) => {
    estado.calls.push(args);
    const verb = args[0];
    if (verb === 'a' || verb === 'u') {
      const alvo = args[args.length - 2];
      const origem = args[args.length - 1];
      estado.entries[path.basename(origem)] = true;
      if (criar && !fs.existsSync(alvo)) fs.writeFileSync(alvo, 'PK-ish');
    }
    if (verb === 'd') {
      for (const nome of args.slice(2)) delete estado.entries[nome];
    }
    return { stdout: 'ok', stderr: '' };
  };
}

describe('Compactacao: politica', () => {
  it('padrao e nao compactado', () => {
    const p = compressor.normalize({});
    expect(p.mode).to.equal('none');
    expect(p.level).to.equal(5);
  });

  it('reconhece os tres modos e descarta os desconhecidos', () => {
    expect(compressor.normalize({ mode: 'perFile' }).mode).to.equal('perFile');
    expect(compressor.normalize({ mode: 'archive' }).mode).to.equal('archive');
    expect(compressor.normalize({ mode: 'inventado' }).mode).to.equal('none');
  });

  it('mantem o nivel entre 1 e 9 e cai no padrao fora da faixa', () => {
    expect(compressor.normalize({ level: 9 }).level).to.equal(9);
    expect(compressor.normalize({ level: 0 }).level).to.equal(5);
    expect(compressor.normalize({ level: 42 }).level).to.equal(5);
  });

  it('nao pede caminho de container no modo por arquivo', () => {
    const r = compressor.validate({ mode: 'perFile' }, 'C:\\dados');
    expect(r.ok).to.equal(true);
  });

  it('exige caminho absoluto de container no modo arquivo grande', () => {
    const sem = compressor.validate({ mode: 'archive' }, 'C:\\dados');
    expect(sem.ok).to.equal(false);
    expect(sem.reason).to.equal('sync.compression.archivePathRequired');

    const relativo = compressor.validate({ mode: 'archive', archivePath: 'sub\\tudo.7z' }, 'C:\\dados');
    expect(relativo.reason).to.equal('sync.compression.archivePathNotAbsolute');
  });

  it('recusa o container dentro da propria pasta sincronizada', () => {
    // O ciclo de auto-copia: o container entraria na pasta, sincronizaria para
    // as outras maquinas e a copia dele seria arquivada dentro dele de novo.
    const dentro = compressor.validate({ mode: 'archive', archivePath: 'C:\\dados\\tudo.7z' }, 'C:\\dados');
    expect(dentro.ok).to.equal(false);
    expect(dentro.reason).to.equal('sync.compression.archiveInsideFolder');

    const subpasta = compressor.validate({ mode: 'archive', archivePath: 'C:\\dados\\sub\\tudo.7z' }, 'C:\\dados');
    expect(subpasta.ok).to.equal(false);
  });

  it('aceita o container como irmao da pasta sincronizada', () => {
    const r = compressor.validate({ mode: 'archive', archivePath: 'C:\\compactado\\tudo.7z' }, 'C:\\dados');
    expect(r.ok).to.equal(true);
  });

  it('nao confunde a propria pasta com uma pasta dentro dela', () => {
    expect(compressor.isWithin('C:\\dados', 'C:\\dados')).to.equal(false);
    expect(compressor.isWithin('C:\\dados\\sub', 'C:\\dados')).to.equal(true);
    expect(compressor.isWithin('C:\\outro', 'C:\\dados')).to.equal(false);
  });
});

describe('Compactacao: selecao de arquivos', () => {
  it('respeita a lista de extensoes', () => {
    const p = compressor.normalize({ extensions: ['.7z'] });
    expect(compressor.matches('dump.7z', p)).to.equal(true);
    expect(compressor.matches('dump.sql', p)).to.equal(false);
  });

  it('sem lista de extensoes, aceita tudo', () => {
    expect(compressor.matches('qqq.bin', compressor.normalize({}))).to.equal(true);
  });

  it('exclui por caminho e por sufixo de nome', () => {
    const p = compressor.normalize({ excludes: ['temp', 'node_modules'] });
    expect(compressor.matches('temp/a.txt', p)).to.equal(false);
    expect(compressor.matches('a/node_modules/b.txt', p)).to.equal(false);
    expect(compressor.matches('a/b.txt', p)).to.equal(true);
  });

  it('ignora arquivo abaixo do tamanho minimo', () => {
    const dir = temp();
    try {
      arquivo(dir, 'pequeno.txt', 'x');
      arquivo(dir, 'grande.txt', 'x'.repeat(2048));
      const p = compressor.normalize({ minSizeBytes: 1024 });
      const encontrados = compressor.walk(dir, p).map((f) => f.rel);
      expect(encontrados).to.deep.equal(['grande.txt']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('percorre a pasta inteira em notacao posix, que e o que o 7z usa', () => {
    const dir = temp();
    try {
      arquivo(dir, path.join('sub', 'profundo', 'a.txt'), 'a');
      const encontrados = compressor.walk(dir, compressor.normalize({}));
      expect(encontrados.map((f) => f.rel)).to.deep.equal(['sub/profundo/a.txt']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Compactacao: um arquivo por vez', () => {
  it('compacta, apaga o original e nao repete arquivo ja compactado', async () => {
    const dir = temp();
    try {
      arquivo(dir, 'a.txt', 'conteudo de a');
      const estado = { calls: [], entries: {} };
      const c = new FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe', run: null });
      c.sevenRun = fakeSeven(estado, true);

      const r1 = await c.compressFolder(dir, { mode: 'perFile' });
      expect(r1.added).to.equal(1);
      expect(fs.existsSync(path.join(dir, 'a.txt')), 'o original sai depois do container pronto').to.equal(false);
      expect(estado.calls[0][0]).to.equal('a');

      const r2 = await c.compressFolder(dir, { mode: 'perFile' });
      expect(r2.added).to.equal(0);
      expect(estado.calls).to.have.length(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('nao apaga o original quando o compressor falha', async () => {
    const dir = temp();
    try {
      arquivo(dir, 'a.txt', 'conteudo');
      const c = new FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe' });
      c.sevenRun = async () => { throw new Error('disco cheio'); };

      const r = await c.compressFolder(dir, { mode: 'perFile' });
      expect(r.ok).to.equal(false);
      expect(r.detail).to.equal('disco cheio');
      expect(r.file).to.equal('a.txt');
      // Este e o ponto: um 7z falhando nao pode custar o dado original.
      expect(fs.existsSync(path.join(dir, 'a.txt'))).to.equal(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('nao apaga o original quando o 7z sai sem criar o container', async () => {
    const dir = temp();
    try {
      arquivo(dir, 'a.txt', 'conteudo');
      const estado = { calls: [], entries: {} };
      const c = new FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe' });
      // Sai com codigo 0 e nao cria nada: o caso perigoso, porque parece sucesso.
      c.sevenRun = fakeSeven(estado, false);

      const r = await c.compressFolder(dir, { mode: 'perFile' });
      expect(r.ok).to.equal(false);
      expect(r.detail).to.contain('container');
      expect(fs.existsSync(path.join(dir, 'a.txt')), 'sem container legivel o original fica').to.equal(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('recusa a pasta que nao existe', async () => {
    const c = new FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe' });
    const r = await c.compressFolder(path.join(temp(), 'nao-existe'), { mode: 'perFile' });
    expect(r.ok).to.equal(false);
    expect(r.reason).to.equal('sync.compression.folderMissing');
  });

  it('avisa quando o 7-Zip nao esta na maquina, em vez de fingir que compactou', async () => {
    const dir = temp();
    try {
      arquivo(dir, 'a.txt', 'conteudo');
      const c = new FolderCompressor({ sevenZip: null, config: { getSetting: () => '' } });
      const r = await c.compressFolder(dir, { mode: 'perFile' });
      expect(r.ok).to.equal(false);
      expect(r.reason).to.equal('sync.compression.sevenZipMissing');
      expect(fs.existsSync(path.join(dir, 'a.txt'))).to.equal(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('Compactacao: container unico', () => {
  it('anexa o que e novo, reescreve o que mudou e remove o que sumiu', async () => {
    const dir = temp();
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      const c = new FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe' });
      const estado = { calls: [], entries: {} };
      c.sevenRun = fakeSeven(estado, true);

      arquivo(dir, 'a.txt', 'A');
      arquivo(dir, 'b.txt', 'B');
      const r1 = await c.compressFolder(dir, { mode: 'archive', archivePath: archive });
      expect(r1.added).to.equal(2);
      expect(fs.existsSync(path.join(dir, 'a.txt'))).to.equal(false);
      expect(fs.existsSync(compressor.manifestPath(archive))).to.equal(true);

      // b.txt mudou: entra com u, nao com a.
      arquivo(dir, 'b.txt', 'B alterado');
      const r2 = await c.compressFolder(dir, { mode: 'archive', archivePath: archive });
      expect(r2.updated).to.equal(1);
      expect(r2.added).to.equal(0);

      // Segundo ciclo sem mudanca: nao anexa nem reescreve nada.
      const r3 = await c.compressFolder(dir, { mode: 'archive', archivePath: archive });
      expect(r3.added).to.equal(0);
      expect(r3.updated).to.equal(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fora, { recursive: true, force: true });
    }
  });

  it('remove do container o arquivo que desapareceu da origem', async () => {
    const dir = temp();
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      const estado = { calls: [], entries: {} };
      const c = new FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe' });
      c.sevenRun = fakeSeven(estado, true);

      arquivo(dir, 'sai.txt', 'S');
      await c.compressFolder(dir, { mode: 'archive', archivePath: archive });
      expect(estado.entries['sai.txt']).to.equal(true);

      fs.rmSync(path.join(dir, 'sai.txt'), { force: true });
      const r = await c.compressFolder(dir, { mode: 'archive', archivePath: archive });
      expect(r.removed).to.equal(1);
      // Sem o `d`, o arquivo continuaria preso no container ocupando espaco.
      expect(estado.calls.some((chamada) => chamada[0] === 'd')).to.equal(true);
      expect(estado.entries['sai.txt']).to.equal(undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fora, { recursive: true, force: true });
    }
  });

  it('guarda o manifest com o que esta dentro, para saber reverter', async () => {
    const dir = temp();
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      const c = new FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe' });
      c.sevenRun = fakeSeven({ calls: [], entries: {} }, true);
      arquivo(dir, path.join('fotos', 'viagem.jpg'), 'J');
      await c.compressFolder(dir, { mode: 'archive', archivePath: archive });

      const manifest = JSON.parse(fs.readFileSync(compressor.manifestPath(archive), 'utf8'));
      expect(Object.keys(manifest.entries)).to.deep.equal(['fotos/viagem.jpg']);
      expect(manifest.entries['fotos/viagem.jpg'].size).to.equal(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fora, { recursive: true, force: true });
    }
  });

  it('recusa o container dentro da pasta e nao toca em nada', async () => {
    const dir = temp();
    try {
      arquivo(dir, 'a.txt', 'A');
      const c = new FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe' });
      const chamadas = [];
      c.sevenRun = async (args) => { chamadas.push(args); return { stdout: '', stderr: '' }; };

      const r = await c.compressFolder(dir, { mode: 'archive', archivePath: path.join(dir, 'tudo.7z') });
      expect(r.ok).to.equal(false);
      expect(r.reason).to.equal('sync.compression.archiveInsideFolder');
      expect(chamadas).to.have.length(0);
      expect(fs.existsSync(path.join(dir, 'a.txt'))).to.equal(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('nao faz nada quando o modo esta desligado', async () => {
    const dir = temp();
    try {
      arquivo(dir, 'a.txt', 'A');
      const c = new FolderCompressor({ sevenZip: 'C:\\fake\\7z.exe' });
      const chamadas = [];
      c.sevenRun = async (args) => { chamadas.push(args); return { stdout: '', stderr: '' }; };
      const r = await c.compressFolder(dir, { mode: 'none' });
      expect(r.ok).to.equal(true);
      expect(r.skipped).to.equal('modeOff');
      expect(chamadas).to.have.length(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// Este teste é o único que fala com o binário de verdade, e por isso pula
// quando não há 7-Zip: o resto da suíte tem de rodar num servidor sem ele.
describe('Compactacao: contra o 7-Zip de verdade', function () {
  this.timeout(120000);

  const exe = compressor.find7z();
  if (!exe) return;

  it('anexa incrementalmente em vez de reescrever tudo', () => {
    const dir = temp();
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      arquivo(dir, 'a.txt', 'A'.repeat(4096));
      execFileSync(exe, ['a', '-t7z', '-mx=1', '-bd', archive, path.join(dir, 'a.txt')], { windowsHide: true });
      const depoisDoPrimeiro = fs.statSync(archive).size;

      arquivo(dir, 'b.txt', 'B'.repeat(4096));
      execFileSync(exe, ['u', '-t7z', '-mx=1', '-bd', archive, path.join(dir, 'b.txt')], { windowsHide: true });
      const depoisDoAppend = fs.statSync(archive).size;

      const bytesDeB = fs.statSync(path.join(dir, 'b.txt')).size;
      expect(depoisDoAppend - depoisDoPrimeiro).to.be.below(bytesDeB * 2);
      execFileSync(exe, ['l', '-ba', archive], { encoding: 'utf8', windowsHide: true });
      expect(execFileSync(exe, ['l', '-ba', archive], { encoding: 'utf8', windowsHide: true })).to.include('a.txt');
      expect(execFileSync(exe, ['l', '-ba', archive], { encoding: 'utf8', windowsHide: true })).to.include('b.txt');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fora, { recursive: true, force: true });
    }
  });

  it('o comando d remove mesmo e o conteudo continua extraivel', () => {
    const dir = temp();
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      arquivo(dir, 'fica.txt', 'FICA');
      arquivo(dir, 'sai.txt', 'SAI');
      execFileSync(exe, ['a', '-t7z', '-mx=1', '-bd', archive, path.join(dir, 'fica.txt'), path.join(dir, 'sai.txt')], { windowsHide: true });

      execFileSync(exe, ['d', archive, 'sai.txt'], { windowsHide: true });
      const listagem = execFileSync(exe, ['l', '-ba', archive], { encoding: 'utf8', windowsHide: true });
      expect(listagem).to.include('fica.txt');
      expect(listagem).to.not.include('sai.txt');

      const out = path.join(fora, 'out');
      execFileSync(exe, ['x', archive, `-o${out}`, '-y', '-bd'], { windowsHide: true });
      expect(fs.readdirSync(out).sort()).to.deep.equal(['fica.txt']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fora, { recursive: true, force: true });
    }
  });

  it('faz o ciclo inteiro: compacta, apaga da origem, reverte', async () => {
    const dir = temp();
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      const c = new FolderCompressor({ sevenZip: exe });
      arquivo(dir, path.join('sub', 'doc.txt'), 'CONTEUDO IMPORTANTE');

      const r = await c.compressFolder(dir, { mode: 'archive', archivePath: archive });
      expect(r.ok).to.equal(true);
      expect(r.added).to.equal(1);
      expect(fs.existsSync(path.join(dir, 'sub', 'doc.txt')), 'o original sai depois do container pronto').to.equal(false);
      expect(fs.existsSync(archive)).to.equal(true);

      const volta = await c.restoreArchive({ mode: 'archive', archivePath: archive }, dir);
      expect(volta.ok).to.equal(true);
      expect(fs.readFileSync(path.join(dir, 'sub', 'doc.txt'), 'utf8')).to.equal('CONTEUDO IMPORTANTE');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fora, { recursive: true, force: true });
    }
  });
});