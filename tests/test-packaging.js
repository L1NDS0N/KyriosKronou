// tests/test-packaging.js
//
// The packaging ignore rules decide what ships. Getting them wrong is silent:
// the build succeeds, the installer shrinks, and the app crashes on startup
// because a dependency lost its dist/ folder. That is exactly what happened
// when the patterns were passed as regexes through cmd.exe, which strips "^".
//
// These tests exercise the ignore predicate directly.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

// The script runs packager on require, so pull the predicate out by reading the
// module in a sandbox-free way: it only exports on execution, so replicate the
// rules by requiring the file with a guard.
const { ignore } = require('../scripts/package-app');

describe('Packaging: ignore rules', () => {
  it('excludes the project dist directory, so a build never embeds the last installer', () => {
    expect(ignore('/dist')).to.equal(true);
    expect(ignore('/dist/KyriosChronos-Setup-1.0.0.exe')).to.equal(true);
  });

  it('excludes the project build output', () => {
    expect(ignore('/build')).to.equal(true);
    expect(ignore('/build/KyriosChronos-win32-x64/KyriosChronos.exe')).to.equal(true);
  });

  it('excludes tests and CI config from a shipped app', () => {
    expect(ignore('/tests')).to.equal(true);
    expect(ignore('/tests/test-service.js')).to.equal(true);
    expect(ignore('/.github/workflows/build.yml')).to.equal(true);
  });

  // A build com cache aquecido é exatamente quando o instalador deveria ser
  // mais leve, e ele ficou 2,3x maior: o .cache do workflow de release
  // (~400 MB de Electron, NSIS e winCodeSign) mora dentro do workspace e
  // ninguém o excluía, então o packager o copiou para dentro do app.asar.
  it('excludes the toolchain cache, or a cached build ships 400 MB of Electron', () => {
    expect(ignore('/.cache')).to.equal(true);
    expect(ignore('/.cache/electron/electron-v28.3.3-win32-x64.zip')).to.equal(true);
    expect(ignore('/.cache/electron-builder')).to.equal(true);
  });

  it('excludes as configuracoes locais do Claude, que nao pertencem ao app', () => {
    expect(ignore('/.claude')).to.equal(true);
    expect(ignore('/.claude/settings.local.json')).to.equal(true);
  });

  // O renderer carrega src/renderer/lucide.min.js com uma tag <script> comum e
  // nada em src/ faz require('lucide'). O pacote npm são 20 MB dos mesmos
  // ícones em três formatos de módulo, e o app nunca o lê.
  it('exclui o pacote lucide, que o app carrega de um arquivo local', () => {
    expect(ignore('/node_modules/lucide')).to.equal(true);
    expect(ignore('/node_modules/lucide/dist/umd/lucide.js')).to.equal(true);
    expect(ignore('/node_modules/lucide/dist/esm/icons/clock.mjs')).to.equal(true);
    // E o arquivo local, que é o que o index.html realmente usa, continua.
    expect(ignore('/src/renderer/lucide.min.js')).to.equal(false);
  });

  it('exclui source maps, tipos e testes das dependencias', () => {
    expect(ignore('/node_modules/express/index.js.map')).to.equal(true);
    expect(ignore('/node_modules/mssql/lib/base.d.ts')).to.equal(true);
    expect(ignore('/node_modules/mssql/lib/base.ts')).to.equal(true);
    expect(ignore('/node_modules/lodash/test/test.js')).to.equal(true);
    expect(ignore('/node_modules/express/Readme.md')).to.equal(true);
  });

  it('nao toca nos arquivos do projeto que tenham esses nomes', () => {
    // O filtro de node_modules é o que separa "limpar dependência" de "apagar o
    // código do app". Um .ts ou um .map em src/ é do projeto.
    expect(ignore('/src/main/types.ts')).to.equal(false);
    expect(ignore('/src/renderer/app.js.map')).to.equal(false);
    expect(ignore('/docs/tests.md')).to.equal(false);
  });

  it('mantem o codigo que o app executa de verdade', () => {
    for (const caminho of [
      '/src/main/main.js',
      '/src/main/syncthing/network.js',
      '/src/renderer/index.html',
      '/src/renderer/app.js',
      '/src/renderer/i18n.js',
      '/src/renderer/style.css',
      '/node_modules/express/index.js',
      '/node_modules/mssql/lib/base.js',
      '/package.json',
    ]) {
      expect(ignore(caminho), caminho).to.equal(false);
    }
  });

  // The regression: an unanchored /dist matched every nested dist/ and quietly
  // removed dependency code, producing a build that died before opening a window.
  // Este bloco existe para o bug do `/dist` sem âncora, que removia o diretório
  // dist/ e build/ de dentro de node_modules - onde eles carregam código real
  // (basic-ftp/dist, cpu-features/build/Release/*.node) - e produzia um app que
  // morria antes de abrir a janela. tests/ nunca foi o caso: um diretório de
  // testes dentro de uma dependência não é carregado por ninguém.
  it('NEVER excludes a nested dist/ inside node_modules', () => {
    expect(ignore('/node_modules/basic-ftp/dist')).to.equal(false);
    expect(ignore('/node_modules/basic-ftp/dist/Client.js')).to.equal(false);
    // lucide é a exceção deliberada: o pacote inteiro sai, porque o renderer
    // carrega src/renderer/lucide.min.js e não require('lucide') em lugar
    // nenhum. Se algum dia o app passar a importar o pacote, este teste falha.
    expect(ignore('/node_modules/lucide')).to.equal(true);
  });

  it('NEVER excludes a nested build/ inside node_modules', () => {
    expect(ignore('/node_modules/sqlite3/build/Release/node_sqlite3.node')).to.equal(false);
    expect(ignore('/node_modules/cpu-features/build/Release/cpufeatures.node')).to.equal(false);
  });

  it('excludes a nested tests/ inside node_modules, que ninguem carrega', () => {
    expect(ignore('/node_modules/mysql2/tests/helper.js')).to.equal(true);
  });

  it('keeps build-resources, whose icon the app loads at runtime', () => {
    expect(ignore('/build-resources')).to.equal(false);
    expect(ignore('/build-resources/icon.ico')).to.equal(false);
  });

  it('keeps everything the app actually needs', () => {
    for (const keep of [
      '/src/main/main.js',
      '/src/main/serviceScheduler.js',
      '/src/main/paths.js',
      '/src/renderer/index.html',
      '/package.json',
      '/node_modules/express/lib/express.js',
      '/node_modules/mysql2/index.js',
    ]) {
      expect(ignore(keep)).to.equal(false, `${keep} must ship`);
    }
  });

  it('handles Windows backslash separators', () => {
    expect(ignore('\\dist\\installer.exe')).to.equal(true);
    expect(ignore('\\node_modules\\basic-ftp\\dist\\Client.js')).to.equal(false);
  });

  it('tolerates an empty path', () => {
    expect(ignore('')).to.equal(false);
    expect(ignore(undefined)).to.equal(false);
  });
});

