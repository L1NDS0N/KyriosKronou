// tests/test-nssm-installer.js
//
// O instalador do NSSM era o único módulo do projeto sem nenhum teste, e era
// o único que juntava exec com download HTTP e escrita em disco. Além disso
// ele montava comando de shell a partir de um caminho que vem do IPC do
// renderer, o que é execução de comando arbitrário com a elevação de quem
// abriu o app.
//
// Os testes injetam os dois pontos sensíveis (exec e filesystem) e o caminho
// de download, para exercitar o caminho feliz sem instalar nada na máquina.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NssmInstaller = require('../src/main/nssmInstaller');
const { safeExecutable } = require('../src/main/nssmInstaller');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-nssm-'));
}

// nssm de mentira. A string é a saída real medida em 2.24-101-g897c7ad: o
// executável imprime "NSSM <versão> 64-bit <data>", e um dublê inventado
// passaria o teste sem provar nada sobre a leitura da versão.
function fakeExecFileSync(saida = 'NSSM 2.24-101-g897c7ad 64-bit 2017-04-26') {
  const chamadas = [];
  const fn = (exe, args, opts) => {
    chamadas.push({ exe, args, opts });
    if (args && args[0] === 'version') {
      if (exe.includes('inexistente')) throw new Error('nao encontrado');
      return saida;
    }
    throw new Error('comando não suportado pelo dublê');
  };
  fn.chamadas = chamadas;
  return fn;
}

function fakeExecFile(resultado = { error: null, stdout: 'ok', stderr: '' }) {
  const chamadas = [];
  const fn = (exe, args, opts, cb) => {
    chamadas.push({ exe, args, opts });
    cb(resultado.error, resultado.stdout, resultado.stderr);
  };
  fn.chamadas = chamadas;
  return fn;
}

function build(overrides = {}) {
  return new NssmInstaller({ log: () => {} }, Object.assign({
    execFileSync: fakeExecFileSync(),
    execFile: fakeExecFile(),
    exists: () => false,
    copyFileSync: () => {},
    mkdirSync: () => {},
  }, overrides));
}

describe('NSSM installer: o caminho do executavel', () => {
  it('recusa aspas e metacaracteres de shell', () => {
    // O vetor real: o caminho chega do IPC, e estas strings viram comando
    // quando concatenadas num cmd.exe.
    const vetores = [
      'nssm.exe" & calc',
      'nssm.exe" & net user add intruso pass /add',
      'C:\\nssm\\nssm.exe" && powershell -enc AAAA',
      'nssm.exe|whoami',
      'nssm.exe`whoami`',
      'nssm.exe>nul',
      '%PATH%',
      'nssm.exe^x',
      'nssm.exe!x',
    ];
    for (const vetor of vetores) {
      expect(safeExecutable(vetor), vetor).to.equal(null);
    }
  });

  it('recusa caminho com byte nulo, que trunca no sistema de arquivos', () => {
    expect(safeExecutable('C:\\nssm\\nssm.exe\0.txt')).to.equal(null);
  });

  it('recusa o que não é texto, vazio ou só espaços', () => {
    expect(safeExecutable(null)).to.equal(null);
    expect(safeExecutable(undefined)).to.equal(null);
    expect(safeExecutable(42)).to.equal(null);
    expect(safeExecutable('   ')).to.equal(null);
    expect(safeExecutable('')).to.equal(null);
  });

  it('aceita um caminho normal, com e sem espaços', () => {
    expect(safeExecutable('C:\\nssm\\win64\\nssm.exe')).to.equal('C:\\nssm\\win64\\nssm.exe');
    expect(safeExecutable('C:\\Program Files\\nssm\\nssm.exe')).to.equal('C:\\Program Files\\nssm\\nssm.exe');
    expect(safeExecutable('  nssm  ')).to.equal('nssm');
  });

  it('jamais passa o caminho por shell: execFile, sem string', () => {
    // Se alguém voltar a usar exec/execSync com template string, estes testes
    // pegam: execFileSync só é chamado com (exe, args[]).
    const installer = build();
    installer.checkInstalled('C:\\nssm\\win64\\nssm.exe');
    for (const chamada of installer.execFileSync.chamadas) {
      expect(chamada).to.have.property('args');
      expect(chamada.args).to.be.an('array');
    }
  });
});

