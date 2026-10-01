// syncthing/folderCompressor.js - Compactacao das pastas sincronizadas.
//
// Dois modos, nenhum ligado por padrao:
//
//  perFile  cada arquivo vira um .7z proprio. Reversivel arquivo a arquivo, e
//           apagar o original libera o espaco na hora.
//  archive  tudo e anexado a um unico container por pasta. Economiza mais
//           espaco, porque cada entrada tem um cabecalho uma so vez, e o
//           container cresce de forma incremental.
//
// O modo archive depende de duas coisas que a medicao no 7-Zip 25.01Dupin:
// `u` anexa sem reescrever tudo (181 -> 194 bytes) e `d` remove de verdade
// reescrevendo o container (194 -> 174). Sem o `d`, apagar um arquivo na
// origem deixaria o dead weight preso no container para sempre.
//
// O container NUNCA pode ficar dentro da pasta sincronizada: ele sincronizaria
// junto e a copia do container passaria a ser arquivada de novo dentro dele, um
// ciclo que cresce sem limite. validate() recusa essa configuracao.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MODES = ['none', 'perFile', 'archive'];
const DEFAULT_LEVEL = 5;
const TIMEOUT = 600000;

// O manifest e o que permite reverter. Sem ele o container e uma caixa-preta:
// nao ha como saber que "foto.jpg" dentro dele veio de "fotos/viagem/foto.jpg",
// nem qual arquivo apagar quando a origem sumir.
const MANIFEST_SUFFIX = '.kyrios-manifest.json';

function sevenZipCandidates() {
  const list = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    'C:\\7-Zip\\7z.exe',
    'C:\\tools\\7z\\7z.exe',
  ];
  if (process.env.PROGRAMFILES) list.push(path.join(process.env.PROGRAMFILES, '7-Zip', '7z.exe'));
  if (process.env['PROGRAMFILES(X86)']) list.push(path.join(process.env['PROGRAMFILES(X86)'], '7-Zip', '7z.exe'));
  return list.filter((p) => p && fs.existsSync(p));
}

function find7z(config) {
  const custom = config && typeof config.getSetting === 'function' ? config.getSetting('7zPath', '') : '';
  if (custom && fs.existsSync(custom)) return custom;
  const found = sevenZipCandidates()[0];
  return found || null;
}

function normalize(policy) {
  const p = policy || {};
  return {
    mode: MODES.includes(p.mode) ? p.mode : 'none',
    level: Number(p.level) >= 1 && Number(p.level) <= 9 ? Number(p.level) : DEFAULT_LEVEL,
    // So o archive usa isto; em perFile cada arquivo fica ao lado do original.
    archivePath: p.archivePath || '',
    extensions: Array.isArray(p.extensions) && p.extensions.length ? p.extensions : [],
    // Arquivos que nunca sao compactados, mesmo que casem com a extensao.
    excludes: Array.isArray(p.excludes) ? p.excludes : [],
    minSizeBytes: Number(p.minSizeBytes) > 0 ? Number(p.minSizeBytes) : 0,
  };
}

function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Recusa a configuracao que faria o container sincronizar para dentro dele
 * mesmo. E a checagem mais importante do arquivo: o ciclo de auto-copia
 *produced by mistake so aparece depois de horas de transferencia.
 */
function validate(policy, folderPath) {
  const p = normalize(policy);
  if (p.mode === 'none') return { ok: true, policy: p };
  if (p.mode === 'archive') {
    if (!p.archivePath) return { ok: false, reason: 'sync.compression.archivePathRequired' };
    if (folderPath && isWithin(path.resolve(p.archivePath), path.resolve(folderPath))) {
      return { ok: false, reason: 'sync.compression.archiveInsideFolder' };
    }
    if (!path.isAbsolute(p.archivePath)) return { ok: false, reason: 'sync.compression.archivePathNotAbsolute' };
  }
  return { ok: true, policy: p };
}

// Casa um segmento inteiro do caminho, e nao um prefixo nem um substring.
// "node_modules" tem de excluir a/node_modules/b.txt: com startsWith pegava
// a/node_modules/ mas o arquivo dentro escapava, e com endsWith nao pegava
// nada. Sozinhos os dois deixavam passar o que o filtro existe para tirar.
function hasSegment(posix, segment) {
  return posix.split('/').includes(segment);
}

// O que o proprio compactador produz nao pode entrar no proximo ciclo: o .7z
// por arquivo seria compactado de novo, e o container e o manifest seriam
// arquivados dentro deles. Sem esta lista o modo archive engulfia o proprio
// arquivo a cada passada.
const OWN_ARTIFACTS = ['.kyrios-manifest.json'];

function isOwnArtifact(posix, policy) {
  const nome = posix.split('/').pop();
  if (OWN_ARTIFACTS.includes(nome.toLowerCase())) return true;
  if (policy.mode === 'perFile' && policy.extensions.length === 0 && /\.7z$/i.test(nome)) return true;
  return false;
}

