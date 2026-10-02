// tests/test-link-policy.js
//
// Links externos abriam dentro do app. Isso não era só um incômodo: a página
// abria numa BrowserWindow nova carregando o mesmo preload, ou seja, recebia
// window.api - a ponte IPC inteira. Um link escrito na descrição de uma tarefa
// (o rich text aceita http, https e mailto digitados pela pessoa) dava a uma
// página de terceiros o mesmo poder que a tela do agendador.
//
// A correção é no main e vale para todos os links, inclusive os que o app monta
// em runtime - por isso o teste é sobre a política e não sobre as âncoras.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const linkPolicy = require('../src/main/linkPolicy');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// webContents de mentira: registra o handler e os listeners.
function webContentsFalso(urlAtual = 'file:///C:/app/src/renderer/index.html') {
  const wc = new EventEmitter();
  wc._openHandler = null;
  wc._url = urlAtual;
  wc.getURL = () => wc._url;
  wc.setWindowOpenHandler = (fn) => { wc._openHandler = fn; };
  return wc;
}

describe('Politica de link: o que pode sair para o sistema', () => {
  it('aceita http e https, que e o caso normal', () => {
    expect(linkPolicy.classificar('https://github.com/L1NDS0N').ok).to.equal(true);
    expect(linkPolicy.classificar('http://localhost:7600/docs').ok).to.equal(true);
  });

  it('aceita mailto e tel, que vao para o programa padrao do sistema', () => {
    expect(linkPolicy.classificar('mailto:alguem@exemplo.com').ok).to.equal(true);
    expect(linkPolicy.classificar('tel:+551199999999').ok).to.equal(true);
  });

  // O Electron avisa na propria documentacao: shell.openExternal entrega a
  // string ao sistema operacional. Sem esquema, "C:\...\calc.exe" abre um
  // programa; file:// abriria um documento com a ponte IPC dentro do app.
  it('recusa file:, que abriria um arquivo local dentro do app', () => {
    const r = linkPolicy.classificar('file:///C:/Windows/System32/calc.exe');
    expect(r.ok).to.equal(false);
    expect(r.reason).to.equal('linkPolicy.schemeNotAllowed');
  });

  it('recusa data:, que carrega documento com script', () => {
    expect(linkPolicy.classificar('data:text/html,<script>alert(1)</script>').ok).to.equal(false);
  });

  it('recusa javascript: e vbscript:', () => {
    for (const url of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'JavaScript:alert(1)']) {
      expect(linkPolicy.classificar(url).ok, url).to.equal(false);
    }
  });

  it('recusa um caminho de executavel, que o SO abriria', () => {
    // O ataque clássico: um href sem esquema vira caminho para o sistema.
    // "C:\..." tem uma letra de esquema, que é o que o Node lê, e é barrado pelo
    // filtro de caminho local; um nome solto nem chega a ser URL.
    const comLetra = linkPolicy.classificar('C:\\Windows\\System32\\calc.exe');
    expect(comLetra.ok).to.equal(false);
    expect(comLetra.reason).to.equal('linkPolicy.localPath');

    for (const url of ['..\\..\\evil.exe', 'calc.exe', '\\\\servidor\\share']) {
      expect(linkPolicy.classificar(url).ok, url).to.equal(false);
    }
  });

  it('recusa um protocolo relativo // que escaparia do filtro', () => {
    // "//evil.com" é relativo para o parser e absoluto para o navegador: sem
    // checar o esquema ele passaria e ainda abriria um site remoto.
    expect(linkPolicy.classificar('//evil.com/x').ok).to.equal(false);
    expect(linkPolicy.classificar('\\\\evil.com\\x').ok).to.equal(false);
  });

  it('recusa http sem host', () => {
    expect(linkPolicy.classificar('http://').ok).to.equal(false);
  });

  it('recusa o que nao e texto, e o vazio', () => {
    expect(linkPolicy.classificar(null).ok).to.equal(false);
    expect(linkPolicy.classificar(undefined).ok).to.equal(false);
    expect(linkPolicy.classificar(42).ok).to.equal(false);
    expect(linkPolicy.classificar('   ').ok).to.equal(false);
  });

  it('nao deixa lixo em volta da URL passar', () => {
    // Espaco no fim é comum de copiar e colar, e um espaco interno quebraria o
    // parser num caminho diferente do que a pessoa pensou.
    expect(linkPolicy.classificar('  https://github.com  ').ok).to.equal(true);
  });
});

