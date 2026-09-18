// tests/test-web-security.js
//
// O painel web executa scripts arbitrários e mexe em serviços do Windows. O
// requisito do usuário é explícito: nenhuma invasão a partir dele. Estes testes
// fixam as defesas uma a uma - cada uma delas é o tipo de coisa que some numa
// refatoração sem que nada pareça quebrado.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const security = require('../src/main/webSecurity');

describe('Segurança web: comparação de segredos', () => {
  it('reconhece segredos iguais e recusa os diferentes', () => {
    expect(security.safeEqual('abc123', 'abc123')).to.equal(true);
    expect(security.safeEqual('abc123', 'abc124')).to.equal(false);
  });

  // Comparar com === sai no primeiro byte diferente, e o tempo entrega o prefixo.
  it('compara tamanhos diferentes sem estourar', () => {
    expect(security.safeEqual('curto', 'um segredo bem mais longo')).to.equal(false);
    expect(security.safeEqual('', 'x')).to.equal(false);
  });

  it('trata ausência de valor como não conferindo', () => {
    expect(security.safeEqual(undefined, 'x')).to.equal(false);
    expect(security.safeEqual(null, null)).to.equal(true);
  });
});

describe('Segurança web: CSRF', () => {
  const secret = 'segredo-de-teste';

  it('aceita o token da própria sessão', () => {
    const token = security.csrfToken(secret, 'sessao-1');
    expect(security.csrfValid(secret, 'sessao-1', token)).to.equal(true);
  });

  // O ponto todo: o token de uma sessão não vale noutra.
  it('recusa o token de outra sessão', () => {
    const token = security.csrfToken(secret, 'sessao-1');
    expect(security.csrfValid(secret, 'sessao-2', token)).to.equal(false);
  });

  it('recusa token ausente, vazio ou inventado', () => {
    expect(security.csrfValid(secret, 'sessao-1', undefined)).to.equal(false);
    expect(security.csrfValid(secret, 'sessao-1', '')).to.equal(false);
    expect(security.csrfValid(secret, 'sessao-1', 'a'.repeat(64))).to.equal(false);
  });

  it('não é derivável sem o segredo do servidor', () => {
    const token = security.csrfToken(secret, 'sessao-1');
    expect(security.csrfValid('outro-segredo', 'sessao-1', token)).to.equal(false);
  });
});

describe('Segurança web: origem da requisição', () => {
  const req = (headers) => ({ headers });

  it('aceita a própria origem', () => {
    expect(security.sameOrigin(req({ host: 'servidor:7600', origin: 'http://servidor:7600' }))).to.equal(true);
  });

  it('recusa outra origem', () => {
    expect(security.sameOrigin(req({ host: 'servidor:7600', origin: 'http://malicioso.example' }))).to.equal(false);
  });

  // Porta diferente é outra origem: é por onde passaria um serviço vizinho.
  it('trata porta diferente como outra origem', () => {
    expect(security.sameOrigin(req({ host: 'servidor:7600', origin: 'http://servidor:8080' }))).to.equal(false);
  });

  it('cai no Referer quando não há Origin', () => {
    expect(security.sameOrigin(req({ host: 'servidor:7600', referer: 'http://servidor:7600/tasks' }))).to.equal(true);
    expect(security.sameOrigin(req({ host: 'servidor:7600', referer: 'http://malicioso.example/x' }))).to.equal(false);
  });

  // Sem nenhum dos dois não dá para concluir - quem chama decide, e o servidor
  // ainda exige o token CSRF.
  it('responde indeterminado quando não há origem nenhuma', () => {
    expect(security.sameOrigin(req({ host: 'servidor:7600' }))).to.equal(null);
  });

  it('recusa uma origem que nem é uma URL', () => {
    expect(security.sameOrigin(req({ host: 'servidor:7600', origin: 'nao-e-url' }))).to.equal(false);
  });
});

