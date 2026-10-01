// syncthing/installer.js - Localiza e instala o binário do Syncthing.
//
// O Syncthing é GPLv3 e por isso NÃO entra no instalador do Kyrios: o projeto é
// MIT e empacotar um binário GPL contaminaria a licença do produto. Ele é
// tratado como dependência de sistema, exatamente como o NSSM, e instalado pelo
// Chocolatey - que é o mesmo caminho já usado pelo NssmInstaller.

const { execSync, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const PROBE_TIMEOUT = 8000;
const CHOCO_SCRIPT_URL = 'https://community.chocolatey.org/install.ps1';

// SHA-256 do install.ps1 oficial, medido em 2026-10-01.
//
// Isto roda como LocalSystem num servidor e é alcançável pelo painel web, e a
// versão anterior jogava o corpo baixado direto no `iex`. Quem controlasse a
// resposta controlaria o que o Kyrios executa com a maior elevação da máquina.
//
// O preço do hash fixo é conhecido e é o correto: quando o Chocolatey publicar
// um install.ps1 novo, a instalação por bootstrap falha com hashDivergente em
// vez de executar um script que ninguém leu. Para destravar, atualize a
// constante abaixo ou aponte KYRION_CHOCO_SCRIPT_SHA256 para o valor novo,
// conferido em https://community.chocolatey.org/install.ps1.
const CHOCO_SCRIPT_SHA256 = '44e045ed5350758616d664c5af631e7f2cd10165f5bf2bd82cbf3a0bb8f63462';

// Lido a cada chamada, e não na carga do módulo: quem ajusta o hash por
// ambiente precisa valer na hora da instalação, sem depender de quando o
// processo subiu.
function expectedChocoHash() {
  const custom = process.env.KYRION_CHOCO_SCRIPT_SHA256;
  return custom && /^[a-f0-9]{64}$/i.test(custom) ? custom.toLowerCase() : CHOCO_SCRIPT_SHA256;
}

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
  constructor(logger, options = {}) {
    this.logger = logger;
    // Injetáveis para os testes: verificar "o corpo adulterado não executa
    // nada" exige substituir o executor, e `execFile` desestruturado no topo
    // não é alcançado de quem troca o módulo depois do require. Sem isto o
    // teste rodava PowerShell de verdade na máquina de quem roda a suíte.
    this.execFile = options.execFile || execFile;
    this.execFileSync = options.execFileSync || execSync;
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
      this.execFileSync('choco', ['--version'], { encoding: 'utf8', timeout: PROBE_TIMEOUT, windowsHide: true });
      return true;
    } catch (e) {
      return false;
    }
  }

  // Baixa o script oficial para um arquivo, sem shell e sem iex. O corpo volta