describe('Politica de link: navegacao interna vs externa', () => {
  const pagina = 'file:///C:/app/src/renderer/index.html';

  it('o proprio arquivo do renderer e interno', () => {
    expect(linkPolicy.ehInterno(pagina, pagina)).to.equal(true);
    expect(linkPolicy.ehInterno('file:///C:/app/src/renderer/index.html#ancora', pagina)).to.equal(true);
  });

  it('qualquer outra coisa sai do app', () => {
    expect(linkPolicy.ehInterno('https://github.com', pagina)).to.equal(false);
    // Um .html vizinho dentro do projeto não é o app.
    expect(linkPolicy.ehInterno('file:///C:/app/src/renderer/outro.html', pagina)).to.equal(false);
    expect(linkPolicy.ehInterno('file:///C:/outro/index.html', pagina)).to.equal(false);
  });

  it('sem a pagina do app definida, nada e considerado interno', () => {
    // Sem referência não há como comparar, e liberar tudo seria o pior
    // resultado possível.
    expect(linkPolicy.ehInterno('file:///C:/app/src/renderer/index.html', null)).to.equal(false);
  });
});

describe('Politica de link: abrir no navegador', () => {
  it('chama o sistema e devolve a url normalizada', async () => {
    const abertas = [];
    const r = await linkPolicy.abrirExternamente('https://github.com/L1NDS0N', {
      openExternal: async (u) => { abertas.push(u); },
    });
    expect(r.ok).to.equal(true);
    expect(abertas).to.deep.equal(['https://github.com/L1NDS0N']);
  });

  it('nao chama o sistema quando o esquema e recusado', async () => {
    let chamado = false;
    const r = await linkPolicy.abrirExternamente('file:///C:/x.exe', {
      openExternal: async () => { chamado = true; },
    });
    expect(r.ok).to.equal(false);
    expect(chamado, 'nada pode ser entregue ao shell').to.equal(false);
  });

  it('devolve o motivo da recusa, para o log poder explicar', () => {
    // Um link recusado em silêncio vira um clique que nao faz nada, e a
    // pessoa conclui que o botao esta quebrado.
    const r = linkPolicy.classificar('javascript:alert(1)');
    expect(r).to.have.property('reason').that.is.a('string');
  });
});

describe('Politica de link: aplicada na janela', () => {
  it('bloqueia a nova janela E abre no sistema', async () => {
    // As duas metades importam: sem deny, o Electron abre a página dentro do
    // app com o preload; sem openExternal, o clique não faz nada.
    const wc = webContentsFalso();
    const abertas = [];
    linkPolicy.aplicarEm(wc, { paginaDoApp: 'file:///C:/app/index.html', openExternal: async (u) => { abertas.push(u); } });

    const r = wc._openHandler({ url: 'https://github.com' });
    expect(r).to.deep.equal({ action: 'deny' });
    await new Promise((s) => setImmediate(s));
    expect(abertas).to.deep.equal(['https://github.com/']); // URL normalizado
  });

  it('a janela nova nunca herda o preload, porque ela nunca e criada', () => {
    const wc = webContentsFalso();
    linkPolicy.aplicarEm(wc, { openExternal: async () => {} });
    // deny e o que impede a criacao; um handler que devolvesse "allow"
    // devolveria a pagina ao Electron com o preload do app.
    expect(wc._openHandler({ url: 'https://exemplo.com' }).action).to.equal('deny');
  });

  it('bloqueia tambem a navegacao sem target_blank', async () => {
    // will-navigate cobre o caminho de um <a> sem target ou de um
    // location.assign, que nunca passa pelo windowOpenHandler.
    const wc = webContentsFalso();
    const abertas = [];
    linkPolicy.aplicarEm(wc, { paginaDoApp: 'file:///C:/app/index.html', openExternal: async (u) => { abertas.push(u); } });

    let impedido = false;
    wc.emit('will-navigate', { preventDefault: () => { impedido = true; } }, 'https://evil.test');
    expect(impedido, 'a navegacao para fora tem de ser cancelada').to.equal(true);
    await new Promise((s) => setImmediate(s));
    expect(abertas).to.deep.equal(['https://evil.test/']);
  });

  it('deixa a navegacao interna passar', () => {
    const wc = webContentsFalso();
    linkPolicy.aplicarEm(wc, { paginaDoApp: 'file:///C:/app/index.html', openExternal: async () => {} });

    let impedido = false;
    wc.emit('will-navigate', { preventDefault: () => { impedido = true; } }, 'file:///C:/app/index.html');
    expect(impedido).to.equal(false);
  });

  it('cobre o redirect, que nao passa por will-navigate', async () => {
    // Um meta refresh ou um 302 de servidor troca a pagina sem clicar em nada.
    const wc = webContentsFalso();
    const abertas = [];
    linkPolicy.aplicarEm(wc, { paginaDoApp: 'file:///C:/app/index.html', openExternal: async (u) => { abertas.push(u); } });

    let impedido = false;
    wc.emit('will-redirect', { preventDefault: () => { impedido = true; } }, 'https://phishing.test');
    expect(impedido).to.equal(true);
    await new Promise((s) => setImmediate(s));
    expect(abertas).to.deep.equal(['https://phishing.test/']);
  });

  it('avisa quando um link e recusado, em vez de falhar em silencio', async () => {
    const wc = webContentsFalso();
    const avisos = [];
    linkPolicy.aplicarEm(wc, {
      paginaDoApp: 'file:///C:/app/index.html',
      openExternal: async () => {},
      avisar: (motivo) => { avisos.push(motivo); },
    });

    wc._openHandler({ url: 'javascript:alert(1)' });
    await new Promise((s) => setImmediate(s));
    expect(avisos).to.have.lengthOf(1);
    expect(avisos[0]).to.equal('linkPolicy.schemeNotAllowed');
  });
});

