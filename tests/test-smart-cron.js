// tests/test-smart-cron.js
//
// smartCron é o componente de cron com autocomplete do agendador, e nenhum
// teste o alcançava. A validação acontece antes de salvar uma tarefa, então
// um erro aqui é uma tarefa agendada para nunca rodar.
//
// O componente precisa de DOM para renderizar, mas quem decide se a expressão
// é válida, quando ela roda e como ela é descrita é lógica pura. O arquivo
// entra num vm com o mínimo de DOM e os métodos são exercitados no protótipo.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'smartCron.js'), 'utf8');

// O mesmo i18n que a tela carrega: sem ele o componente cairia na chave e o
// teste passaria sem provar nada sobre a tradução.
function carregarI18n() {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(`${fonte}\n;this.__i18n = i18n;`, ctx);
  return ctx.__i18n;
}

function docMinimo() {
  return {
    createElement() {
      return {
        _text: '',
        set textContent(v) { this._text = v == null ? '' : String(v); },
        get textContent() { return this._text; },
        get innerHTML() {
          return this._text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        },
      };
    },
    querySelector() { return null; },
    getElementById() { return null; },
  };
}

function carregarSmartCron(idioma) {
  const contexto = {
    document: docMinimo(),
    i18n: idioma,
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };
  contexto.window = contexto;
  vm.createContext(contexto);
  // `class` num contexto vm é escopo léxico: não vira propriedade do objeto de
  // contexto. Sem expor explicitamente, o que é declarado aqui é inacessível
  // de fora e o teste passaria a não exercitar nada.
  vm.runInContext(`${SOURCE}\n;this.__SmartCron = SmartCronInput;this.__escapeText = escapeText;`, contexto);
  return contexto;
}

const i18n = carregarI18n();
const ctx = carregarSmartCron(i18n);
const Proto = ctx.__SmartCron.prototype;

// Instância sem constructor: só os métodos, sem DOM nem timer.
function novo(value) {
  const inst = Object.create(Proto);
  inst.value = value;
  inst.excludeId = null;
  inst._conflictTimer = null;
  return inst;
}

describe('SmartCron: os cinco campos e os limites', () => {
  it('aceita um curinga em qualquer posicao', () => {
    const c = novo('* * * * *');
    for (const [min, max] of [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]) {
      expect(c.validateField('*', min, max)).to.equal(true);
    }
  });

  it('recusa numero fora da faixa do campo', () => {
    const c = novo('* * * * *');
    expect(c.validateField('60', 0, 59)).to.equal(false);
    expect(c.validateField('24', 0, 23)).to.equal(false);
    expect(c.validateField('32', 1, 31)).to.equal(false);
    expect(c.validateField('13', 1, 12)).to.equal(false);
    expect(c.validateField('8', 0, 7)).to.equal(false);
  });

  it('recusa o que não se parece com campo de cron', () => {
    const c = novo('* * * * *');
    for (const valor of ['abc', '1.5', '-', '1,,2', ',5', 'x-y', '*/', '1-', '1/0']) {
      expect(c.validateField(valor, 0, 59), `"${valor}"`).to.equal(false);
    }
  });

  it('aceita os operadores de cron', () => {
    const c = novo('* * * * *');
    expect(c.validateField('*/5', 0, 59)).to.equal(true);
    expect(c.validateField('1-30', 0, 59)).to.equal(true);
    expect(c.validateField('1,15,30', 0, 59)).to.equal(true);
    expect(c.validateField('1-30/2', 0, 59)).to.equal(true);
  });

  it('um campo vazio passa na validação de campo, mas não salva a tarefa', () => {
    // Campo vazio é digitação em andamento, não erro: quem decide é a
    // expressão inteira, que exige os cinco campos preenchidos.
    const c = novo('* * * *');
    expect(c.validateField('', 0, 59)).to.equal(true);
    expect(c.isValid()).to.equal(false);
  });
});