describe('Segurança web: limitador', () => {
  it('libera até o teto e barra depois', () => {
    const lim = new security.RateLimiter(3, 60000);
    const agora = 1000;
    expect(lim.check('1.2.3.4', agora).ok).to.equal(true);
    expect(lim.check('1.2.3.4', agora).ok).to.equal(true);
    expect(lim.check('1.2.3.4', agora).ok).to.equal(true);
    expect(lim.check('1.2.3.4', agora).ok).to.equal(false);
  });

  it('conta cada origem separadamente', () => {
    const lim = new security.RateLimiter(1, 60000);
    expect(lim.check('1.2.3.4', 1000).ok).to.equal(true);
    expect(lim.check('5.6.7.8', 1000).ok).to.equal(true);
  });

  it('libera de novo na janela seguinte', () => {
    const lim = new security.RateLimiter(1, 1000);
    expect(lim.check('1.2.3.4', 1000).ok).to.equal(true);
    expect(lim.check('1.2.3.4', 1500).ok).to.equal(false);
    expect(lim.check('1.2.3.4', 2600).ok).to.equal(true);
  });

  it('informa em quantos segundos tentar de novo', () => {
    const lim = new security.RateLimiter(1, 60000);
    lim.check('1.2.3.4', 1000);
    expect(lim.check('1.2.3.4', 1000).retryAfter).to.equal(60);
  });

  // Num servidor exposto a tabela cresceria uma entrada por IP, para sempre.
  it('não cresce sem limite', () => {
    const lim = new security.RateLimiter(1, 1000);
    for (let i = 0; i < 6000; i++) lim.check('ip-' + i, 1000);
    lim.check('gatilho', 999999);
    expect(lim.hits.size).to.be.below(6000);
  });
});

describe('Segurança web: caminhos', () => {
  const raiz = path.join('C:', 'dados', 'scripts');

  it('resolve um nome dentro da raiz', () => {
    expect(security.safeJoin(raiz, 'backup.ps1')).to.equal(path.resolve(raiz, 'backup.ps1'));
  });

  // Este é o ataque: o nome do arquivo vem do navegador.
  it('recusa sair da raiz', () => {
    expect(security.safeJoin(raiz, '../../Windows/System32/drivers/etc/hosts')).to.equal(null);
    expect(security.safeJoin(raiz, '..')).to.equal(null);
    expect(security.safeJoin(raiz, 'sub/../../fora.ps1')).to.equal(null);
  });

  it('recusa caminho absoluto, que ignoraria a raiz inteira', () => {
    expect(security.safeJoin(raiz, 'C:\\Windows\\System32\\cmd.exe')).to.equal(null);
    expect(security.safeJoin(raiz, '/etc/passwd')).to.equal(null);
  });

  it('recusa byte nulo, que trunca o caminho no sistema de arquivos', () => {
    expect(security.safeJoin(raiz, 'ok.ps1\u0000.txt')).to.equal(null);
  });

  it('aceita subpasta legítima', () => {
    expect(security.safeJoin(raiz, 'equipe/rotina.ps1')).to.equal(path.resolve(raiz, 'equipe', 'rotina.ps1'));
  });
});

describe('Segurança web: nome de arquivo enviado', () => {
  it('aceita os nomes esperados', () => {
    expect(security.safeFileName('rotina.ps1')).to.equal('rotina.ps1');
    expect(security.safeFileName('backup diário.bat')).to.equal('backup diário.bat');
  });

  it('descarta qualquer caminho embutido no nome', () => {
    expect(security.safeFileName('../../evil.ps1')).to.equal(null);
    expect(security.safeFileName('C:\\evil.ps1')).to.equal(null);
  });

  // Um .exe enviado pelo painel seria executado pelo agendador depois.
  it('recusa extensão fora da lista', () => {
    expect(security.safeFileName('malware.exe')).to.equal(null);
    expect(security.safeFileName('lib.dll')).to.equal(null);
    expect(security.safeFileName('semextensao')).to.equal(null);
  });

  // Gravar em CON ou LPT1 no Windows escreve num dispositivo, não num arquivo.
  it('recusa os nomes reservados do Windows', () => {
    expect(security.safeFileName('CON.ps1')).to.equal(null);
    expect(security.safeFileName('lpt1.bat')).to.equal(null);
  });

  it('recusa nome absurdamente longo', () => {
    expect(security.safeFileName('a'.repeat(200) + '.ps1')).to.equal(null);
  });
});

