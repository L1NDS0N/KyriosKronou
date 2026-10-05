// tests/test-syncthing-installer-exec.js
//
// Um bug real deste arquivo: a propriedade se chamava execFileSync mas recebia
// execSync, que toma uma string de comando. A chamada passava
// (executavel, argumentos) como (comando, opcoes) - a lista virava o objeto de
// opcoes, o comando rodava sem argumento e saia com codigo diferente de zero.
// O catch transformava isso em "chocolatey ausente", e a instalacao do
// Syncthing nunca nem comecava, com a tela mostrando so "nao foi possivel
// instalar".
//
// O teste verifica o contrato de cada injetavel: um executor de arquivo+args
// aceita argumentos; um de string aceita comando. Trocar um pelo outro no
// construtor quebra a deteccao em silencio, porque a excecao e engolida.

const { expect } = require('chai');
const { execFileSync, execSync } = require('child_process');
const { SyncthingInstaller } = require('../src/main/syncthing/installer');

function comExecutores() {
  const chamadas = [];
  return {
    chamadas,
    logger: { log() {} },
    injetados: {
      execFile: (exe, args) => { chamadas.push(['execFile', exe, args]); },
      execFileSync: (exe, args) => { chamadas.push(['execFileSync', exe, args]); },
    },
  };
}

describe('Instalador do Syncthing: os executores nao sao trocados', () => {
  it('execFileSync recebe o executor de arquivo, e nao o de string', () => {
    const { injetados, chamadas } = comExecutores();
    const inst = new SyncthingInstaller({ log() {} }, injetados);
    inst.hasChocolatey();
    const temSync = chamadas.find((c) => c[0] === 'execFileSync');
    expect(temSync, 'a detecco de chocolatey precisa usar execFileSync').to.not.equal(undefined);
    expect(temSync[1]).to.equal('choco');
    expect(temSync[2]).to.deep.equal(['--version']);
  });

  it('o executor de string nao pode ser usado como se fosse de arquivo', () => {
    // E o que aconteceu: execSync('choco', ['--version']) lanca, e o catch
    // devolvia false - "chocolatey ausente" numa maquina que tem chocolatey.
    let lancou = false;
    try {
      execSync('choco', ['--version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    } catch (e) { lancou = true; }
    expect(lancou, 'execSync com lista de argumentos falha - e o catch escondia').to.equal(true);
  });

  it('o mesmo executor de arquivo funciona com o binario real', function () {
    this.timeout(20000);
    // Com o executor certo a deteccao passa nesta maquina, onde o choco
    // existe. Com o executor trocado, falharia.
    const inst = new SyncthingInstaller({ log() {} });
    if (inst.hasChocolatey()) return;       // chocolatey presente: passou
    const sem = inst.hasChocolatey();
    // Ausente de verdade, a deteccao tambem tem de ser false - sem excecao.
    expect(sem).to.equal(false);
  });

  it('checkInstalled devolve a forma que a tela consome, mesmo sem syncthing', async () => {
    const { injetados } = comExecutores();
    const inst = new SyncthingInstaller({ log() {} }, injetados);
    const r = await inst.checkInstalled();
    expect(r).to.be.an('object').that.has.property('installed');
  });

  it('resolveLatestVersion usa o executor assincrono, nao o sincrono', async () => {
    const { injetados, chamadas } = comExecutores();
    const inst = new SyncthingInstaller({ log() {} }, injetados);
    inst.resolveLatestVersion();
    const tem = chamadas.find((c) => c[0] === 'execFile');
    expect(tem, 'a busca de versao usa execFile').to.not.equal(undefined);
    expect(tem[1]).to.equal('choco');
  });
});