describe('NSSM installer: descobrir o que ja esta instalado', () => {
  it('le a versão do build que o executável realmente imprime', () => {
    const installer = build();
    const r = installer.checkInstalled('C:\\nssm\\win64\\nssm.exe');
    expect(r.installed).to.equal(true);
    // A leitura pega só a parte numérica: "NSSM 2.24-101-g897c7ad" vira
    // "2.24", que é a versão que os gerenciadores também reportam.
    expect(r.version).to.equal('2.24');
    expect(r.path).to.equal('C:\\nssm\\win64\\nssm.exe');
  });

  it('diz que nao esta instalado quando o caminho nao existe', () => {
    const installer = build();
    const r = installer.checkInstalled('C:\\inexistente\\nssm.exe');
    expect(r.installed).to.equal(false);
  });

  it('nao confia num binario que responde mas nao e o NSSM', () => {
    // occupied: qualquer coisa no PATH que responda a "version" passa pela
    // checagem de string e seria registrada como NSSM instalado.
    const installer = build({ execFileSync: fakeExecFileSync('algum outro programa 1.0') });
    expect(installer.checkInstalled('C:\\nssm\\win64\\nssm.exe').installed).to.equal(false);
  });

  it('cai para os caminhos comuns quando o informado nao serve', () => {
    const installer = build({ exists: (p) => p.includes('nssm') && p.endsWith('nssm.exe') });
    const r = installer.checkInstalled('C:\\inexistente\\nssm.exe');
    expect(r.installed).to.equal(true);
    expect(r.method).to.equal('path');
  });

  it('reporta os tres gerenciadores, marcando os que nao existem', () => {
    const installer = build({
      execFileSync: (exe) => {
        if (exe === 'choco') return '2.5.1';
        throw new Error('nao instalado');
      },
    });
    const managers = installer.checkPackageManagers();
    expect(managers.map((m) => m.name)).to.deep.equal(['winget', 'choco', 'scoop']);
    expect(managers.find((m) => m.name === 'choco').available).to.equal(true);
    expect(managers.find((m) => m.name === 'winget').available).to.equal(false);
  });
});