describe('SmartCron: isValid na expressao inteira', () => {
  it('aceita as expressoes que aparecem em tarefa real', () => {
    for (const expr of ['* * * * *', '0 3 * * *', '*/15 * * * *', '0 0 * * 1-5', '30 2 1 * *', '0 12 * * 0']) {
      expect(novo(expr).isValid(), expr).to.equal(true);
    }
  });

  it('recusa expressao incompleta ou com campo a mais', () => {
    for (const expr of ['', '* * * *', '* * * * * *', '0 3 * * * *', 'abc', '* * * * *x']) {
      expect(novo(expr).isValid(), `"${expr}"`).to.equal(false);
    }
  });

  it('recusa campo fora da faixa dentro de uma expressao completa', () => {
    expect(novo('99 * * * *').isValid()).to.equal(false);
    expect(novo('* 25 * * *').isValid()).to.equal(false);
  });
});

describe('SmartCron: a descricao vai pelo i18n', () => {
  it('não deixa string de tela escrita direto no código', () => {
    // Era exatamente o que acontecia: "Runs every minute", " daily" e
    // " past hour" iam para a tela dentro de um app em português. As chaves
    // cron.runsAt, cron.everyNMinutes e cron.everyNHours já existiam nos dois
    // dicionários e não eram usadas.
    const corpo = SOURCE.slice(SOURCE.indexOf('getDescription()'));
    const literais = corpo.match(/['`](Runs|daily| of every hour| past hour|minute | of month| on day)[^'`]*['"`]/g) || [];
    expect(literais).to.deep.equal([]);
  });

  it('descreve as cinco estrelas com a chave traduzida', () => {
    expect(novo('* * * * *').getDescription()).to.equal(i18n.t('cron.everyMinute'));
  });

  it('descreve passo em minutos e em horas pela chave com parâmetro', () => {
    expect(novo('*/15 * * * *').getDescription()).to.equal(i18n.t('cron.everyNMinutes', { n: 15 }));
    expect(novo('0 */2 * * *').getDescription()).to.equal(i18n.t('cron.everyNHours', { n: 2 }));
  });

  it('traduz a descrição para o idioma escolhido, e não para o inglês', () => {
    // O i18n carregado isoladamente começa em inglês; é o setLang que prova
    // que a descrição não tem mais literal em inglês dentro do código.
    i18n.setLang('pt-BR');
    try {
      expect(novo('0 3 * * *').getDescription()).to.equal('Executa às 0:03');
      i18n.setLang('en');
      expect(novo('0 3 * * *').getDescription()).to.equal('Runs at 0:03');
    } finally {
      i18n.setLang('en');
    }
  });

  it('não quebra com expressão incompleta, que aparece enquanto se digita', () => {
    for (const expr of ['* *', '', 'abc', '* * * * * *', '*/', '1-']) {
      expect(() => novo(expr).getDescription(), expr).to.not.throw();
      expect(typeof novo(expr).getDescription(), expr).to.equal('string');
    }
  });
});

describe('SmartCron: quando a expressão roda', () => {
  // A data nasce no contexto vm, que tem o próprio Date: instanceof falha
  // entre realms, e o teste passaria a recusar uma data correta.
  const ehData = (v) => Object.prototype.toString.call(v) === '[object Date]';

  it('acha a próxima execução de um horário fixo', () => {
    const proxima = novo('0 3 * * *').getNextRun();
    expect(ehData(proxima)).to.equal(true);
    expect(proxima.getHours()).to.equal(3);
    expect(proxima.getMinutes()).to.equal(0);
    expect(proxima.getTime()).to.be.above(Date.now());
  });

  it('acha a próxima execução de todo minuto, sempre no futuro', () => {
    const proxima = novo('* * * * *').getNextRun();
    expect(proxima.getTime()).to.be.above(Date.now());
    expect(proxima.getSeconds()).to.equal(0);
  });

  it('honra dia da semana e dia do mês', () => {
    expect(novo('0 0 * * 1').getNextRun().getDay()).to.equal(1);
    expect(novo('0 0 15 * *').getNextRun().getDate()).to.equal(15);
  });

  it('devolve nada para expressão inválida, em vez de uma data inventada', () => {
    for (const expr of ['nao-e-cron', '* * * *', '99 * * * *', '', '1.5 * * * *']) {
      expect(novo(expr).getNextRun(), expr).to.equal(null);
    }
  });
});

