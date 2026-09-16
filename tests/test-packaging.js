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

  // The regression: an unanchored /dist matched every nested dist/ and quietly
  // removed dependency code, producing a build that died before opening a window.
  it('NEVER excludes a nested dist/ inside node_modules', () => {
    expect(ignore('/node_modules/basic-ftp/dist')).to.equal(false);
    expect(ignore('/node_modules/basic-ftp/dist/Client.js')).to.equal(false);
    expect(ignore('/node_modules/lucide/dist/umd/lucide.js')).to.equal(false);
  });

  it('NEVER excludes a nested build/ inside node_modules', () => {
    expect(ignore('/node_modules/sqlite3/build/Release/node_sqlite3.node')).to.equal(false);
    expect(ignore('/node_modules/cpu-features/build/Release/cpufeatures.node')).to.equal(false);
  });

  it('NEVER excludes a nested tests/ inside node_modules', () => {
    expect(ignore('/node_modules/mysql2/tests/helper.js')).to.equal(false);
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
  // rules never strip a file from them.
  it('does not drop any file from a runtime dependency', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const deps = Object.keys(pkg.dependencies || {});
    expect(deps.length).to.be.above(0);

    const dropped = [];
    for (const dep of deps) {
      const root = path.join(__dirname, '..', 'node_modules', dep);
      if (!fs.existsSync(root)) continue;

      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const rel = '/' + path.relative(path.join(__dirname, '..'), full).replace(/\\/g, '/');
          if (ignore(rel)) dropped.push(rel);
          else if (entry.isDirectory()) walk(full);
        }
      };
      walk(root);
    }

    expect(dropped, `these dependency paths would be stripped: ${dropped.slice(0, 10).join(', ')}`)
      .to.deep.equal([]);
  });
});
