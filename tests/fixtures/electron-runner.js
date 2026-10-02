// electron-runner.js - Sobe o renderer do Electron para um teste e espera o
// resultado.
//
// Seis arquivos de teste faziam isso na mão, com timeout de 30s. Duas coisas
// quebraram junto:
//
// 1. O primeiro spawn do Electron numa máquina fria passa de 30s com
//    antivírus varrendo um binário de 200 MB, e o teste matava um processo
//    que estava apenas lento. Medido aqui: 47s na primeira vez, 3,4s na
//    segunda. O Electron abre arquivos e registra a GPU na primeira execução.
//
// 2. O timeout não distingue "travou" de "está demorando". Com uma tentativa
//    só, qualquer lentidão vira falha; sem repetir, um travamento real vira uma
//    falha barulhenta que é preciso distinguir de uma lentidão.
//
// Uma tentativa só quando o processo morre com código diferente de zero (erro
// de verdade), e duas tentativas quando é timeout (lentidão). O resultado é
// distinguível: "não terminou duas vezes" é travamento, "terminou na segunda" é
// Environment lento.

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const PRIMEIRA_TENTATIVA_MS = 120000;
const SEGUNDA_TENTATIVA_MS = 60000;

// Cada runner imprime o resultado com um prefixo próprio
// (BACKUP_UI_RESULT=, CALENDAR_UI_RESULT=, ...). Procurar um prefixo fixo
// fazia os outros quatro testes falharem com "não imprimiu resultado" mesmo
// com o resultado inteiro no stdout. O prefixo é derivado do nome do arquivo,
// que é a mesma regra que o runner usa.
function prefixoDe(runnerPath) {
  const nome = path.basename(runnerPath);
  // "backup-ui-runner.js" -> "BACKUP_UI". O -runner inteiro sai: deixar o
  // sufixo para tras produzia BACKUP_UI_RUNNER_JS e nenhum resultado casava.
  const semRunner = nome.replace(/-runner\.js$/i, '').replace(/-ui$/i, '').replace(/_ui$/i, '');
  return `${semRunner.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_UI_RESULT=`;
}

function umaTentativa(runnerPath, limite, rotulo) {
  const prefixo = prefixoDe(runnerPath);
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, [runnerPath], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let encerrado = false;

    const timer = setTimeout(() => {
      if (encerrado) return;
      child.kill();
      // timeout é distinguished de "saiu com erro": vale repetir.
      reject(Object.assign(new Error(`${rotulo} nao terminou em ${limite / 1000}s. stderr:\n${stderr}`), { timeout: true }));
    }, limite);

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      if (encerrado) return;
      encerrado = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${rotulo} saiu com codigo ${code}. stderr:\n${stderr}`));
        return;
      }
      const linha = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(prefixo));
      if (!linha) {
        reject(new Error(`${rotulo} nao imprimiu ${prefixo}. stdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(linha.slice(prefixo.length)));
      } catch (e) {
        reject(new Error(`${rotulo} imprimiu resultado invalido: ${e.message}`));
      }
    });
  });
}

/**
 * Sobe o renderer, com uma repetição só quando a tentativa esgota o tempo.
 * Uma saída com codigo diferente de zero é erro de verdade e não é repetida.
 */
async function rodar(runnerPath, rotulo = 'renderer') {
  const caminho = path.isAbsolute(runnerPath) ? runnerPath : path.join(ROOT, runnerPath);
  try {
    return await umaTentativa(caminho, PRIMEIRA_TENTATIVA_MS, rotulo);
  } catch (e) {
    if (!e.timeout) throw e;
    // Repetir depois de um timeout: a segunda execução é o Electron já
    // quente, e o teste distingue "demorou" de "travou".
    return umaTentativa(caminho, SEGUNDA_TENTATIVA_MS, rotulo);
  }
}

module.exports = { rodar, ELECTRON, ROOT, PRIMEIRA_TENTATIVA_MS, SEGUNDA_TENTATIVA_MS };
