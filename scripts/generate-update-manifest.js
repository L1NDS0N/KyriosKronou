// scripts/generate-update-manifest.js
//
// O instalador que é publicado é montado pelo NSIS a partir de
// installer/KyriosChronos-Installer.nsi, que nomeia o setup
// KyriosChronos-Setup-<versão>.exe. O electron-builder não roda nesse caminho,
// então ele não produz latest.yml nem .blockmap para o que realmente vai para
// a release.
//
// Este script monta o latest.yml que o electron-updater consome: a versão, a
// url relativa do instalador e o sha512. A URL é relativa de propósito: o
// updater a resolve a partir do feed, que aponta para a release do GitHub, e um
// caminho absoluto deixaria de funcionar se o repositório fosse movido.
//
// O .blockmap fica de fora de propósito: é do electron-builder e o updater o
// usa só para o download delta, que exige um blockmap do instalador real. Sem
// um blockmap correspondente, publicar um errado pioraria o download em vez de
// ajudá-lo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

function parseArgs() {
  const args = {};
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i += 1) {
    if (!raw[i].startsWith('--')) continue;
    const key = raw[i].slice(2);
    const value = raw[i + 1];
    if (value && !value.startsWith('--')) { args[key] = value; i += 1; }
    else args[key] = true;
  }
  return args;
}

const args = parseArgs();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// --dist existe para o teste exercitar o script sem encostar no build de
// verdade: o diretório fica em outro disco na maioria das máquinas e um
// rename entre volumes não é permitido.
const DIST = path.resolve(ROOT, String(args.dist || 'dist'));
// Aceita a tag como vem (v1.0.2) ou a versão crua: o workflow passa a tag, e o
// nome do instalador é montado a partir da versão, sem o "v".
const version = String(args.version || pkg.version).replace(/^v/, '');
const fileName = String(args.file || `KyriosChronos-Setup-${version}.exe`);
const installer = path.join(DIST, fileName);

if (!fs.existsSync(installer)) {
  // Sem o instalador não há o que descrever. Falhar aqui é melhor que publicar
  // um latest.yml apontando para um arquivo que não existe: o updater baixaria
  // um 404 e o usuário veria um erro de download em vez de nada.
  process.stderr.write(`Installer not found: ${installer}\n`);
  process.exit(1);
}

const bytes = fs.readFileSync(installer);
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
const releaseDate = new Date().toISOString();

const manifest = [
  `version: ${version}`,
  'files:',
  `  - url: ${fileName}`,
  `    sha512: ${sha512}`,
  `    size: ${bytes.length}`,
  `path: ${fileName}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n');

const out = path.join(DIST, 'latest.yml');
fs.writeFileSync(out, manifest, 'utf8');
if (!args.quiet) {
  process.stdout.write(`latest.yml written for ${version} (${fileName}, ${bytes.length} bytes)\n`);
}