describe('Segurança web: cabeçalhos', () => {
  function aplicar(reqPath, options) {
    const enviados = {};
    const res = {
      setHeader: (k, v) => { enviados[k] = v; },
      removeHeader: (k) => { delete enviados[k]; },
      locals: {},
    };
    security.securityHeaders(options || {})({ path: reqPath, headers: {} }, res, () => {});
    return enviados;
  }

  it('bloqueia script inline, que é o que transforma injeção de HTML em invasão', () => {
    const csp = aplicar('/')['Content-Security-Policy'];
    expect(csp).to.include("script-src 'self'");
    expect(csp).to.not.include("'unsafe-inline' 'self'");
    expect(csp.split('script-src')[1].split(';')[0]).to.not.include('unsafe-inline');
    expect(csp.split('script-src')[1].split(';')[0]).to.not.include('unsafe-eval');
  });

  it('impede que o painel seja embutido em outro site', () => {
    const h = aplicar('/');
    expect(h['Content-Security-Policy']).to.include("frame-ancestors 'none'");
    expect(h['X-Frame-Options']).to.equal('DENY');
  });

  it('impede que os dados saiam para outro servidor', () => {
    expect(aplicar('/')['Content-Security-Policy']).to.include("connect-src 'self'");
  });

  it('não vaza a URL do painel para terceiros', () => {
    expect(aplicar('/')['Referrer-Policy']).to.equal('no-referrer');
  });

  it('não deixa resposta de API em cache', () => {
    expect(aplicar('/api/tasks')['Cache-Control']).to.equal('no-store');
  });

  it('só manda HSTS quando existe TLS', () => {
    expect(aplicar('/', { https: false })['Strict-Transport-Security']).to.equal(undefined);
    expect(aplicar('/', { https: true })['Strict-Transport-Security']).to.include('max-age=');
  });
});

describe('Segurança web: como o servidor usa tudo isso', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'apiServer.js'), 'utf8');
  const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'webAuth.js'), 'utf8');

  it('exige CSRF em toda escrita de quem entrou por cookie', () => {
    expect(src).to.include('security.csrfValid');
    expect(src).to.include('SAFE_METHODS.has(req.method)');
  });

  it('checa a origem das escritas', () => {
    expect(src).to.include('security.sameOrigin');
  });

  it('limita requisições por IP, com teto menor no login', () => {
    expect(src).to.include('authLimiter');
    expect(src).to.include('apiLimiter');
    expect(src).to.include('429');
  });

  it('compara a chave de API em tempo constante', () => {
    expect(src).to.include("security.safeEqual(req.headers['x-api-key']");
    expect(src, 'comparar com === entrega a chave byte a byte').to.not.include("req.headers['x-api-key'] === this.apiKey");
  });

  // Com trust proxy ligado sem proxy, quem chama escolhe o próprio req.ip via
  // X-Forwarded-For e escapa do limitador.
  it('só confia em proxy quando está configurado', () => {
    expect(src).to.include("this.app.set('trust proxy', !!this.config.getSetting('WebTrustProxy'");
  });

  it('não anuncia o servidor', () => {
    expect(src).to.include("disable('x-powered-by')");
  });

  it('o cookie de sessão não acompanha requisição vinda de fora', () => {
    expect(auth).to.include('SameSite=Strict');
    expect(auth).to.not.include('SameSite=Lax');
    expect(auth).to.include('HttpOnly');
  });

  it('o painel não tem script inline para a CSP bloquear', () => {
    const web = path.join(__dirname, '..', 'src', 'web');
    for (const arquivo of ['index.html', 'login.html']) {
      const html = fs.readFileSync(path.join(web, arquivo), 'utf8');
      expect(/<script(?![^>]*\ssrc=)/.test(html), `${arquivo} ainda tem script inline`).to.equal(false);
    }
  });
});