// como texto e quem decide o que acontece com ele é o sha256 abaixo.
downloadChocoScript(destino) {
  return new Promise((resolve, reject) => {
    const req = https.get(CHOCO_SCRIPT_URL, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // Só https: um 302 para http entregaria o instalador em claro, e ele
        // vira um programa com elevação.
        if (!/^https:/i.test(res.headers.location)) {
          reject(new Error(`redirecionamento para fora de https: ${res.headers.location}`));
          return;
        }
        reject(new Error('redirecionamento não suportado pelo instalador do chocolatey'));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const corpo = Buffer.concat(chunks);
        try { fs.writeFileSync(destino, corpo); } catch (e) { reject(e); return; }
        resolve(corpo);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ao baixar o instalador do chocolatey')));
    req.on('error', reject);
  });
}

  sha256Hex(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  // Compara em tempo constante pelo motivo de costume: o valor esperado é fixo
  // e o segredo não é, mas o padrão de comparação errada é o que se copia
  // adiante.
  hashMatches(esperado, obtido) {
    const a = Buffer.from(String(esperado).toLowerCase(), 'utf8');
    const b = Buffer.from(String(obtido).toLowerCase(), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /**
   * Instala o Chocolatey, mas só depois de conferir o script baixado.
   *
   * O Chocolatey não vem instalado no Windows Server nem num perfil novo, e
   * todo o resto desta cadeia depende dele existir.
   *
   * Antes, isto era uma linha só: DownloadString e `iex`. Servindo
   * LocalSystem, com o caminho alcançável pelo painel, qualquer um que
   * respondesse no lugar do community.chocolatey.org executava o próprio
   * código como SYSTEM.
   *
   * Agora o corpo vai para um arquivo, o SHA-256 é conferido contra a
   * constante acima, e a execução usa `-File` num caminho que o próprio processo
   * escolheu. Divergência de hash não executa nada.
   */
  installChocolatey() {
    const destino = path.join(os.tmpdir(), `chocolatey-install-${process.pid}.ps1`);

    return this.downloadChocoScript(destino)
      .catch((err) => ({
        success: false, step: 'chocolatey', message: `Falha ao baixar o instalador: ${err.message}`,
      }))
      .then((download) => {
        if (download && download.success === false) return download;

        const esperado = expectedChocoHash();
        const obtido = this.sha256Hex(fs.readFileSync(destino));
        if (!this.hashMatches(esperado, obtido)) {
          // Mesmo recusando executar, o corpo baixado não fica no disco: é um
          // arquivo sob %TEMP% que ninguém vai lembrar de limpar depois.
          try { fs.unlinkSync(destino); } catch (e) { /* já não existe */ }
          this.logger.log('ERROR', `install.ps1 do chocolatey com hash inesperado: ${obtido}`);
          return {
            success: false,
            step: 'chocolatey',
            reason: 'sync.install.chocoHashMismatch',
            hash: obtido,
            expected: esperado,
            message: 'O instalador do Chocolatey mudou e não foi conferido; nada foi executado.',
          };
        }

        this.logger.log('INFO', `install.ps1 do chocolatey conferido (sha256 ${obtido.slice(0, 12)}…)`);
        return new Promise((resolve) => {
          // -File, e não -Command com o corpo embutido: o arquivo já está no
          // disco e conferido, e o caminho não passa por interpretador nenhum.
          this.execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', destino], {
            encoding: 'utf8', timeout: 300000, windowsHide: true,
          }, (error, stdout, stderr) => {
            try { fs.unlinkSync(destino); } catch (e) { /* já não existe */ }
            if (error) {
              this.logger.log('ERROR', `Chocolatey install falhou: ${error.message}`);
              resolve({ success: false, step: 'chocolatey', message: error.message, stdout, stderr });
              return;
            }
            this.logger.log('INFO', 'Chocolatey instalado com sucesso');
            resolve({ success: true, step: 'chocolatey', stdout, stderr });
          });
        });
      });
  }

  // Resolve a versão mais nova pelo próprio repositório antes de instalar.
  // `choco install syncthing` sem --version instala a latest, mas o resultado
  // fica implícito; fixar a versão deixa a instalação auditável e evita que uma
  // atualização do pacote chegue junto sem ninguém pedir.
  resolveLatestVersion() {
    return new Promise((resolve) => {
      this.execFile('choco', ['search', 'syncthing', '--exact', '--limit-output'],
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
        // O `reason` atravessa a cadeia: sem ele a tela só diria "falhou", e
        // hash divergente é uma situação que o operador precisa resolver
        // conferindo o script, não uma falha qualquer de rede.
        return Object.assign({
          success: false,
          step: 'chocolatey',
          message: bootstrap.message || 'Chocolatey nao ficou disponivel apos a instalacao',
        }, bootstrap.reason ? { reason: bootstrap.reason, expected: bootstrap.expected, hash: bootstrap.hash } : {});
      }
    }

    const wanted = await this.resolveLatestVersion();
    if (!wanted) {
      return { success: false, step: 'syncthing', message: 'Nao foi possivel resolver a versao mais nova do Syncthing no repositorio' };
    }

    const args = ['install', 'syncthing', '--version', wanted, '-y', '--no-progress'];
    this.logger.log('INFO', `Instalando Syncthing ${wanted} via chocolatey: choco ${args.join(' ')}`);

    return new Promise((resolve) => {
      this.execFile('choco', args, {
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
module.exports.CHOCO_SCRIPT_URL = CHOCO_SCRIPT_URL;
module.exports.CHOCO_SCRIPT_SHA256 = CHOCO_SCRIPT_SHA256;
module.exports.expectedChocoHash = expectedChocoHash;