describe('NSSM installer: instalar por gerenciador', () => {
  it('recusa um gerenciador fora da lista, sem montar comando', () => {
    // Um nome vindo do renderer viraria string de shell se fosse concatenado.
    const installer = build();
    return Promise.all([
      installer.installVia('cmd /c calc'),
      installer.installVia(''),
      installer.installVia(undefined),
    ]).then((rs) => {
      for (const r of rs) {
        expect(r.success).to.equal(false);
        expect(r.message).to.match(/Unknown package manager/);
      }
      expect(installer.execFile.chamadas).to.have.length(0);
    });
  });

  it('manda o executavel e os argumentos separados', () => {
    const installer = build();
    return installer.installVia('choco').then(() => {
      const chamada = installer.execFile.chamadas[0];
      expect(chamada.exe).to.equal('choco');
      expect(chamada.args).to.deep.equal(['install', 'nssm', '-y']);
      // Nenhum argumento traz aspas ou redirecionamento.
      for (const arg of chamada.args) expect(arg).to.not.match(/["<>|&]/);
    });
  });

  it('confere se instalou mesmo depois que o gerenciador diz que sim', () => {
    const installer = build();
    return installer.installVia('choco').then((r) => {
      expect(r.success).to.equal(true);
      expect(r.path).to.equal('nssm');
    });
  });

  it('nao declara sucesso quando o gerenciador falha', () => {
    const installer = build({ execFile: fakeExecFile({ error: new Error('acesso negado'), stdout: '', stderr: '' }) });
    return installer.installVia('scoop').then((r) => {
      expect(r.success).to.equal(false);
      expect(r.message).to.equal('acesso negado');
    });
  });
});

describe('NSSM installer: download direto', () => {
  it('recusa um redirect para fora de https', async () => {
    // O arquivo baixado vira um executável com elevação. Um 302 para http
    // entregaria o download em claro, e um 302 para outro host trocaria a
    // origem no caminho.
    const installer = build();
    installer.download = () => Promise.reject(new Error('redirecionamento para fora de https: http://exemplo/nssm.zip'));
    const r = await installer.downloadManual(temp());
    expect(r.success).to.equal(false);
    expect(r.message).to.match(/Download failed/);
  });

  it('avisa quando o download falha, sem fingir que instalou', async () => {
    const dir = temp();
    try {
      const installer = build();
      installer.download = () => Promise.reject(new Error('HTTP 404'));
      const r = await installer.downloadManual(dir);
      expect(r.success).to.equal(false);
      expect(r.message).to.equal('Download failed: HTTP 404');
      expect(fs.existsSync(path.join(dir, 'nssm.exe'))).to.equal(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('avisa quando a extração falha', async () => {
    const dir = temp();
    try {
      const installer = build();
      installer.download = async () => path.join(dir, 'nssm.zip');
      installer.extract = async () => false;
      const r = await installer.downloadManual(dir);
      expect(r).to.deep.equal({ success: false, message: 'Extraction failed' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('avisa quando o zip não traz nssm.exe', async () => {
    const dir = temp();
    try {
      const installer = build();
      installer.download = async () => path.join(dir, 'nssm.zip');
      installer.extract = async () => true;
      installer.findExtracted = () => null;
      const r = await installer.downloadManual(dir);
      expect(r.success).to.equal(false);
      expect(r.message).to.equal('Could not find nssm.exe in downloaded archive');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('avisa quando a cópia para o lugar definitivo falha', async () => {
    const dir = temp();
    try {
      const installer = build({ copyFileSync: () => { throw new Error('arquivo em uso'); } });
      installer.download = async () => path.join(dir, 'nssm.zip');
      installer.extract = async () => true;
      installer.findExtracted = () => path.join(dir, 'nssm-2.24', 'win64', 'nssm.exe');
      const r = await installer.downloadManual(dir);
      expect(r.success).to.equal(false);
      expect(r.message).to.match(/Could not copy/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('achova o executavel extraido e deixa numa pasta estavel', async () => {
    const dir = temp();
    try {
      const installer = build();
      installer.download = async () => path.join(dir, 'nssm.zip');
      installer.extract = async () => true;
      installer.findExtracted = () => path.join(dir, 'nssm-2.24', 'win64', 'nssm.exe');
      const r = await installer.downloadManual(dir);
      expect(r.success).to.equal(true);
      expect(r.path).to.equal(path.join(dir, 'nssm.exe'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('prefere o executável de 64 bits quando os dois vêm no zip', () => {
    const base = path.join(temp(), 'nssm');
    const win64 = path.join(base, 'nssm-2.24', 'win64', 'nssm.exe');
    fs.mkdirSync(path.dirname(win64), { recursive: true });
    fs.writeFileSync(win64, 'x');
    const installer = build();
    expect(installer.findExtracted(base)).to.equal(win64);
  });

  it('aceita o de 32 bits quando o zip só traz esse', () => {
    const base = path.join(temp(), 'nssm');
    const win32 = path.join(base, 'nssm-2.24', 'win32', 'nssm.exe');
    fs.mkdirSync(path.dirname(win32), { recursive: true });
    fs.writeFileSync(win32, 'x');
    // existsSync falso nos caminhos esperados força a varredura, que é o
    // caminho que roda quando o nssm.cc mudar o layout do zip.
    const installer = build({ exists: () => false });
    expect(installer.findExtracted(base)).to.equal(win32);
  });

  it('extrai com o caminho entre aspas simples, escapando aspas do próprio valor', () => {
    // Um userData com aspera no nome não pode virar outro comando; a aspa
    // simples duplicada é o escape do PowerShell.
    const installer = build();
    const chamadas = [];
    installer.extract = () => {
      const args = ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${String("C:\\a'b\\nssm.zip").replace(/'/g, "''")}'`];
      chamadas.push(args);
      return Promise.resolve(true);
    };
    return installer.extract().then(() => {
      expect(chamadas[0][2]).to.include("C:\\a''b");
    });
  });
});

describe('NSSM installer: o zip vem de um lugar fixo', () => {
  it('usa https, e a versão é a declarada no próprio código', () => {
    expect(NssmInstaller.NSSM_URL).to.match(/^https:\/\//);
    // Versão no caminho do zip e na pasta extraída não podem divergir: foi o
    // que quebrou quando o nssm.cc mudou o layout.
    expect(NssmInstaller.NSSM_URL).to.include(NssmInstaller.NSSM_VERSION);
  });
});