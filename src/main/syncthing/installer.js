// syncthing/installer.js - Localiza e instala o binário do Syncthing.
//
// O Syncthing é GPLv3 e por isso NÃO entra no instalador do Kyrios: o projeto é
// MIT e empacotar um binário GPL contaminaria a licença do produto. Ele é
// tratado como dependência de sistema, exatamente como o NSSM, e instalado pelo
// Chocolatey - que é o mesmo caminho já usado pelo NssmInstaller.

const { execSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROBE_TIMEOUT = 8000;

// Chocolatey installs the real executable under its tools folder and drops a
// shim in bin. Both are listed because the shim is what lands on PATH.
function candidatePaths() {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const chocoBin = path.join(programData, 'chocolatey', 'bin');
  const chocoLib = path.join(programData, 'chocolatey', 'lib');
  const paths = [
    path.join(chocoBin, 'syncthing.exe'),
    path.join(chocoLib, 'syncthing', 'tools', 'syncthing.exe'),
    path.join(chocoLib, 'syncthing.portable', 'tools', 'syncthing.exe'),
  ];

  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) paths.push(path.join(base, 'Syncthing', 'syncthing.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    paths.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Syncthing', 'syncthing.exe'));
  }
  return paths;
}

// "syncthing version v1.30.0 (...)" on v1, "syncthing v2.1.4 (...)" on v2.
// Both shapes are matched because the CLI flags differ between the two majors.
function parseVersion(output) {
  const match = String(output || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    text: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function probeExecutable(exePath) {
  return new Promise((resolve) => {
    execFile(exePath, ['version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT }, (error, stdout, stderr) => {
      if (error && !stdout) return resolve(null);
      const version = parseVersion(`${stdout} ${stderr}`);
      if (!version) return resolve(null);
      resolve({ path: exePath, version, method: 'probe' });
    });
  });
}

// O Syncthing 2.x é a linha atual. Uma instalação mais antiga ainda funciona
// (o daemon monta os flags da v1), mas o schema de config é o da v2 e é o que a
// UI nova assume.
const MIN_MAJOR = 2;

// `choco search --exact --limit-output` responde "syncthing|2.1.5".
function parseLatestVersion(stdout) {
  const match = String(stdout || '').trim().match(/^syncthing\|(\d+(?:\.\d+)+)/im);
  return match ? match[1] : null;
}

class SyncthingInstaller {
  constructor(logger) {
    this.logger = logger;
  }

  // Returns { installed, path, version } - version is null when not installed.
  async checkInstalled() {
    for (const candidate of candidatePaths()) {
      if (!fs.existsSync(candidate)) continue;
      const probed = await probeExecutable(candidate);
      if (probed) return { installed: true, ...probed, method: 'path' };
    }

    const onPath = await probeExecutable('syncthing');
    if (onPath) return { installed: true, ...onPath, method: 'existing' };

    return { installed: false };
  }

  hasChocolatey() {
    try {
      execSync('choco --version', { encoding: 'utf8', timeout: PROBE_TIMEOUT });
      return true;
    } catch (e) {
      return false;
    }
  }

  // Chocolatey itself is not installed by default on Windows Server or on a
  // fresh profile, and every other dependency here assumes it exists.
  installChocolatey() {
    const script = [
      'Set-ExecutionPolicy Bypass -Scope Process -Force;',
      '[System.Net.ServicePointManager]::SecurityProtocol =',
      '[System.Net.ServicePointManager]::SecurityProtocol -bor 3072;',
      "iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))",
    ].join(' ');

    return new Promise((resolve) => {
      this.logger.log('INFO', 'Chocolatey ausente: instalando via script oficial');
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
        timeout: 300000,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) {
          this.logger.log('ERROR', `Chocolatey install falhou: ${error.message}`);
          resolve({ success: false, step: 'chocolatey', message: error.message, stdout, stderr });
          return;
        }
        this.logger.log('INFO', 'Chocolatey instalado com sucesso');
        resolve({ success: true, step: 'chocolatey', stdout, stderr });
      });
    });
  }

  // Resolve a versão mais nova pelo próprio repositório antes de instalar.
  // `choco install syncthing` sem --version instala a latest, mas o resultado
  // fica implícito; fixar a versão deixa a instalação auditável e evita que uma
  // atualização do pacote chegue junto sem ninguém pedir.
  resolveLatestVersion() {
    return new Promise((resolve) => {
      execFile('choco', ['search', 'syncthing', '--exact', '--limit-output'],
        { encoding: 'utf8', timeout: 60000, windowsHide: true },
        (error, stdout) => {
          if (error) { resolve(null); return; }
          resolve(parseLatestVersion(stdout));
        });
    });
  }

  async installSyncthing() {
    if (!this.hasChocolatey()) {
      const bootstrap = await this.installChocolatey();
      if (!bootstrap.success || !this.hasChocolatey()) {
        return {
          success: false,
          step: 'chocolatey',
          message: bootstrap.message || 'Chocolatey nao ficou disponivel apos a instalacao',
        };
      }
    }

    const wanted = await this.resolveLatestVersion();
    if (!wanted) {
      return { success: false, step: 'syncthing', message: 'Nao foi possivel resolver a versao mais nova do Syncthing no repositorio' };
    }

    const args = ['install', 'syncthing', '--version', wanted, '-y', '--no-progress'];
    this.logger.log('INFO', `Instalando Syncthing ${wanted} via chocolatey: choco ${args.join(' ')}`);

    return new Promise((resolve) => {
      execFile('choco', args, {
        encoding: 'utf8',
        timeout: 600000,
        windowsHide: true,
      }, async (error, stdout, stderr) => {
        if (error) {
          this.logger.log('ERROR', `Syncthing install falhou: ${error.message}`);
          resolve({ success: false, step: 'syncthing', message: error.message, stdout, stderr });
          return;
        }
        const check = await this.checkInstalled();
        if (!check.installed) {
          resolve({ success: false, step: 'syncthing', message: 'choco terminou, mas o binario nao foi encontrado', stdout, stderr });
          return;
        }
        if (check.version.major < MIN_MAJOR) {
          this.logger.log('WARN', `Syncthing ${check.version.text} instalado, mas a linha atual e a ${MIN_MAJOR}.x`);
        }
        this.logger.log('INFO', `Syncthing instalado: ${check.path} (v${check.version.text})`);
        resolve({ success: true, step: 'syncthing', path: check.path, version: check.version, stdout, stderr });
      });
    });
  }
}

module.exports = SyncthingInstaller;
module.exports.SyncthingInstaller = SyncthingInstaller;
module.exports.parseVersion = parseVersion;
module.exports.parseLatestVersion = parseLatestVersion;
module.exports.candidatePaths = candidatePaths;
module.exports.MIN_MAJOR = MIN_MAJOR;