function matches(relPath, policy) {
  const posix = relPath.split(path.sep).join('/');
  if (isOwnArtifact(posix, policy)) return false;
  const ext = path.extname(posix).toLowerCase();
  if (policy.extensions.length && !policy.extensions.includes(ext)) return false;
  for (const pattern of policy.excludes) {
    const clean = String(pattern).replace(/^\/+|\/+$/g, '');
    if (!clean) continue;
    if (clean.includes('/')) {
      if (posix === clean || posix.startsWith(clean + '/')) return false;
      continue;
    }
    if (hasSegment(posix, clean)) return false;
  }
  return true;
}

function manifestPath(archive) { return archive + MANIFEST_SUFFIX; }

function readManifest(archive) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(archive), 'utf8'));
  } catch (e) {
    // Sem manifest e a primeira vez, ou o arquivo foi apagado. Comecar vazio e
    // seguro: o proximo ciclo reconstroi comparando o que existe no disco.
    return { entries: {} };
  }
}

function writeManifest(archive, manifest) {
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(manifestPath(archive), JSON.stringify(manifest, null, 2), 'utf8');
}

// Percorre a pasta devolvendo caminhos relativos em notacao posix, que e o
// que o 7-Zip usa dentro do container e o que o manifest guarda.
function walk(root, policy) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (e) { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      if (!matches(rel, policy)) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch (e) { continue; }
        if (policy.minSizeBytes && size < policy.minSizeBytes) continue;
        if (isOwnArtifact(rel.split(path.sep).join('/'), policy)) continue;
        // `rel` e relativo ao root e usa barra: e o nome que o 7-Zip grava
        // dentro do container e o que o manifest guarda. `abs` e relativo ao
        // disco para passar ao 7z com cwd na pasta. Guardar o caminho completo
        // dentro do .7z faria a extracao recriar C:\Users\... sob o destino.
        out.push({
          full,
          rel: rel.split(path.sep).join('/'),
          abs: path.relative(root, full),
          size,
          mtime,
        });
      }
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

class FolderCompressor {
  constructor(options = {}) {
    this.logger = options.logger || null;
    this.config = options.config || null;
    // `sevenZip: null` significa "esta mÃ¡quina nÃ£o tem 7-Zip", que Ã© como os
    // testes simulam a ausÃªncia. Confundir isso com "nÃ£o informed" fazia o
    // seven() cair na busca automÃ¡tica e achar o 7-Zip de verdade: o teste de
    // ausÃªncia passava a compactar de verdade em vez de recusar.
    this.pinned7z = Object.prototype.hasOwnProperty.call(options, 'sevenZip');
    this.sevenZip = options.sevenZip || null;
  }

  log(level, message) { if (this.logger) this.logger.log(level, message); }

  seven() {
    if (this.pinned7z) return this.sevenZip;
    return find7z(this.config);
  }

  sevenRun(args, cwd) {
    const exe = this.seven();
    if (!exe) return Promise.reject(new Error('sevenZipMissing'));
    return new Promise((resolve, reject) => {
      const opts = { encoding: 'utf8', timeout: TIMEOUT, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };
      if (cwd) opts.cwd = cwd;
      execFile(exe, args, opts,
        (err, stdout, stderr) => {
          // O 7-Zip sai com codigo 1 tambem em "avisou mas compressor". O que
          // separa os casos e se o codigo e zero.
          if (err && err.code !== 0) reject(new Error((stderr || err.message || '').trim()));
          else resolve({ stdout, stderr });
        });
    });
  }

  async compressFolder(folderPath, policy) {
    const check = validate(policy, folderPath);
    if (!check.ok) return { ok: false, reason: check.reason };
    const p = check.policy;
    if (p.mode === 'none') return { ok: true, skipped: 'modeOff', added: 0, removed: 0, updated: 0 };
    if (!fs.existsSync(folderPath)) return { ok: false, reason: 'sync.compression.folderMissing' };

    const exe = this.seven();
    if (!exe) return { ok: false, reason: 'sync.compression.sevenZipMissing' };

    const files = walk(folderPath, p);
    if (p.mode === 'perFile') return this.runPerFile(folderPath, files, p);
    return this.runArchive(folderPath, files, p);
  }

