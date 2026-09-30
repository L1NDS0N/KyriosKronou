// tests/test-syncthing-ui.js
//
// A tela de rede carrega duas garantias que valem mais do que o layout.
//
//  1. O renderer não decide quem é o usuário. Se ele mandasse o próprio
//     githubId, um ipcRenderer adulterado autorizaria qualquer dispositivo
//     escrevendo um número no payload - exatamente o bypass que a autorização
//     por OAuth existe para fechar.
//  2. Device ID e caminho de pasta entram em handler inline e no teclado do
//     Windows. Sem escape, uma barra invertida vira \b (backspace) e o
//     separador some: era assim que um caminho exibido deixava de ser o
//     caminho real.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'networkPage.js'), 'utf8');

describe('Rede de sincronismo: tela', () => {
  it('nunca envia um ator escolhido pelo renderer', () => {
    expect(source).to.not.match(/authorizeSyncNetworkDevice\([^)]*actor/i);
    expect(source).to.not.match(/revokeSyncNetworkDevice\([^)]*actor/i);
  });

  it('monta a autorização a partir da identidade devolvida pelo main', () => {
    expect(source).to.include('githubId: user.id');
    expect(source).to.include('githubLogin: user.login');
  });

  it('escapa device ID e rótulo ao colocá-los em handler inline', () => {
    expect(source).to.include("networkPage.revoke('${escHandler(d.deviceID)}')");
    expect(source).to.include("networkPage.authorize('${escHandler(d.deviceID)}')");
    expect(source).to.include("networkPage.editFolder('${escHandler(f.id)}')");
  });

  it('não interpola device ID cru em nenhum onclick', () => {
    const raw = source.match(/onclick="[^"]*'\$\{(?!escHandler)[^}]*deviceID[^}]*\}[^"]*"/g);
    expect(raw || []).to.deep.equal([]);
  });

  it('desabilita o botão de liberar quando não há login verificado', () => {
    // O botão de liberar fica desabilitado sem login: mesmo que alguém force o
    // clique, o main recusa sem `syncNetworkActor`.
    expect(source).to.include("this.identity.loggedIn ? '' : 'disabled'");
  });
});

describe('Rede de sincronismo: main nao confia no renderer para identificar o ator', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');

  it('guarda o ator e recusa autorizar sem login', () => {
    expect(mainSource).to.include('let syncNetworkActor = null');
    expect(mainSource).to.include("if (!syncNetworkActor) return { ok: false, reason: 'network.loginRequired' }");
  });

  it('ignora qualquer ator vindo do payload do renderer', () => {
    const handler = mainSource.slice(mainSource.indexOf("'authorize-sync-network-device'"));
    const body = handler.slice(0, handler.indexOf('}));'));
    expect(body).to.not.match(/actor\s*[,)]\s*$/m);
    expect(body).to.include('syncNetwork.authorizeDevice(payload, syncNetworkActor)');
  });

  it('tira a identidade do id numérico devolvido pela API do GitHub', () => {
    expect(mainSource).to.include('const user = await desktopWebAuth.fetchGithubUser(result.token)');
    expect(mainSource).to.include('githubId: user.id');
  });
});
