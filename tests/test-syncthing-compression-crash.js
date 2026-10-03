// tests/test-syncthing-compression-crash.js
//
// O modo "um container para a pasta" mantém um manifest ao lado do .7z dizendo o
// que está dentro. Duas falhas possíveis, e as duas vêm de uma queda no meio:
//
//  - o `d` roda, o app morre antes do manifesto ser gravado: a entrada ficou no
//    manifesto mas já não está no container. O `d` seguinte falha, e como o
//    laço abortava, TODA execução futura da pasta falhava - um arquivo
//    envenenado que trava a compactação do resto para sempre.
//  - o `a` roda, o app morre antes do manifesto: o próximo ciclo recolhe o
//    mesmo arquivo, que é inofensivo.
//
// O primeiro é o que estes testes fixam: a remoção não pode envenenar a pasta, e
// o manifesto é gravado a cada arquivo para que um crash não perca o progresso.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FolderCompressor } = require('../src/main/syncthing/folderCompressor');
const compressor = require('../src/main/syncthing/folderCompressor');

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-crash-')); }

function arquivo(dir, rel, conteudo, mtimeMs) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, conteudo);
  if (mtimeMs !== undefined) fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
  return full;
}

// 7z de mentira que sabe dizer o que tem dentro, e sabe recusar o `d` de quem
// não está lá - que é o comportamento real do 7z.
function sevenZipFalso(conteudo) {
  const estado = { dentro: new Set(conteudo || []), chamadas: [] };
  const run = async (args) => {
    estado.chamadas.push(args);
    const verb = args[0];
    if (verb === 'a' || verb === 'u') {
      const alvo = args[args.length - 2];
      estado.dentro.add(path.basename(args[args.length - 1]));
      if (!fs.existsSync(alvo)) fs.writeFileSync(alvo, 'container');
      return { stdout: '', stderr: '' };
    }
    if (verb === 'd') {
      const nome = path.basename(args[2]);
      if (!estado.dentro.has(nome)) {
        // O 7z real devolve erro nesta situação, e é o que destrava o laço.
        throw new Error(`ERROR: No Files to process! ${args[2]}`);
      }
      estado.dentro.delete(nome);
      return { stdout: '', stderr: '' };
    }
    if (verb === 'l') {
      const lista = [...estado.dentro].map((n) => `2026-01-01 00:00    ${n}`).join('\n');
      return { stdout: lista, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  run.estado = estado;
  return run;
}

describe('Compactação: uma queda não envenena a pasta', () => {
  it('o `d` que falha porque a entrada já saiu não trava as execuções seguintes', async () => {
    const dir = temp();
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      fs.writeFileSync(archive, 'container');

      // O manifest mente: diz que 'velho.zip' está no container, mas ele não
      // está mais - foi uma execução anterior que morreu antes de gravar.
      fs.writeFileSync(compressor.manifestPath(archive), JSON.stringify({
        entries: { 'velho.zip': { mtime: 1, size: 1 } },
      }));

      arquivo(dir, 'novo.zip', 'x', 2000);
      const run = sevenZipFalso([]);        // o container não tem 'velho.zip'
      const c = new FolderCompressor({ sevenZip: 'C:\\falso\\7z.exe' });
      c.sevenRun = run;

      const r = await c.compressFolder(dir, { mode: 'archive', archivePath: archive });

      expect(r.ok, 'a falha do `d` orfa não pode abortar a pasta toda').to.equal(true);
      expect(r.added).to.equal(1);
      // E a entrada orfa saiu do manifest, senão a próxima volta a tentá-la.
      const manifest = JSON.parse(fs.readFileSync(compressor.manifestPath(archive), 'utf8'));
      expect(manifest.entries['velho.zip'], 'entrada orfa foi removida do manifesto').to.equal(undefined);
      expect(manifest.entries['novo.zip']).to.not.equal(undefined);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(fora, { recursive: true, force: true }); }
  });

  it('um `d` que falha porque o 7z realmente nao conseguiu fica registrado como falha', async () => {
    const dir = temp();
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      fs.writeFileSync(archive, 'container');
      fs.writeFileSync(compressor.manifestPath(archive), JSON.stringify({
        entries: { 'preso.zip': { mtime: 1, size: 1 } },
      }));
      arquivo(dir, 'outro.zip', 'x', 2000);

      // Aqui o container TEM o arquivo, e mesmo assim o `d` falha: é um
      // problema real, e ele não pode virar "já estava resolvido".
      const run = sevenZipFalso(['preso.zip']);
      run.estado.dentro.add('preso.zip');
      const originalD = run;
      const c = new FolderCompressor({ sevenZip: 'C:\\falso\\7z.exe' });
      c.sevenRun = async (args) => {
        if (args[0] === 'd') throw new Error('disco cheio');
        return originalD(args);
      };

      const r = await c.compressFolder(dir, { mode: 'archive', archivePath: archive });
      expect(r.ok, 'uma remocao que falhou de verdade é parcial, nao sucesso').to.equal(false);
      expect(r.reason).to.equal('sync.compression.partial');
      expect(r.falhas[0].rel).to.equal('preso.zip');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(fora, { recursive: true, force: true }); }
  });

  it('o manifesto e gravado a cada arquivo, e nao so no fim', async () => {
    const dir = temp();
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      const c = new FolderCompressor({ sevenZip: 'C:\\falso\\7z.exe' });
      c.sevenRun = sevenZipFalso([]);
      for (let i = 0; i < 3; i++) arquivo(dir, `a${i}.zip`, 'x', 1000 + i * 1000);

      // A queda é depois do segundo arquivo: o manifesto tem de registrar os
      // dois primeiros, senão o próximo ciclo perde o progresso.
      let n = 0;
      c.sevenRun = async (args) => {
        const r = await sevenZipFalso([])(args);
        n++;
        if (n === 4) throw new Error('app caiu');
        return r;
      };
      await c.compressFolder(dir, { mode: 'archive', archivePath: archive }).catch(() => {});

      const manifest = JSON.parse(fs.readFileSync(compressor.manifestPath(archive), 'utf8'));
      const registrados = Object.keys(manifest.entries).length;
      expect(registrados, 'o progresso anterior a queda ficou gravado').to.be.at.least(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(fora, { recursive: true, force: true }); }
  });

  it('archiveContains diz se o rel ainda esta no container', async () => {
    const fora = temp();
    try {
      const archive = path.join(fora, 'tudo.7z');
      const run = sevenZipFalso(['dentro.zip', 'pasta/ dentro.zip']);
      const c = new FolderCompressor({ sevenZip: 'C:\\falso\\7z.exe' });
      c.sevenRun = run;
      expect(await c.archiveContains(archive, 'dentro.zip')).to.equal(true);
      expect(await c.archiveContains(archive, 'nao-existe.zip')).to.equal(false);
    } finally { fs.rmSync(fora, { recursive: true, force: true }); }
  });
});