  /**
   * Comprime uma pasta inteira num Ãºnico container.
   *
   * Uma passada, com a ordem que importa: primeiro o que saiu da origem Ã©
   * removido do container, depois o que Ã© novo entra. Fazer na ordem inversa
   * deixaria o `u` reescrever um arquivo que jÃ¡ estava saindo do container.
   */
  async runArchive(folderPath, files, policy) {
    const archive = path.resolve(policy.archivePath);
    fs.mkdirSync(path.dirname(archive), { recursive: true });

    const manifest = readManifest(archive);
    const onDisk = new Map(files.map((f) => [f.rel, f]));
    let added = 0;
    let updated = 0;
    let removed = 0;
    const failed = (detail, file) => ({ ok: false, reason: 'sync.compression.failed', detail, file, archive, added, updated, removed });

    // O que sumiu da origem sai do container. SÃ³ o `u` nÃ£o resolveria: o
    // arquivo apagado continuaria lÃ¡ para sempre ocupando espaÃ§o que o
    // usuÃ¡rio jÃ¡ pagou para liberar. Ã‰ o `d` que faz isso, e ele existe.
    for (const rel of Object.keys(manifest.entries)) {
      if (onDisk.has(rel)) continue;
      if (!fs.existsSync(archive)) break;
      await this.sevenRun(['d', archive, rel]);
      delete manifest.entries[rel];
      removed++;
    }

    for (const file of files) {
      const known = manifest.entries[file.rel];
      if (known && known.mtime >= file.mtime) continue;
      if (known) {
        await this.sevenRun(['u', '-t7z', `-mx=${policy.level}`, '-bd', archive, file.abs], folderPath);
        updated++;
      } else {
        await this.sevenRun(['a', '-t7z', `-mx=${policy.level}`, '-bd', archive, file.abs], folderPath);
        added++;
      }
      // Mesmo cuidado do modo por arquivo: sem o container no disco, o
      // original continua onde estava e a prÃ³xima passada tenta de novo.
      if (!fs.existsSync(archive)) return failed('container nÃ£o foi criado', file.rel);
      manifest.entries[file.rel] = { mtime: file.mtime, size: file.size };
      fs.unlinkSync(file.full);
    }

    writeManifest(archive, manifest);
    this.log('INFO', `SYNC_COMPRESSION archive=${archive} added=${added} updated=${updated} removed=${removed}`);
    return { ok: true, mode: 'archive', archive, added, updated, removed };
  }

  async runPerFile(folderPath, files, policy) {
    // `ok` fica de fora de propÃ³sito: os retornos de erro espalham este objeto
    // no fim para trazer as contagens, e um `ok: true` dentro dele sobrescreveria
    // o `ok: false` da falha logo acima - a recusa virava sucesso no log.
    const result = { mode: 'perFile', added: 0, removed: 0, updated: 0, bytesBefore: 0, bytesAfter: 0 };

    // Falhar aqui NAO apaga o original: o container ausente e o aviso, e a
    // pasta intacta e o unico estado de onde da para retomar.
    for (const file of files) {
      const target = `${file.full}.7z`;
      let exists = false;
      try { exists = fs.existsSync(target); } catch (e) { exists = false; }
      // Um .7z mais novo que a origem ja e o arquivo compactado: refazer seria
      // trabalho sem ganho e reescreveria bytes iguais.
      if (exists) {
        try { if (fs.statSync(target).mtimeMs >= file.mtime) continue; } catch (e) { /* refaz */ }
        result.updated++;
      } else {
        result.added++;
      }

      try {
        await this.sevenRun(['a', '-t7z', `-mx=${policy.level}`, '-bd', target, file.full]);
        // Conferir que o container apareceu e legivel ANTES de apagar o
        // original. O 7-Zip sai com codigo 0 em alguns casos em que deixa o
        // arquivo pela metade, e sem esta checagem o dado sumia com um
        // "sucesso" no log.
        if (!fs.existsSync(target)) {
          return Object.assign({ ok: false, reason: 'sync.compression.failed', detail: 'container nÃ£o foi criado', file: file.rel }, result);
        }
        const compacted = fs.statSync(target).size;
        if (compacted === 0 && file.size > 0) {
          fs.unlinkSync(target);
          return Object.assign({ ok: false, reason: 'sync.compression.failed', detail: 'container vazio', file: file.rel }, result);
        }
        result.bytesBefore += file.size;
        result.bytesAfter += compacted;
        // O original so e removido DEPOIS do container conferido: um 7z
        // falhando deixaria o arquivo solto no lugar, que e o estado de onde
        // sempre da para retomar.
        fs.unlinkSync(file.full);
      } catch (err) {
        return Object.assign({ ok: false, reason: 'sync.compression.failed', detail: err.message, file: file.rel }, result);
      }
    }
    return Object.assign({ ok: true }, result);
  }

  // Reverter: extrai o container de volta na pasta. E o unico caminho de
  // volta a sincronizacao, entao precisa existir e precisa ser explicito.
  async restoreArchive(policy, folderPath) {
    const p = normalize(policy);
    if (p.mode !== 'archive' || !p.archivePath) return { ok: false, reason: 'sync.compression.archivePathRequired' };
    if (!fs.existsSync(p.archivePath)) return { ok: false, reason: 'sync.compression.archiveMissing' };
    fs.mkdirSync(folderPath, { recursive: true });
    await this.sevenRun(['x', p.archivePath, `-o${path.resolve(folderPath)}`, '-y', '-bd']);
    const manifest = readManifest(p.archivePath);
    return { ok: true, restored: Object.keys(manifest.entries).length };
  }
}

module.exports = FolderCompressor;
module.exports.FolderCompressor = FolderCompressor;
module.exports.MODES = MODES;
module.exports.DEFAULT_LEVEL = DEFAULT_LEVEL;
module.exports.normalize = normalize;
module.exports.validate = validate;
module.exports.matches = matches;
module.exports.isWithin = isWithin;
module.exports.find7z = find7z;
module.exports.manifestPath = manifestPath;
module.exports.walk = walk;