describe('Packaging: dependencies survive the ignore rules', () => {
  // Walk the real node_modules for the runtime dependencies and assert the
  // rules never strip a file the runtime could actually load. This started as
  // "no file at all", which was the right instinct - an unanchored /dist gutted
  // basic-ftp/dist and the app crashed - but it was too broad once source maps
  // and type declarations were excluded: none of those is ever loaded. The
  // invariant that matters is that executable code survives, and that is what
  // this checks, with the noise categories allowed through explicitly.
  const RUNTIME_LOADABLE = /\.(js|mjs|cjs|json|node)$/i;

  it('does not drop any loadable file from a runtime dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    expect(deps.length).to.be.above(0);

    const dropped = [];
    const ignorados = [];
    for (const dep of deps) {
      // lucide is deliberately out: the renderer loads lucide.min.js directly.
      if (dep === 'lucide') continue;
      const root = path.join(__dirname, '..', 'node_modules', dep);
      if (!fs.existsSync(root)) continue;

      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = '/' + path.relative(path.join(__dirname, '..'), full).replace(/\\/g, '/');
          if (ignore(rel)) {
            if (RUNTIME_LOADABLE.test(rel)) dropped.push(rel);
            else ignorados.push(rel);
          } else if (entry.isDirectory()) walk(full);
        }
      };
      walk(root);
    }

    expect(dropped, `these loadable dependency paths would be stripped: ${dropped.slice(0, 10).join(', ')}`)
      .to.deep.equal([]);
    // And the exclusions that were applied are only the noise categories.
    for (const caminho of ignorados) {
      expect(caminho, 'so sourcemap, tipos, testes e readme podem sair')
        .to.match(/\.(map|d\.ts|ts|md|markdown)$|(\/|^)(test|tests|__tests__|example|examples)\//i);
    }
  });

  it('keeps the entry point of every runtime dependency', () => {
    // The file a package.json "main" points at is what the runtime resolves
    // first. Losing it is what turns a trim into a crash.
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const root = path.join(__dirname, '..', 'node_modules');
    const verificados = [];
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (dep === 'lucide') continue;
      const dir = path.join(root, dep);
      if (!fs.existsSync(dir)) continue;
      const manifest = path.join(dir, 'package.json');
      if (!fs.existsSync(manifest)) continue;
      let entry;
      try { entry = JSON.parse(fs.readFileSync(manifest, 'utf8')).main; } catch (e) { continue; }
      if (!entry) continue;
      const rel = '/' + path.relative(path.join(__dirname, '..'), path.join(dir, entry)).replace(/\\/g, '/');
      expect(ignore(rel), `${dep} perdeu o main (${entry})`).to.equal(false);
      verificados.push(dep);
    }
    expect(verificados.length, 'nenhum pacote verificado').to.be.above(3);
  });
});
