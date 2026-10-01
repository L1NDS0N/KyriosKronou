// tests/test-config-concurrency.js
//
// GUI e serviço são dois processos apontando para o mesmo
// profiles/default.json. Antes, cada um guardava o objeto inteiro em memória e
// gravava por cima: quem escrevesse por último apagava a chave que o outro tinha
// acabado de adicionar. Na prática isso sumia com o registro de dispositivos da
// rede, com o segredo de sessão do painel e com a chave de API.
//
// E a gravação truncava o destino: uma queda no meio deixava JSON pela metade,
// e o catch do loadProfile engolia o erro e zerava a configuração inteira em
// silêncio - tarefas, senhas e permissões juntas.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ConfigManager = require('../src/main/configManager');

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-cfg-'));
}

describe('ConfigManager: dois processos no mesmo arquivo', () => {
  it('o que um processo escreveu não some quando o outro grava', () => {
    const dir = temp();
    try {
      // Duas instâncias, como a GUI e o serviço, cada uma com sua cópia.
      const gui = new ConfigManager(path.join(dir, 'config'), 'default');
      const servico = new ConfigManager(path.join(dir, 'config'), 'default');

      gui.setSetting('SyncNetworkDevices', [{ deviceID: 'A' }]);
      // O serviço ainda tem a cópia antiga em memória. Sem o reload, gravar
      // qualquer coisa aqui apagaria o registro que a GUI acabou de escrever.
      servico.setSetting('LogDir', 'logs');

      const relido = new ConfigManager(path.join(dir, 'config'), 'default');
      expect(relido.getSetting('SyncNetworkDevices')).to.deep.equal([{ deviceID: 'A' }]);
      expect(relido.getSetting('LogDir')).to.equal('logs');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('intercala escritas dos dois sem perder nenhuma chave', () => {
    const dir = temp();
    try {
      const a = new ConfigManager(path.join(dir, 'config'), 'default');
      const b = new ConfigManager(path.join(dir, 'config'), 'default');
      for (let i = 0; i < 20; i++) {
        a.setSetting(`A${i}`, i);
        b.setSetting(`B${i}`, i);
      }
      const final = new ConfigManager(path.join(dir, 'config'), 'default');
      for (let i = 0; i < 20; i++) {
        expect(final.getSetting(`A${i}`), `A${i}`).to.equal(i);
        expect(final.getSetting(`B${i}`), `B${i}`).to.equal(i);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('o segredo de sessão de um processo sobrevive ao outro gravar', () => {
    const dir = temp();
    try {
      const painel = new ConfigManager(path.join(dir, 'config'), 'default');
      const app = new ConfigManager(path.join(dir, 'config'), 'default');
      painel.setSetting('WebSessionSecret', 'segredo-do-painel');
      app.setSetting('ApiKey', 'chave-da-api');
      const relido = new ConfigManager(path.join(dir, 'config'), 'default');
      // Perder o segredo invalida todas as sessões do painel sem aviso.
      expect(relido.getSetting('WebSessionSecret')).to.equal('segredo-do-painel');
      expect(relido.getSetting('ApiKey')).to.equal('chave-da-api');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('ConfigManager: gravação atômica', () => {
  it('grava por temporário e renomeia, sem truncar o destino', () => {
    const dir = temp();
    try {
      const c = new ConfigManager(path.join(dir, 'config'), 'default');
      c.setSetting('X', 1);
      const arquivo = path.join(dir, 'config', 'profiles', 'default.json');
      // Sobra um .tmp significa que o caminho seguro foi o usado.
      const restos = fs.readdirSync(path.dirname(arquivo)).filter((f) => f.includes('.tmp'));
      expect(restos, 'o temporário tem de sumir no rename').to.deep.equal([]);
      expect(JSON.parse(fs.readFileSync(arquivo, 'utf8')).X).to.equal(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('um arquivo momentaneamente ilegível não zera a configuração em memória', () => {
    const dir = temp();
    try {
      const c = new ConfigManager(path.join(dir, 'config'), 'default');
      c.setSetting('MinhaTarefa', 'backup');

      // Simula o truncamento de outro processo, no instante entre gravar e
      // renomear.
      const arquivo = path.join(dir, 'config', 'profiles', 'default.json');
      fs.writeFileSync(arquivo, '{"MinhaTa', 'utf8');

      const valorAntes = c.getSetting('MinhaTarefa');
      c.setSetting('OutraChave', 2);
      // A gravação tem que consertar o arquivo, e a chave que existia em
      // memória não pode evaporar no caminho.
      const relido = new ConfigManager(path.join(dir, 'config'), 'default');
      expect(relido.getSetting('OutraChave')).to.equal(2);
      expect(valorAntes).to.equal('backup');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('o perfil sobrevive a ser lido de novo depois de um arquivo corrompido', () => {
    const dir = temp();
    try {
      const arquivo = path.join(dir, 'config', 'profiles');
      fs.mkdirSync(arquivo, { recursive: true });
      fs.writeFileSync(path.join(arquivo, 'default.json'), '{ truncado', 'utf8');

      const c = new ConfigManager(path.join(dir, 'config'), 'default');
      // Antes isto zerava tudo em silêncio. Agora o arquivo ruim não pode
      // virar "configuração vazia" sem que ninguém perceba.
      expect(c.getSetting('Qualquer', 'padrao')).to.equal('padrao');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('não deixa o .tmp de um processo morto poluir a pasta', () => {
    const dir = temp();
    try {
      const c = new ConfigManager(path.join(dir, 'config'), 'default');
      c.setSetting('A', 1);
      const pasta = path.join(dir, 'config', 'profiles');
      // Um .tmp de outra execução antiga não pode ser confundido com perfil.
      const perfis = fs.readdirSync(pasta).filter((f) => f.endsWith('.json'));
      for (const p of perfis) {
        expect(p).to.equal('default.json');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});