describe('SmartCron: casamento de um campo', () => {
  it('casa numero exato, curinga, intervalo, lista e passo', () => {
    const c = novo('* * * * *');
    expect(c.matchesField(5, '*', 0, 59)).to.equal(true);
    expect(c.matchesField(5, '5', 0, 59)).to.equal(true);
    expect(c.matchesField(5, '6', 0, 59)).to.equal(false);
    expect(c.matchesField(5, '1-10', 0, 59)).to.equal(true);
    expect(c.matchesField(5, '10-20', 0, 59)).to.equal(false);
    expect(c.matchesField(5, '1,5,9', 0, 59)).to.equal(true);
    expect(c.matchesField(5, '1,9,10', 0, 59)).to.equal(false);
    expect(c.matchesField(10, '*/5', 0, 59)).to.equal(true);
    expect(c.matchesField(11, '*/5', 0, 59)).to.equal(false);
  });

  it('lida com passo junto de intervalo', () => {
    const c = novo('* * * * *');
    expect(c.matchesField(6, '1-10/2', 0, 59)).to.equal(true);
    expect(c.matchesField(7, '1-10/2', 0, 59)).to.equal(false);
  });
});

describe('SmartCron: o texto do componente não injeta HTML', () => {
  it('escapa um valor que é HTML antes de virar markup', () => {
    const saida = ctx.__escapeText('<img src=x onerror=alert(1)>');
    expect(saida).to.not.include('<img');
    expect(saida).to.include('&lt;img');
  });
});

function hostFake() {
  return {
    innerHTML: '',
    _botao: null,
    querySelector(sel) { return sel === '#cron-suggest' ? this._botao : null; },
  };
}

describe('SmartCron: conflito de agenda é assíncrono e some quando não há host', () => {
  // checkConflicts é debounced e escreve num elemento do DOM; sem container
  // ele precisa simplesmente não fazer nada, sem lançar.
  it('não estoura quando não há onde mostrar o resultado', () => {
    const c = novo('0 3 * * *');
    c.container = { querySelector: () => null };
    expect(() => c.checkConflicts()).to.not.throw();
  });

  it('limpa o aviso quando a consulta falha', async () => {
    const host = hostFake();
    host.innerHTML = 'conteudo antigo';
    const c = novo('0 3 * * *');
    c.container = { querySelector: (sel) => (sel === '#cron-conflicts' ? host : null) };
    ctx.window.api = { checkScheduleConflicts: async () => { throw new Error('ipc fora'); } };
    await c._doCheckConflicts();
    expect(host.innerHTML).to.equal('');
  });

  it('avisa que está livre quando não há conflito', async () => {
    const host = hostFake();
    const c = novo('0 3 * * *');
    c.container = { querySelector: (sel) => (sel === '#cron-conflicts' ? host : null) };
    ctx.window.api = { checkScheduleConflicts: async () => ({ success: true, conflicts: [], totalScheduled: 1 }) };
    await c._doCheckConflicts();
    expect(host.innerHTML).to.contain('cron-conflict-ok');
  });

  it('escapa o nome e a expressão do item em conflito', async () => {
    // Nome de tarefa é texto do usuário; a lista vai para innerHTML.
    const host = hostFake();
    const c = novo('0 3 * * *');
    c.container = { querySelector: (sel) => (sel === '#cron-conflicts' ? host : null) };
    ctx.window.api = {
      checkScheduleConflicts: async () => ({
        success: true,
        totalScheduled: 1,
        conflicts: [{ name: '<img src=x onerror=alert(1)>', cron: '0 3 * * *', kind: 'task', at: '2026-01-01T03:00:00Z' }],
      }),
    };
    await c._doCheckConflicts();
    expect(host.innerHTML).to.not.include('<img');
    expect(host.innerHTML).to.include('&lt;img');
  });

  it('não acusa a agenda que está sendo editada contra ela mesma', async () => {
    // A exclusão acontece no main; aqui o que importa é que o id viaja e o
    // componente não filtra por conta própria um item que ele não mostrou.
    const recebidos = [];
    ctx.window.api = {
      checkScheduleConflicts: async (expr, excludeId) => { recebidos.push({ expr, excludeId }); return { success: true, conflicts: [], totalScheduled: 0 }; },
    };
    const c = novo('0 3 * * *');
    c.excludeId = 't1';
    c.container = { querySelector: (sel) => (sel === '#cron-conflicts' ? hostFake() : null) };
    await c._doCheckConflicts();
    expect(recebidos[0].excludeId).to.equal('t1');
  });
});