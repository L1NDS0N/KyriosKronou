// tests/test-web-panel.js
//
// A parte do painel que roda no navegador não tem como ser exercitada aqui sem
// um DOM, mas o que mais quebra nela é ligação: um botão que chama uma rota que
// não existe, uma rota que ninguém usa, um elemento que o script procura por id
// e o HTML não tem. Isso dá para conferir sem navegador, e é o que estes testes
// fazem.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'src', 'web');
const appJs = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'style.css'), 'utf8');
const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'apiServer.js'), 'utf8');

/** Rotas declaradas no servidor, como { verbo, caminho }. */
function rotasDoServidor() {
  return [...apiSrc.matchAll(/this\.app\.(get|post|put|patch|delete)\('([^']+)'/g)]
    .map((m) => ({ verbo: m[1].toUpperCase(), caminho: m[2] }));
}

/** Caminhos de /api que o painel chama, já sem query string nem concatenação. */
function chamadasDoPainel() {
  return [...new Set([...appJs.matchAll(/api\(\s*'(\/api\/[^']*)'/g)].map((m) => m[1].split('?')[0]))];
}

describe('Painel web: ligação com o servidor', () => {
  const rotas = rotasDoServidor();

  // Uma chamada para uma rota que não existe só aparece quando o usuário clica.
  it('toda chamada do painel tem uma rota no servidor', () => {
    for (const chamada of chamadasDoPainel()) {
      const casa = rotas.some((r) => {
        if (r.caminho === chamada) return true;
        // '/api/tasks/' + id casa com /api/tasks/:id
        const semParam = r.caminho.replace(/\/:[^/]+/g, '/').replace(/\/+$/, '');
        return semParam === chamada.replace(/\/+$/, '');
      });
      expect(casa, `o painel chama ${chamada}, que o servidor não atende`).to.equal(true);
    }
  });

  it('o painel cobre as ações que o desktop tem', () => {
    const esperadas = [
      'POST /api/tasks', 'PUT /api/tasks/:id', 'DELETE /api/tasks/:id', 'POST /api/tasks/:id/run',
      'POST /api/backups', 'PUT /api/backups/:id', 'DELETE /api/backups/:id', 'POST /api/backups/:id/run',
      'POST /api/services/:name/:action', 'DELETE /api/services/:name',
      'GET /api/scripts', 'POST /api/scripts', 'DELETE /api/scripts/:name',
      'GET /api/runs', 'POST /api/schedule/conflicts',
    ];
    const existentes = rotas.map((r) => r.verbo + ' ' + r.caminho);
    for (const rota of esperadas) {
      expect(existentes, `falta a rota ${rota}`).to.include(rota);
    }
  });
});

describe('Painel web: elementos que o script procura', () => {
  // $('id') com id que não existe devolve null, e a primeira propriedade lida
  // dele derruba a tela inteira.
  it('todo id usado em $() existe no HTML, ou é criado pelo próprio script', () => {
    const ids = [...new Set([...appJs.matchAll(/\$\('([a-z0-9-]+)'\)/gi)].map((m) => m[1]))];
    for (const id of ids) {
      const noHtml = indexHtml.includes('id="' + id + '"');
      // Os criados dentro de um modal aparecem no próprio app.js.
      const criado = appJs.includes('id="' + id + '"');
      expect(noHtml || criado, `$('${id}') não existe em lugar nenhum`).to.equal(true);
    }
  });

  it('as telas novas estão no menu e no corpo', () => {
    for (const page of ['services', 'scripts']) {
      expect(indexHtml, `falta o item de menu de ${page}`).to.include('data-page="' + page + '"');
      expect(indexHtml, `falta a seção de ${page}`).to.include('id="page-' + page + '"');
      expect(appJs, `nada carrega a tela de ${page}`).to.include(page + ': load');
    }
  });
});

describe('Painel web: rodapé sempre ativo', () => {
  it('o rodapé existe e é fixo', () => {
    expect(indexHtml).to.include('class="footbar"');
    expect(css).to.match(/\.footbar\s*\{[^}]*position:\s*fixed/);
  });

  it('mostra as métricas da máquina fora da tela de monitor', () => {
    for (const id of ['foot-cpu', 'foot-mem', 'foot-disk', 'foot-net']) {
      expect(indexHtml).to.include('id="' + id + '"');
    }
    expect(appJs).to.include('renderFooterMetrics');
  });

  it('mostra o que está em execução e deixa acompanhar uma de cada vez', () => {
    expect(indexHtml).to.include('id="footer-runs"');
    expect(appJs).to.include('pollRuns');
    // Uma execução por vez foi pedido explícito: nunca todas simultaneamente.
    expect(appJs).to.match(/let watching = null/);
    expect(appJs).to.include("watching = { runId");
  });

  // Sem a folga o rodapé fixo cobre a última linha de toda tabela.
  it('o conteúdo não fica por baixo do rodapé', () => {
    expect(css).to.match(/\.main\s*\{[^}]*padding-bottom/);
  });
});

describe('Painel web: envio de scripts', () => {
  it('tem área de arrastar e soltar ligada ao seletor de arquivo', () => {
    expect(indexHtml).to.include('id="drop-zone"');
    expect(indexHtml).to.include('id="script-file"');
    expect(appJs).to.include("addEventListener('drop'");
    expect(appJs).to.include('uploadScript');
  });

  it('manda o conteúdo em base64, como a rota espera', () => {
    expect(appJs).to.include('readAsDataURL');
    expect(appJs).to.include('contentBase64');
  });

  it('pergunta antes de substituir um script existente', () => {
    expect(appJs).to.include('overwrite');
    expect(appJs).to.match(/already exists/i);
  });
});

describe('Painel web: marca', () => {
  it('tem favicon e a logo ao fundo', () => {
    expect(indexHtml).to.include('rel="icon"');
    expect(indexHtml).to.include('/assets/logo-24.png');
    expect(indexHtml).to.include('class="bg-logo"');
    expect(css).to.include("url('/assets/bg.png')");
  });

  // A lista é fechada de propósito: servir "o que o nome pedir" a partir de uma
  // pasta é ler arquivo arbitrário do disco.
  it('o servidor entrega essas imagens, e só essas', () => {
    expect(apiSrc).to.include('_brandAssets');
    expect(apiSrc).to.include("'/favicon.ico'");
    expect(apiSrc).to.include("'/assets/bg.png'");
  });
});

describe('Painel web: o serviço é quem hospeda', () => {
  const svc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'serviceScheduler.js'), 'utf8');

  // No servidor ninguém está logado: um painel que só rodasse dentro da GUI
  // estaria fora do ar exatamente quando é mais necessário.
  it('o serviço constrói o ApiServer com tudo que o painel usa', () => {
    expect(svc).to.include('new ApiServer(');
    expect(svc, 'sem serviceManager a tela de serviços fica morta').to.include('new ServiceManager');
    expect(svc, 'sem runRegistry o rodapé nunca mostra execução').to.include('new RunRegistry');
    expect(svc).to.include('runRegistry: runs');
    expect(svc).to.not.match(/new ApiServer\([^)]*null, null/);
  });

  it('nada do que o serviço carrega importa electron', () => {
    for (const arquivo of ['apiServer.js', 'webSecurity.js', 'webAuth.js', 'serviceManager.js', 'wrapperGenerator.js', 'runRegistry.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', arquivo), 'utf8');
      const importa = /require\('electron'\)/.test(src.replace(/\/\/.*$/gm, ''));
      expect(importa, `${arquivo} importa electron e o serviço não conseguiria carregá-lo`).to.equal(false);
    }
  });
});