describe('Politica de link: cobre todos os pontos de saida do app', () => {
  const main = read('src/main/main.js');

  it('a politica e aplicada na criacao da janela', () => {
    expect(main).to.include('linkPolicy.aplicarEm(mainWindow.webContents');
  });

  // Os nove pontos levantados na auditoria. Nenhum precisa de conserto
  // proprio: todos passam pela politica. O teste existe para que um link novo
  // criado sem pensar nao vire uma regressao silenciosa.
  it('todos os links externos passam pela politica, sem excecao', () => {
    const pontos = [
      ['src/renderer/app.js', /https:\/\/www\.buymeacoffee\.com/, 'doação'],
      ['src/renderer/app.js', /github\.com\/\$\{escAttr\(user\.login\)\}/, 'perfil do autor'],
      ['src/renderer/app.js', /github\.com\/L1NDS0N\/KyriosKronou\/releases/, 'releases'],
      ['src/renderer/app.js', /href="\$\{escAttr\(r\.html_url\)\}"/, 'repositórios'],
      ['src/renderer/networkPage.js', /verificationUri/, 'device flow'],
      ['src/renderer/simpleRichText.js', /setAttribute\('target',\s*'_blank'\)/, 'links da descrição'],
      ['src/renderer/simpleRichText.js', /setAttribute\('rel',\s*'noopener noreferrer'\)/, 'proteção do rich text'],
    ];
    for (const [arquivo, padrao, oQue] of pontos) {
      const src = read(arquivo);
      expect(src, `${oQue} (${arquivo})`).to.match(padrao);
      // Nenhum deles pode trazer um onclick que abra dentro do app.
      expect(src, `${oQue} não pode abrir por conta própria`).to.not.match(/onclick="window\.open/);
    }
  });

  it('o painel web nao tem link externo de ancora', () => {
    // Ele roda no navegador da pessoa: window.open com noopener esta correto
    // ali e não deve ser "corrigido" para o caminho do Electron.
    const web = read('src/web/login.js');
    expect(web).to.include("window.open(info.verificationUri, '_blank', 'noopener')");
    const index = read('src/web/index.html');
    expect(index).to.not.match(/<a[^>]+href="https?:/);
  });

  it('o renderer nao chama window.open, que seria um caminho sem politica', () => {
    // window.open no renderer nao passa por setWindowOpenHandler em alguns
    // casos e abriria a pagina com o preload. Nao deve existir.
    for (const arquivo of ['src/renderer/app.js', 'src/renderer/networkPage.js',
      'src/renderer/simpleRichText.js', 'src/renderer/runMonitor.js']) {
      expect(read(arquivo), arquivo).to.not.match(/window\.open\s*\(/);
    }
  });

  it('o main nao usa shell.openExternal fora da politica', () => {
    // Se outro lugar abrir direto, a validacao de esquema fica contornavel.
    const semPolitica = main.split("require('./linkPolicy')")[1] || '';
    const foraDaPolitica = (semPolitica.match(/shell\.openExternal/g) || []).length;
    expect(foraDaPolitica, 'abrir direto fora da politica').to.equal(0);
  });
});
