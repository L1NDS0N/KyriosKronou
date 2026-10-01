// nssmInstaller.js - NSSM Installation Manager
//
// O NSSM entra como dependência de sistema, pelo mesmo caminho do Syncthing:
// winget, chocolatey ou scoop, e um download direto como último recurso.
//
// Nada aqui monta comando de shell. As primeiras versões usavam
// `execSync(`"${nssmPath}" version`)`, e o caminho vinha do IPC do renderer:
// uma string com aspas e `&` ali virava execução de comando arbitrário, com a
// elevação do usuário que abriu o app. execFile recebe o executável e os
// argumentos separados, sem shell no meio, e o caminho é recusado se tiver
// caractere de controle.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const NSSM_URL = 'https://nssm.cc/release/nssm-2.24.zip';
const NSSM_VERSION = '2.24';

// Candidato malicioso precisa ser barrado no caminho, não sanitizado depois:
// não existe "escape" confiável de string para shell no Windows, porque o
// cmd.exe expande %VAR%, ^, & e | em camadas que não fecham.
function safeExecutable(candidate) {
  if (typeof candidate !== 'string') return null;
  const value = candidate.trim();
  if (!value) return null;
  // Aspas e metacaracteres de shell nunca aparecem num caminho legítimo do
  // Windows. O input é sempre o caminho de um executável apontado por quem
  // está instalando o serviço, e não o nome de uma pasta escolhido pelo
  // usuário: por isso as aspas entram na lista de recusa.
  if (/["<>|&^%!`]/.test(value)) return null;
  if (value.includes('\0')) return null;
  return value;
}

class NssmInstaller {
  constructor(logger, options = {}) {
    this.logger = logger;
    // Injetáveis para os testes: o caminho feliz precisa ser exercitado sem
    // baixar binário nem instalar pacote na máquina de quem roda a suíte.
    this.execFileSync = options.execFileSync || execFileSync;
    this.execFile = options.execFile || execFile;
    this.exists = options.exists || fs.existsSync;
    this.copyFileSync = options.copyFileSync || fs.copyFileSync;
    this.mkdirSync = options.mkdirSync || fs.mkdirSync;
  }

  log(level, message) { if (this.logger) this.logger.log(level, message); }

  // Executa o nssm com o argumento `version` e devolve a versão se ele
  // responder. Qualquer coisa diferente é "não instalado": um binário que não
  // existe, um caminho que dá erro, um exit code de outro programa.
  probe(exePath) {
    const exe = safeExecutable(exePath);
    if (!exe) return null;
    try {
      const result = this.execFileSync(exe, ['version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (typeof result !== 'string' || !result.includes('NSSM')) return null;
      const match = result.match(/NSSM\s+([\d.]+)/);
      return { installed: true, path: exe, version: match ? match[1] : 'unknown', method: 'probe' };
    } catch (e) {
      return null;
    }
  }

  // Check if NSSM is already installed and accessible
  checkInstalled(nssmPath) {
    const asked = this.probe(nssmPath || 'nssm');
    if (asked) return asked;

    for (const p of this.commonPaths()) {
      if (!this.exists(p)) continue;
      const found = this.probe(p);
      if (found) return Object.assign({}, found, { method: 'path' });
    }

    return { installed: false };
  }

  commonPaths() {
    const list = ['C:\\nssm\\win64\\nssm.exe', 'C:\\nssm\\win32\\nssm.exe'];
    if (process.env.ProgramFiles) list.push(path.join(process.env.ProgramFiles, 'nssm', 'nssm.exe'));
    if (process.env['ProgramFiles(x86)']) list.push(path.join(process.env['ProgramFiles(x86)'], 'nssm', 'nssm.exe'));
    if (process.env.USERPROFILE) list.push(path.join(process.env.USERPROFILE, 'nssm', 'nssm.exe'));
    if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'nssm', 'nssm.exe'));
    return list;
  }

  // Check available package managers
  checkPackageManagers() {
    const candidates = [
      { name: 'winget', label: 'Winget (Windows Package Manager)', args: ['--version'] },
      { name: 'choco', label: 'Chocolatey', args: ['--version'] },
      { name: 'scoop', label: 'Scoop', args: ['--version'] },
    ];
    return candidates.map((manager) => {
      let available = false;
      try {
        this.execFileSync(manager.name, manager.args, { encoding: 'utf8', timeout: 5000, windowsHide: true });
        available = true;
      } catch (e) { /* não está instalado */ }
      return { name: manager.name, label: manager.label, available };
    });
  }

  // Cada gerenciador tem seu próprio array de argumentos; nada é concatenado
  // numa string de shell.
  static COMMANDS = {
    winget: { exe: 'winget', args: ['install', 'nssm', '--accept-package-agreements', '--accept-source-agreements'] },
    choco: { exe: 'choco', args: ['install', 'nssm', '-y'] },
    scoop: { exe: 'scoop', args: ['install', 'nssm'] },
  };

  // Install NSSM via a package manager
  async installVia(manager) {
    const command = NssmInstaller.COMMANDS[manager];
    // Um nome fora da lista viraria string de shell com o que o renderer
    // mandasse; recusar é mais seguro do que tentar escapar.
    if (!command) return { success: false, message: `Unknown package manager: ${manager}` };

    this.log('INFO', `Installing NSSM via ${manager}: ${command.exe} ${command.args.join(' ')}`);

    return new Promise((resolve) => {
      this.execFile(command.exe, command.args, { encoding: 'utf8', timeout: 300000, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) {
            this.log('ERROR', `NSSM install failed: ${error.message}`);
            resolve({ success: false, message: error.message, stdout, stderr });
            return;
          }
          this.log('INFO', `NSSM installed successfully via ${manager}`);
          // Re-check if installed
          const check = this.checkInstalled('nssm');
          resolve({ success: check.installed, path: check.path, version: check.version, message: stdout || 'Installed' });
        });
    });
  }

  download(downloadDir) {
    const zipPath = path.join(downloadDir, 'nssm.zip');
    this.log('INFO', `Downloading NSSM from ${NSSM_URL}`);
    return new Promise((resolve, reject) => {
      const request = https.get(NSSM_URL, { timeout: 60000 }, (res) => {
        // O NSSM publica em nssm.cc, que redireciona. Seguir o redirect é o
        // comportamento normal, mas só para https: um 302 para http entregaria
        // o download em claro, e o arquivo vira um executável com elevação.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (!/^https:/i.test(res.headers.location)) {
            reject(new Error(`redirecionamento para fora de https: ${res.headers.location}`));
            return;
          }
          this.download(res.headers.location).then((zip) => resolve(zip), reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(zipPath);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(zipPath)));
        file.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new Error('timeout no download')));
      request.on('error', reject);
    });
  }

  extract(zipPath, extractDir) {
    return new Promise((resolve) => {
      const args = ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${String(zipPath).replace(/'/g, "''")}' -DestinationPath '${String(extractDir).replace(/'/g, "''")}' -Force`];
      this.execFile('powershell', args, { encoding: 'utf8', timeout: 60000, windowsHide: true },
        (error) => resolve(!error));
    });
  }

  // Procura o executável dentro da pasta extraída, sem `dir /s /b`: o
  // caminho é montado em Node e conferido com existsSync, então um nome de
  // arquivo com aspas não vira comando.
  findExtracted(extractDir) {
    const win64 = path.join(extractDir, `nssm-${NSSM_VERSION}`, 'win64', 'nssm.exe');
    const win32 = path.join(extractDir, `nssm-${NSSM_VERSION}`, 'win32', 'nssm.exe');
    if (this.exists(win64)) return win64;
    if (this.exists(win32)) return win32;
    // Fallback: um nível de pasta, que é como o zip vem organizado.
    try {
      const stack = [extractDir];
      while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) stack.push(full);
          else if (entry.isFile() && entry.name.toLowerCase() === 'nssm.exe') return full;
        }
      }
    } catch (e) { /* sem permissão ou pasta sumiu */ }
    return null;
  }

  // Download NSSM manually from nssm.cc
  async downloadManual(downloadDir) {
    const zipPath = path.join(downloadDir, 'nssm.zip');
    const extractDir = path.join(downloadDir, 'nssm');
    try {
      this.mkdirSync(extractDir, { recursive: true });
    } catch (e) {
      return { success: false, message: `Could not create ${extractDir}: ${e.message}` };
    }

    let downloaded;
    try {
      downloaded = await this.download(downloadDir);
    } catch (e) {
      return { success: false, message: `Download failed: ${e.message}` };
    }

    if (!await this.extract(downloaded, extractDir)) {
      return { success: false, message: 'Extraction failed' };
    }

    const found = this.findExtracted(extractDir);
    if (!found) return { success: false, message: 'Could not find nssm.exe in downloaded archive' };

    const stablePath = path.join(downloadDir, 'nssm.exe');
    try {
      this.copyFileSync(found, stablePath);
    } catch (e) {
      return { success: false, message: `Could not copy nssm.exe into place: ${e.message}` };
    }
    this.log('INFO', `NSSM extracted to ${stablePath}`);
    return { success: true, path: stablePath, message: `NSSM installed to ${stablePath}` };
  }
}

module.exports = NssmInstaller;
module.exports.NssmInstaller = NssmInstaller;
module.exports.safeExecutable = safeExecutable;
module.exports.NSSM_URL = NSSM_URL;
module.exports.NSSM_VERSION = NSSM_VERSION;