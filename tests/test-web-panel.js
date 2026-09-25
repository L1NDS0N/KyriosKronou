// tests/test-web-panel.js
//
// A parte do painel que roda no navegador não tem como ser exercitada aqui sem
// um DOM, mas o que mais quebra nela é ligação: um botão que chama uma rota que
// não existe, uma rota que ninguém usa, um elemento que o script procura por id
// e o HTML não tem. Isso dá para conferir sem navegador, e é o que estes testes
// fazem.

const { expect } = require('chai');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ApiServer = require('../src/main/apiServer');
const BackupManager = require('../src/main/backupManager');
const ConfigManager = require('../src/main/configManager');
const CronParser = require('../src/main/cronParser');
const RetentionManager = require('../src/main/retentionManager');
const RunRegistry = require('../src/main/runRegistry');
const SyncManager = require('../src/main/sync/syncManager');
const TaskManager = require('../src/main/taskManager');
const WebPermissions = require('../src/main/webPermissions');
const security = require('../src/main/webSecurity');

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

/**
 * Todo caminho de /api citado no painel, mesmo o que está numa tabela de telas
 * e não numa chamada. Uma rota guardada como texto é chamada assim que alguém
 * clica na aba - que é tarde demais para descobrir que ela não existe.
 */
function caminhosDoPainel() {
  return [...new Set([...appJs.matchAll(/'(\/api\/[^']*)'/g)].map((m) => m[1].split('?')[0]))];
}

/** A tela de cada item de menu, pelo atributo que a navegação usa. */
function telasDoMenu() {
  return [...indexHtml.matchAll(/class="nav-item[^"]*" data-page="([^"]+)"/g)].map((m) => m[1]);
}

function temRota(rotas, chamada) {
  return rotas.some((r) => {
    if (r.caminho === chamada) return true;
    // '/api/tasks/' + id casa com /api/tasks/:id
    const semParam = r.caminho.replace(/\/:[^/]+/g, '/').replace(/\/+$/, '');
    return semParam === chamada.replace(/\/+$/, '');
  });
}

describe('Painel web: ligação com o servidor', () => {
  const rotas = rotasDoServidor();

  // Uma chamada para uma rota que não existe só aparece quando o usuário clica.
  it('toda chamada do painel tem uma rota no servidor', () => {
    for (const chamada of chamadasDoPainel()) {
      expect(temRota(rotas, chamada), `o painel chama ${chamada}, que o servidor não atende`).to.equal(true);
    }
  });

  it('todo caminho de /api citado no painel existe como rota', () => {
    for (const caminho of caminhosDoPainel()) {
      expect(temRota(rotas, caminho), `o painel cita ${caminho}, que o servidor não atende`).to.equal(true);
    }
  });

  it('o painel cobre as ações que o desktop tem', () => {
    const esperadas = [
      'POST /api/tasks', 'PUT /api/tasks/:id', 'DELETE /api/tasks/:id', 'POST /api/tasks/:id/run',
      'POST /api/backups', 'PUT /api/backups/:id', 'DELETE /api/backups/:id', 'POST /api/backups/:id/run',
      'POST /api/services/:name/:action', 'DELETE /api/services/:name',
      'GET /api/scripts', 'POST /api/scripts', 'DELETE /api/scripts/:name',
      'GET /api/runs', 'POST /api/schedule/conflicts',
      // As telas novas só podiam nascer de rotas que já existiam.
      'GET /api/calendar', 'GET /api/logs', 'GET /api/history', 'GET /api/backups/history',
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
    for (const page of ['dashboard', 'services', 'scripts', 'history', 'calendar', 'logs', 'sync', 'retention']) {
      expect(indexHtml, `falta o item de menu de ${page}`).to.include('data-page="' + page + '"');
      expect(indexHtml, `falta a seção de ${page}`).to.include('id="page-' + page + '"');
      expect(appJs, `nada carrega a tela de ${page}`).to.include(page + ': load');
    }
  });

  // Um item de menu sem carregador é uma tela morta; um carregador sem item é
  // uma tela que ninguém alcança. O monitor é a exceção declarada: ele abre uma
  // conexão SSE por painel, e recarregá-lo a cada clique abriria outra - o
  // rodapé é alimentado pela mesma amostra.
  it('toda tela do menu tem carregador, e todo carregador tem tela', () => {
    const bloco = /const loaders = \{([\s\S]*?)\};/.exec(appJs);
    expect(bloco, 'o mapa de carregadores sumiu').to.not.equal(null);
    const comLoader = [...bloco[1].matchAll(/(\w+):\s*load\w+/g)].map((m) => m[1]);
    for (const page of telasDoMenu()) {
      if (page === 'monitor') {
        expect(appJs, 'o monitor precisa ser ligado no boot').to.include('primeMonitor()');
        continue;
      }
      expect(comLoader, `a tela ${page} não tem carregador`).to.include(page);
    }
    for (const page of comLoader) {
      expect(telasDoMenu(), `o carregador ${page} não tem item de menu`).to.include(page);
      expect(indexHtml, `falta a seção de ${page}`).to.include('id="page-' + page + '"');
    }
  });
});

describe('Painel web: dashboard', () => {
  it('tem os quatro números, com os quatro cartões de estatística', () => {
    for (const id of ['stat-tasks', 'stat-tasks-sub', 'stat-backups', 'stat-backups-sub',
      'stat-next', 'stat-next-sub', 'stat-failures', 'stat-failures-sub']) {
      expect(indexHtml, `falta ${id} no dashboard`).to.include('id="' + id + '"');
      expect(appJs, `nada escreve em ${id}`).to.include("$('" + id + "')");
    }
  });

  // Cada número tem de vir de uma rota que existe, e não de um cálculo local.
  it('cada número vem de uma rota do servidor', () => {
    const bloco = /async function loadDashboard\(\) \{([\s\S]*?)\n  \}/.exec(appJs);
    expect(bloco, 'loadDashboard sumiu').to.not.equal(null);
    for (const rota of ['/api/tasks', '/api/backups', '/api/calendar', '/api/history', '/api/backups/history']) {
      expect(bloco[1], `o dashboard não lê ${rota}`).to.include(rota);
    }
  });

  // O lease com heartbeat não tem rota HTTP: o cartão diz de onde tirou a
  // conclusão, para ninguém ler inferência como fato.
  it('o cartão do agendador diz a origem da informação', () => {
    for (const id of ['own-role', 'own-detail', 'own-source', 'own-runs']) {
      expect(indexHtml, `falta ${id}`).to.include('id="' + id + '"');
    }
    expect(appJs, 'o cartão do agendador não diz a fonte').to.include('Fonte:');
    expect(appJs).to.include('/api/runs');
  });

  it('a atividade recente tem linhas com status, duração e detalhe', () => {
    expect(indexHtml).to.include('id="dash-activity"');
    expect(appJs, 'as linhas da atividade não tem botão de detalhe').to.include('data-activity=');
    expect(appJs).to.include('openDetail');
  });
});

describe('Painel web: histórico dedicado', () => {
  it('tem abas para tarefa e backup, e as duas rotas', () => {
    expect(indexHtml).to.include('id="history-tabs"');
    expect(indexHtml).to.include('data-hist="tasks"');
    expect(indexHtml).to.include('data-hist="backups"');
    expect(appJs, 'a aba de tarefa não lê /api/history').to.include('/api/history?limit=');
    expect(appJs, 'a aba de backup não lê /api/backups/history').to.include('/api/backups/history?limit=');
  });

  // O detalhe não pode inventar uma rota de histórico por item: sai da linha.
  it('o detalhe vem da linha carregada, sem rota nova', () => {
    expect(appJs).to.include('data-hdetail=');
    expect(appJs).to.include('historyRows');
    expect(appJs, 'o histórico chamaria uma rota de item que não existe')
      .to.not.match(/api\w*\(\s*'\/api\/history\//);
  });

  it('cada linha abre a tela do item que a produziu', () => {
    expect(appJs).to.include('flashRow');
    expect(appJs, 'as linhas do histórico não levam a lugar nenhum').to.include('data-goto=');
    // As tabelas precisam saber qual linha é, para o piscar funcionar.
    for (const alvo of ['tasks-body', 'backups-body']) {
      const linhas = appJs.split("$('" + alvo + "')")[1] || '';
      expect(linhas.slice(0, 4000), `${alvo} não marca data-row-id`).to.include('data-row-id=');
    }
  });
});

describe('Painel web: calendário', () => {
  it('consome /api/calendar com a janela da visão, em ISO', () => {
    expect(appJs).to.include("'/api/calendar?from='");
    expect(appJs).to.include("'&to='");
    expect(appJs).to.include('encodeURIComponent(from.toISOString())');
  });

  it('tem as três visões, e a escolha troca o desenho', () => {
    for (const view of ['month', 'week', 'agenda']) {
      expect(indexHtml, `falta a visão ${view}`).to.include('data-view="' + view + '"');
      expect(appJs, `nada desenha a visão ${view}`).to.include('cal' + view[0].toUpperCase() + view.slice(1));
    }
    expect(appJs).to.include('calShift');
  });

  it('mostra os totais que a rota devolve', () => {
    expect(indexHtml).to.include('id="cal-totals"');
    for (const campo of ['scheduled', 'executed', 'failed', 'sources']) {
      expect(appJs, `o calendário não mostra ${campo}`).to.include('totais.' + campo);
    }
  });

  // O calendarData responde "backup" no page; a tela do painel se chama "backups".
  it('traduz a página da ocorrência para uma tela que existe', () => {
    expect(appJs).to.include('paginaDe');
    const telas = new Set(telasDoMenu());
    const usadas = [...appJs.matchAll(/paginaDe\(o\) \? '(\w+)'/g)].map((m) => m[1]);
    for (const tela of usadas) expect(telas, `paginaDe aponta para ${tela}, que não é uma tela`).to.include(tela);
  });
});

describe('Painel web: logs', () => {
  it('lê /api/logs e filtra por nível sem chamar o servidor de novo', () => {
    expect(appJs).to.include('/api/logs?limit=');
    expect(indexHtml).to.include('id="logs-level"');
    expect(appJs, 'o filtro de nível não recarrega a página').to.include("addEventListener('change'");
  });

  it('as abas extras só existem quando a rota existe', () => {
    const bloco = /const LOG_SOURCES = \[([\s\S]*?)\n  \];/.exec(appJs);
    expect(bloco, 'a tabela de fontes de log sumiu').to.not.equal(null);
    const rotas = rotasDoServidor();
    for (const fonte of bloco[1].split('\n').filter((l) => l.includes("{ id:"))) {
      const id = /id: '(\w+)'/.exec(fonte)[1];
      const caminho = /path: (null|'[^']+')/.exec(fonte)[1];
      if (caminho === 'null') {
        // Sem rota, sem aba: chamar uma seria chamar algo que responde 404.
        expect(appJs, `a aba ${id} está ligada sem rota`).to.not.include(`path: '/api/${id}`);
        continue;
      }
      const limpo = caminho.replace(/'/g, '').split('?')[0];
      expect(temRota(rotas, limpo), `a aba ${id} aponta para ${limpo}, que o servidor não atende`).to.equal(true);
    }
  });
});

describe('Painel web: permissões vindas do /api/me', () => {
  it('lê o resumo de permissões e esconde o que a pessoa não pode usar', () => {
    expect(appJs, 'o painel ignora as permissões do /api/me').to.include('perms = me.permissions');
    expect(appJs, 'nada esconde menu por permissão').to.include('applyPermissions');
    expect(appJs).to.include('item.hidden = !ok');
  });

  it('toda tela do menu, menos o dashboard, é uma tela do catálogo de escopos', () => {
    for (const page of telasDoMenu()) {
      if (page === 'dashboard') continue;
      expect(WebPermissions.SCREENS, `${page} não existe no catálogo de escopos`).to.include(page);
    }
  });

  // O dashboard não é um escopo: ele é a soma de outros. Ele some para quem não
  // tem nenhum deles, não para quem tem um.
  it('o dashboard aparece para quem tem pelo menos uma das telas que ele resume', () => {
    const bloco = /const DASHBOARD_SCREENS = \[([^\]]*)\]/.exec(appJs);
    expect(bloco, 'a lista de telas do dashboard sumiu').to.not.equal(null);
    const telas = bloco[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
    expect(telas.length).to.be.above(0);
    for (const tela of telas) expect(WebPermissions.SCREENS, `${tela} não é uma tela do catálogo`).to.include(tela);
    expect(appJs, 'a soma do dashboard não é usada para decidir se ele aparece').to.include('DASHBOARD_SCREENS.some');
  });

  // Se a listamentionar uma tela que o dashboard não lê, quem só pode ler essa
  // tela enxerga um painel vazio. E o inverso também: um número sem permissão
  // seria pedido à rota para nada.
  it('a soma do dashboard é exatamente o que ele busca', () => {
    const lista = /const DASHBOARD_SCREENS = \[([^\]]*)\]/.exec(appJs)[1]
      .split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean).sort();
    const corpo = /async function loadDashboard\(\) \{([\s\S]*?)\n  \}/.exec(appJs)[1];
    const usadas = [...new Set([...corpo.matchAll(/can\('(\w+)'/g)].map((m) => m[1]))].sort();
    expect(lista, 'a lista de telas do dashboard não bate com o que ele busca').to.deep.equal(usadas);
  });

  // Esconder botão não é controle de acesso - quem recusa é a rota. Mas pedir
  // uma tela proibida é ruído garantido, e o carregador pode nem tentar.
  it('o carregador checa a permissão antes de pedir a rota', () => {
    expect(appJs).to.include('function loadPage(page)');
    expect(appJs).to.match(/function loadPage\(page\) \{[\s\S]{0,200}pageAllowed\(page\)/);
  });

  it('escrever é escopo separado de ler, e o painel trata como tal', () => {
    for (const acao of ['write', 'run', 'delete']) {
      expect(appJs, `nenhuma tela usa o escopo ${acao}`).to.include(`can('tasks', '${acao}')`);
    }
    expect(appJs).to.include("$('btn-new-task').hidden = !can('tasks', 'write')");
  });
});

describe('Painel web: telas de sincronismo e retenção', () => {
  /** As duas telas se desenham do mesmo jeito: resumo, tabela e modal em passos. */
  const TELAS = [
    { page: 'sync', sub: 'sync-sub', body: 'sync-body', novo: 'btn-new-sync', colunas: 6, prefixo: 'sync' },
    { page: 'retention', sub: 'retention-sub', body: 'retention-body', novo: 'btn-new-retention', colunas: 6, prefixo: 'ret' },
  ];

  it('cada tela tem menu, seção, carregador e botão de recarregar', () => {
    for (const t of TELAS) {
      expect(indexHtml, `${t.page}: sem item de menu`).to.include('data-page="' + t.page + '"');
      expect(indexHtml, `${t.page}: sem seção`).to.include('id="page-' + t.page + '"');
      expect(appJs, `${t.page}: sem carregador`).to.include(t.page + ': load');
      expect(indexHtml, `${t.page}: sem subtítulo`).to.include('id="' + t.sub + '"');
      expect(indexHtml, `${t.page}: sem corpo de tabela`).to.include('id="' + t.body + '"');
      expect(appJs, `${t.page}: nada escreve no subtítulo`).to.include("$('" + t.sub + "')");
      expect(indexHtml, `${t.page}: sem botão de recarregar`).to.include('btn-reload-' + t.page);
      expect(appJs, `${t.page}: o recarregar não está ligado`).to.include("$('btn-reload-" + t.page + "').addEventListener");
    }
  });

  // Resumo: os quatro números existem, e cada um é escrito pelo carregador.
  it('cada tela tem resumo, e o carregador escreve nos quatro cartões', () => {
    for (const t of TELAS) {
      const prefixo = t.page === 'sync' ? 'stat-sync' : 'stat-ret';
      for (const sufixo of ['total', 'active', 'fail']) {
        for (const parte of ['', '-sub']) {
          const id = prefixo + '-' + sufixo + parte;
          expect(indexHtml, `${t.page}: falta o cartão ${id}`).to.include('id="' + id + '"');
          expect(appJs, `${t.page}: nada escreve em ${id}`).to.include("$('" + id + "')");
        }
      }
    }
  });

  it('o resumo da retenção diz o que está pronto para rodar de verdade', () => {
    // Ativa, com política ligada e com cron: é o que o serviço agenda.
    const bloco = /async function loadRetention\(\) \{([\s\S]*?)\n  \}/.exec(appJs);
    expect(bloco, 'loadRetention sumiu').to.not.equal(null);
    for (const parte of ['p.Retention && p.Retention.Enabled', 'p.CronExpression', 'p.Enabled !== false']) {
      expect(bloco[1], `a contagem de prontas para rodar ignora ${parte}`).to.include(parte);
    }
  });

  // O formulário é em modal, com passos e com a dica de cada passo visível.
  it('o editor é um modal com passos, e cada passo tem a sua dica', () => {
    expect(appJs, 'o modal de passos sumiu').to.include('function modalPassos(');
    expect(appJs, 'os passos não viram trilho').to.include('class="wiz-steps"');
    expect(appJs, 'a dica do passo não é mostrada').to.include('class="wiz-tip">\' + esc(passos[atual].tip)');
    for (const passos of ['SYNC_PASSOS', 'RET_PASSOS']) {
      const bloco = new RegExp('const ' + passos + ' = \\[([\\s\\S]*?)\\n  \\];').exec(appJs);
      expect(bloco, `${passos} sumiu`).to.not.equal(null);
      for (const passo of bloco[1].split('\n').filter((l) => l.includes('tip:'))) {
        expect(passo, `um passo de ${passos} está sem dica`).to.include('tip:');
      }
      expect((bloco[1].match(/tip:/g) || []).length, `${passos} tem passo sem dica`).to.be.at.least(2);
    }
  });

  it('os campos do formulário têm tooltip, e o CSS sabe desenhá-lo', () => {
    expect(appJs, 'os campos não têm dica').to.include('class="dica"');
    expect(appJs, 'a dica é só texto solto').to.include('title="\' + esc(o.tip)');
    expect(css, 'o tooltip do formulário não tem estilo').to.match(/\.dica\s*\{/);
  });

  // Escrever, executar e apagar são três escopos. O botão de um não pode
  // aparecer para quem tem o outro.
  it('as ações da linha saem por escopo, não por BOM AVISO do painel', () => {
    for (const [tela, prefixo] of [['sync', 'sync'], ['retention', 'ret']]) {
      for (const acao of ['write', 'run', 'delete']) {
        expect(appJs, `a tela ${tela} não usa o escopo ${acao}`).to.include(`can('${tela}', '${acao}')`);
      }
      // E cada escopo tem um botão só dele: sem escopo, sem botão na linha.
      expect(appJs, `a tela ${tela} mostra ação sem escopo`).to.include("can('" + tela + "', 'run') ? '<button");
      expect(appJs, `a tela ${tela} mostra exclusão sem escopo`).to.include("can('" + tela + "', 'delete') ? '<button");
      expect(appJs, `${prefixo}: o botão de criar não respeita o escopo`).to.include(`$('btn-new-${tela}').hidden = !can('${tela}', 'write')`);
    }
  });

  // Criar é escrita; as três leituras do modal são sync:view. Sem esse escopo o
  // painel não as chama - e a tela de retenção também, porque as rotas são as
  // mesmas.
  it('as leituras do modal só existem para quem tem sync:view', () => {
    for (const rota of ['/api/sync/analyze', '/api/sync/plan', '/api/sync/retention/preview', '/api/sync/engines', '/api/sync/test-connection']) {
      expect(appJs, `a tela não usa ${rota}`).to.include("'" + rota + "'");
    }
    for (const fn of ['syncPassoAtual', 'retentionPassoAtual', 'carregarEngines']) {
      const bloco = new RegExp('(async )?function ' + fn + '\\([\\s\\S]*?\\n  \\}').exec(appJs);
      expect(bloco, `${fn} sumiu`).to.not.equal(null);
      expect(bloco[0], `${fn} não checa o escopo de leitura`).to.include("can('sync')");
    }
    // A tela de retenção usa as rotas do sincronismo, e a nota diz isso.
    expect(appJs, 'a tela de retenção esconde o motivo').to.include('sync:view');
  });

  // 200 com data.ok / data.success é o contrato: quem lê é a tela.
  it('execução e leitura leem o resultado em data, não o status HTTP', () => {
    for (const [fn, campo] of [['runSync', 'd.success'], ['runRetention', 'd.ok']]) {
      const bloco = new RegExp('async function ' + fn + '\\([\\s\\S]*?\\n  \\}').exec(appJs);
      expect(bloco, `${fn} sumiu`).to.not.equal(null);
      expect(bloco[0], `${fn} não olha ${campo}`).to.include(campo);
    }
    for (const [fn, campo] of [['renderAnalise', 'd.ok'], ['renderPreview', 'd.ok'], ['renderSim', 'd.ok']]) {
      const bloco = new RegExp('function ' + fn + '\\([\\s\\S]*?\\n  \\}').exec(appJs);
      expect(bloco, `${fn} sumiu`).to.not.equal(null);
      expect(bloco[0], `${fn} não olha ${campo}`).to.include(campo);
    }
  });

  // A senha do destino não volta do servidor, então "campo vazio" precisa
  // significar "não mexer" em vez de "apagada".
  it('senha em branco no editor é "não mexer", e nunca volta preenchida', () => {
    expect(appJs, 'o editor enche a senha com algo').to.include("base.Password = ''");
    expect(appJs, 'a senha em branco está indo no corpo').to.include('if (d.Password) corpo.Password = d.Password;');
    expect(appJs, 'o rascunho manda a senha para o simulador').to.include('delete out.Password');
  });

  // O motor é um só: análise, previsão e simulação não saem quando não há a
  // pasta que elas leem, em vez de chamar a rota para receber erro de pasta vazia.
  it('análise, previsão e simulação não saem sem a pasta que elas leem', () => {
    for (const [fn, guarda] of [['syncAnalyze', 'SourcePath'], ['syncPreview', 'DestPath'], ['syncSimular', 'SourcePath']]) {
      const bloco = new RegExp('function ' + fn + '\\([\\s\\S]*?\\n  \\}').exec(appJs);
      expect(bloco, `${fn} sumiu`).to.not.equal(null);
      expect(bloco[0], `${fn} chama a rota sem conferir ${guarda}`).to.include(guarda);
      expect(bloco[0], `${fn} não tem guarda de pasta vazia`).to.match(/if \(![\s\S]{0,220}\)\s*\{\s*toast\(/);
    }
  });

  it('o CSS das telas novas existe, e é o mesmo nas duas', () => {
    for (const seletor of ['.wiz-steps', '.wiz-step', '.wiz-tip', '.wiz-numbers', '.wiz-item', '.check-row', '.chip']) {
      expect(css, `falta o estilo ${seletor}`).to.include(seletor);
    }
  });
});

// ─── As rotas que as telas novas usam, por HTTP de verdade ───

describe('Painel web: as telas de sync e retenção batem com o servidor de verdade', function () {
  this.timeout(40000);

  let server, port, runs, temp, cookies, csrf;

  /**
   * Uma operação da tela: o que o painel chama (trecho de app.js) e o que o
   * servidor tem de atender. As duas metades são conferidas - painel que cita
   * rota inexistente e rota que o painel não usa são o mesmo defeito visto de
   * lados diferentes.
   */
  const OPERACOES = [
    { nome: 'listar perfis de sync', trecho: "api('/api/sync')", verbo: 'GET', rota: (id) => '/api/sync' },
    { nome: 'motores de destino', trecho: "apiQuiet('/api/sync/engines')", verbo: 'GET', rota: (id) => '/api/sync/engines' },
    { nome: 'ler um perfil', trecho: "api('/api/sync/' + encodeURIComponent(id))", verbo: 'GET', alvo: 'sync', rota: (id) => '/api/sync/' + id },
    { nome: 'criar perfil', trecho: "id ? '/api/sync/' + encodeURIComponent(id) : '/api/sync'", verbo: 'POST', rota: (id) => '/api/sync', corpo: () => ({ Name: 'Via painel', SourcePath: origem, DestPath: destino, Engine: 'local', CronExpression: '0 3 * * *' }) },
    { nome: 'editar perfil', trecho: "id ? '/api/sync/' + encodeURIComponent(id) : '/api/sync'", verbo: 'PUT', alvo: 'sync', rota: (id) => '/api/sync/' + id, corpo: () => ({ Name: 'Via painel, editada' }) },
    { nome: 'executar perfil', trecho: "api('/api/sync/' + encodeURIComponent(id) + '/run', { method: 'POST' })", verbo: 'POST', alvo: 'sync', rota: (id) => '/api/sync/' + id + '/run' },
    { nome: 'excluir perfil', trecho: "api('/api/sync/' + encodeURIComponent(apagar.getAttribute('data-delsync')), { method: 'DELETE' })", verbo: 'DELETE', alvo: 'descartavel', rota: (id) => '/api/sync/' + id },
    { nome: 'analisar pasta', trecho: "api('/api/sync/analyze', {", verbo: 'POST', rota: () => '/api/sync/analyze', corpo: () => ({ dir: origem }) },
    { nome: 'simular plano', trecho: "api('/api/sync/plan', {", verbo: 'POST', rota: () => '/api/sync/plan', corpo: () => ({ draft: { SourcePath: origem, DestPath: destino, Engine: 'local' } }) },
    { nome: 'prever retenção', trecho: "api('/api/sync/retention/preview', {", verbo: 'POST', rota: () => '/api/sync/retention/preview', corpo: () => ({ dir: destino, Retention: { Enabled: true, ByAge: true, KeepDays: 5, MinKeep: 1 } }) },
    { nome: 'testar conexão', trecho: "api('/api/sync/test-connection', {", verbo: 'POST', rota: () => '/api/sync/test-connection', corpo: () => ({ Engine: 'local', DestPath: destino }) },
    { nome: 'listar agendas', trecho: "api('/api/retention')", verbo: 'GET', rota: () => '/api/retention' },
    { nome: 'ler uma agenda', trecho: "api('/api/retention/' + encodeURIComponent(id))", verbo: 'GET', alvo: 'ret', rota: (id) => '/api/retention/' + id },
    { nome: 'criar agenda', trecho: "id ? '/api/retention/' + encodeURIComponent(id) : '/api/retention'", verbo: 'POST', rota: () => '/api/retention', corpo: () => ({ Name: 'Agenda via painel', FolderPath: destino, CronExpression: '0 4 * * *', Retention: { Enabled: true, ByAge: true, KeepDays: 5, MinKeep: 1 } }) },
    { nome: 'editar agenda', trecho: "id ? '/api/retention/' + encodeURIComponent(id) : '/api/retention'", verbo: 'PUT', alvo: 'ret', rota: (id) => '/api/retention/' + id, corpo: () => ({ Name: 'Agenda via painel, editada' }) },
    { nome: 'executar agenda', trecho: "api('/api/retention/' + encodeURIComponent(id) + '/run', { method: 'POST' })", verbo: 'POST', alvo: 'ret', rota: (id) => '/api/retention/' + id + '/run' },
    { nome: 'excluir agenda', trecho: "api('/api/retention/' + encodeURIComponent(apagarRet.getAttribute('data-delret')), { method: 'DELETE' })", verbo: 'DELETE', alvo: 'descartavel', rota: (id) => '/api/retention/' + id },
  ];

  let origem, destino, syncId, retId;

  const request = (routePath, options = {}) => new Promise((resolve) => {
    const headers = Object.assign({}, options.headers);
    const login = options.login || 'boss';
    if (cookies[login]) headers.cookie = cookies[login];
    if (csrf[login] && options.method && options.method !== 'GET' && !('X-CSRF-Token' in headers)) {
      headers['X-CSRF-Token'] = csrf[login];
    }
    if (options.body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const req = http.request({ host: '127.0.0.1', port, path: routePath, method: options.method || 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) {}
        resolve({ status: res.statusCode, json, body });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, body: e.message }));
    if (options.body) req.write(options.body);
    req.end();
  });

  /** Um alvo descartável: excluir destrói o cadastro, e a operação seguinte precisa dele. */
  const criarDescartavel = async (op) => {
    if (op.trecho.includes('apagarRet')) {
      const r = await request('/api/retention', {
        method: 'POST',
        body: JSON.stringify({ Name: 'Descartável', FolderPath: destino, CronExpression: '0 4 * * *', Retention: { Enabled: true, ByAge: true, KeepDays: 5, MinKeep: 1 } }),
      });
      return r.json.data.Id;
    }
    const r = await request('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ Name: 'Descartável', SourcePath: origem, DestPath: destino, Engine: 'local' }),
    });
    return r.json.data.Id;
  };

  before(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-webpanel-sync-'));
    const config = new ConfigManager(path.join(temp, 'config'), 'default');
    const logger = { log() {}, info() {}, warn() {}, error() {}, audit() {}, getRecentLogs: () => [], getRecentLogsFromDisk: () => [] };
    const cronParser = new CronParser();
    runs = new RunRegistry();
    const taskManager = new TaskManager(config, logger, cronParser, runs);
    const backupManager = new BackupManager(config, logger, runs);
    const syncManager = new SyncManager(config, logger, runs);
    const retentionManager = new RetentionManager({ syncManager, cronParser, logger, configDir: path.join(temp, 'config') });

    origem = path.join(temp, 'origem');
    destino = path.join(temp, 'destino');
    for (const [dir, quantos] of [[origem, 4], [destino, 6]]) {
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < quantos; i++) {
        const arquivo = path.join(dir, '2026-0' + (i + 1) + '-0' + i + '/db.7z');
        fs.mkdirSync(path.dirname(arquivo), { recursive: true });
        fs.writeFileSync(arquivo, 'conteudo ' + i);
        const quando = new Date(Date.UTC(2026, i, 10));
        fs.utimesSync(arquivo, quando, quando);
      }
    }

    // Um login que pode tudo e um que só lê: o painel esconde botões por escopo,
    // e o servidor recusa. Os dois lados precisam concordar.
    config.setSetting('WebAllowedUsers', ['boss', 'reader']);
    config.setSetting('WebUserPermissions', { boss: ['*'], reader: ['sync:view', 'retention:view'] });

    server = new ApiServer(taskManager, config, logger, null, null, backupManager, {
      runRegistry: runs, cronParser, syncManager, retentionManager,
    });
    port = (await server.start(7751)).port;

    cookies = {}; csrf = {};
    for (const login of ['boss', 'reader']) {
      const sid = server.auth.createSession({ login, id: 1, name: login }, '127.0.0.1');
      cookies[login] = 'kyrios_sid=' + server.auth.signCookie(sid);
      csrf[login] = security.csrfToken(server.auth.secret, sid);
    }

    const criado = await request('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ Name: 'Base do teste', SourcePath: origem, DestPath: destino, Engine: 'local', CronExpression: '0 3 * * *' }),
    });
    syncId = criado.json.data.Id;
    const agenda = await request('/api/retention', {
      method: 'POST',
      body: JSON.stringify({ Name: 'Agenda base', FolderPath: destino, CronExpression: '0 4 * * *', Retention: { Enabled: true, ByAge: true, KeepDays: 5, MinKeep: 1 } }),
    });
    retId = agenda.json.data.Id;
  });

  after(async () => {
    if (server) await server.stop();
    if (runs) runs.dispose();
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (e) {}
  });

  it('o servidor de teste subiu com as duas telas usáveis', async () => {
    const sync = await request('/api/sync');
    const ret = await request('/api/retention');
    expect(sync.status, 'a tela de sync não tem onde ler').to.equal(200);
    expect(ret.status, 'a tela de retenção não tem onde ler').to.equal(200);
    expect(syncId, 'o perfil de teste não foi criado').to.be.a('string');
    expect(retId, 'a agenda de teste não foi criada').to.be.a('string');
  });

  // Uma por operação: o painel cita aquele trecho e o servidor atende o pedido.
  // Sem isto, um caminho de /api guardado como texto só falharia no clique.
  for (const op of OPERACOES) {
    it(`"${op.nome}" existe no painel e responde no servidor`, async () => {
      expect(appJs, `o painel não tem a chamada de ${op.nome}`).to.include(op.trecho);
      // Excluir destrói o cadastro: cada uma ganha um alvo descartável, senão a
      // operação seguinte não tem mais o que ler.
      const id = op.alvo === 'descartavel' ? await criarDescartavel(op)
        : op.alvo === 'ret' ? retId : syncId;
      const res = await request(op.rota(id), {
        method: op.verbo,
        body: op.corpo ? JSON.stringify(op.corpo()) : undefined,
      });
      expect(res.status, `${op.verbo} ${op.rota(id)} respondeu ${res.status} (${String(res.body).slice(0, 160)})`)
        .to.not.be.oneOf([404, 405, 501]);
      expect(res.status, `${op.nome} não pode ser erro de servidor`).to.be.below(500);
    });
  }

  // O probe precisa ser capaz de falhar: um caminho que não existe tem de dar
  // 404, senão "não é 404" não prova nada.
  it('a sondagem distingue rota mapeada de rota inexistente', async () => {
    const inexistente = await request('/api/sync/rota-que-nao-existe');
    expect(inexistente.status).to.equal(404);
    const metodoErrado = await request('/api/sync/engines', { method: 'DELETE' });
    expect(metodoErrado.status, 'uma rota GET não pode responder a DELETE').to.not.equal(200);
  });

  // A tela esconde o botão pelo escopo; o servidor recusa pelo mesmo escopo. Se
  // um dos dois mudasse, o painel ofereceria (ou aceitaria) o que não devia.
  it('quem só lê consegue ler, e não escreve - o mesmo desenho dos botões', async () => {
    for (const rota of ['/api/sync', '/api/sync/engines', '/api/retention', '/api/sync/' + syncId, '/api/retention/' + retId]) {
      const res = await request(rota, { login: 'reader' });
      expect(res.status, `${rota} deveria responder para quem só lê`).to.equal(200);
    }
    const escritas = [
      { verbo: 'POST', rota: '/api/sync', corpo: { Name: 'Não pode', SourcePath: origem, DestPath: destino } },
      { verbo: 'PUT', rota: '/api/sync/' + syncId, corpo: { Name: 'Não pode' } },
      { verbo: 'POST', rota: '/api/sync/' + syncId + '/run' },
      { verbo: 'DELETE', rota: '/api/sync/' + syncId },
      { verbo: 'POST', rota: '/api/retention', corpo: { Name: 'Não pode', FolderPath: destino, CronExpression: '0 4 * * *', Retention: { Enabled: true, ByAge: true, KeepDays: 5 } } },
      { verbo: 'PUT', rota: '/api/retention/' + retId, corpo: { Name: 'Não pode' } },
      { verbo: 'POST', rota: '/api/retention/' + retId + '/run' },
      { verbo: 'DELETE', rota: '/api/retention/' + retId },
    ];
    for (const escrita of escritas) {
      const res = await request(escrita.rota, {
        method: escrita.verbo, login: 'reader',
        body: escrita.corpo ? JSON.stringify(escrita.corpo) : undefined,
      });
      expect(res.status, `${escrita.verbo} ${escrita.rota} deveria estar recusado para quem só lê`).to.equal(403);
    }
  });

  // As leituras do modal pedem só :view - é o que permite a uma conta de leitura
  // abrir o editor e simular sem poder gravar nada.
  it('as três leituras do modal são de leitura, e por isso abrem para quem só lê', async () => {
    const leitor = [
      { rota: '/api/sync/analyze', corpo: { dir: origem } },
      { rota: '/api/sync/plan', corpo: { draft: { SourcePath: origem, DestPath: destino, Engine: 'local' } } },
      { rota: '/api/sync/retention/preview', corpo: { dir: destino, Retention: { Enabled: true, ByAge: true, KeepDays: 5, MinKeep: 1 } } },
    ];
    for (const leitura of leitor) {
      const res = await request(leitura.rota, { method: 'POST', login: 'reader', body: JSON.stringify(leitura.corpo) });
      expect(res.status, `${leitura.rota} não é leitura`).to.equal(200);
      expect(res.json, `${leitura.rota} não devolve o envelope do painel`).to.have.property('success', true);
    }
  });

  // O envelope é o contrato entre a tela e o servidor: {success, data, count}
  // na leitura, {success} na escrita. A tela desmente do que o servidor manda.
  it('as leituras devolvem {success,data,count} e as escritas {success}', async () => {
    const lista = await request('/api/sync');
    expect(lista.json).to.have.property('success', true);
    expect(lista.json).to.have.property('count');
    expect(lista.json).to.have.property('data').that.is.an('array');
    expect(lista.json.count).to.equal(lista.json.data.length);

    const criado = await request('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ Name: 'Envelope', SourcePath: origem, DestPath: destino, Engine: 'local' }),
    });
    expect(criado.status).to.equal(201);
    expect(criado.json).to.have.property('success', true);
    expect(criado.json.data, 'a senha não volta nem na criação').to.not.have.property('Password');

    const apagado = await request('/api/sync/' + criado.json.data.Id, { method: 'DELETE' });
    expect(apagado.json).to.have.property('success', true);
  });

  // 200 com o resultado em data: a tela precisa ler data, e o teste prova que
  // o erro do motor não vem como status.
  it('executar devolve 200 mesmo quando o motor falha, com o motivo em data', async () => {
    // Destino que é um arquivo: o motor local não consegue transformar arquivo
    // em pasta, e a execução morre no caminho - sem virar erro de status.
    const arquivo = path.join(temp, 'destino-que-e-arquivo.txt');
    fs.writeFileSync(arquivo, 'nao sou uma pasta');
    const quebrado = await request('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ Name: 'Destino impossível', SourcePath: origem, DestPath: arquivo, Engine: 'local' }),
    });
    const res = await request('/api/sync/' + quebrado.json.data.Id + '/run', { method: 'POST' });
    expect(res.status, 'o painel leria o status para decidir o aviso').to.equal(200);
    expect(res.json).to.have.property('success', true);
    expect(res.json.data.success, 'o motivo da falha tem de estar em data').to.equal(false);
    expect(res.json.data.message).to.be.a('string');
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
    for (const arquivo of ['apiServer.js', 'webSecurity.js', 'webAuth.js', 'webPermissions.js', 'backupArtifacts.js', 'serviceManager.js', 'wrapperGenerator.js', 'runRegistry.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', arquivo), 'utf8');
      const importa = /require\('electron'\)/.test(src.replace(/\/\/.*$/gm, ''));
      expect(importa, `${arquivo} importa electron e o serviço não conseguiria carregá-lo`).to.equal(false);
    }
  });
});
