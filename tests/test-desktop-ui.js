// tests/test-desktop-ui.js
//
// tests/test-desktop-ui.js
//
// The GitHub profile modal built its markup straight from the public API:
// repository descriptions and the profile bio are free text written by third
// parties, and they went into innerHTML unescaped. A description containing
// <img onerror=...> is script running inside the app.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const read = file => fs.readFileSync(path.join(RENDERER, file), 'utf8');

// The desktop task screens had four failures that no test would have caught:
// the quick create preview died on a CronParser that only exists in the main
// process, a task history rendered every entry into a scroll container whose
// rows collapsed into each other, a Windows path lost its backslashes when it
// went through an inline handler, and a log cell grew on hover instead of
// opening the entry.
//
// The first block is static: it pins the shape of the code. The second runs the
// real renderer in Electron and checks the behaviour.
describe('GitHub profile modal', () => {
  const appJs = read('app.js');
  const bloco = appJs.slice(appJs.indexOf('async function showGitHubProfile'), appJs.indexOf("document.getElementById('credits-author')"));

  it('escapes every field it takes from the API', () => {
    // Todo buraco ${...} do bloco é inspecionado: os campos que a API devolve
    // como texto livre precisam estar dentro de um escaper, em qualquer
    // posição. Procurar o nome do campo logo depois de ${ não funciona, porque
    // escapado o campo aparece dentro de ${escHtml(campo)}.
    const buracos = bloco.match(/\$\{[^}]*\}/g) || [];
    expect(buracos.length, 'o bloco deixou de usar template literal').to.be.above(5);

    const camposApi = ['user.location', 'user.company', 'user.blog', 'user.name', 'user.login',
      'user.bio', 'user.avatar_url', 'user.created_at', 'user.public_repos', 'user.followers',
      'user.following', 'user.public_gists', 'r.name', 'r.description', 'r.language', 'r.html_url',
      'r.stargazers_count'];

    for (const buraco of buracos) {
      const cita = camposApi.some((campo) => buraco.includes(campo));
      if (!cita) continue;
      const escapado = /esc(Html|Attr)\(/.test(buraco);
      // Um número vai por Number(): a API mandar "7; DROP" não vira texto.
      const numerico = /Number\(/.test(buraco) || /toLocaleDateString/.test(buraco);
      expect(escapado || numerico, 'campo da API cru no innerHTML: ' + buraco).to.equal(true);
    }
  });

  it('nao deixa o contador de estrelas virar o que a API mandar', () => {
    expect(bloco).to.include('${Number(r.stargazers_count) || 0}');
  });

  it('abre links externos com noopener e noreferrer', () => {
    const semProtecao = bloco.match(/<a[^>]*target="_blank"(?![^>]*rel="noopener noreferrer")/g) || [];
    expect(semProtecao).to.deep.equal([]);
  });

  it('tem container proprio, escuro e com margem interna', () => {
    expect(bloco).to.include('gh-shell');
    const css = read('style.css');
    const shell = /\.gh-shell\s*\{([^}]*)\}/.exec(css);
    expect(shell, '.gh-shell precisa existir no CSS').to.not.equal(null);
    expect(shell[1]).to.match(/padding:\s*22px 24px/);
    // Vidro translucido vira cinza chapado sobre fundo escuro e o texto perde
    // o degrau contra o papel de parede da janela.
    expect(shell[1]).not.to.include('var(--glass)');
  });
});

const index = read('index.html');
const css = read('style.css');
const i18nSource = read('i18n.js');
const app = read('app.js');
const quick = read('quickCreate.js');

const RUNNER = path.join(__dirname, 'fixtures', 'desktop-ui-runner.js');

const { rodar, ELECTRON } = require('./fixtures/electron-runner');

const runDesktop = () => rodar(RUNNER, 'desktop renderer');

describe('Desktop tasks: the renderer never instantiates the cron parser', () => {
  // CronParser is a main-process module (module.exports). The renderer asked
  // for it with `new CronParser()` on every keystroke, which threw a
  // ReferenceError: no preview, no preview error, nothing created.
  it('does not construct a CronParser anywhere in the renderer', () => {
    for (const [name, src] of [['app.js', app], ['quickCreate.js', quick]]) {
      expect(src, `${name} still instantiates CronParser`).to.not.match(/new\s+CronParser/);
    }
  });

  it('validates the batch through the main process', () => {
    expect(quick).to.include('validateCron');
    expect(app).to.include('await window.api.validateCron(cron)');
  });

  it('awaits the preview instead of painting a stale answer', () => {
    const fn = app.slice(app.indexOf('async function updateQuickPreview'), app.indexOf("document.getElementById('btn-quick-clear')"));
    expect(fn).to.include('await parseQuickLines');
    expect(fn).to.include('quickPreviewToken');
  });
});

describe('Desktop tasks: quick create starts closed and says so', () => {
  it('renders the panel hidden and wires the toggle for assistive tech', () => {
    expect(index).to.match(/id="btn-toggle-quick"[^>]*aria-expanded="false"[^>]*aria-controls="quick-create-panel"/);
    expect(index).to.match(/id="quick-create-panel" class="quick-panel hidden"/);
  });

  it('remembers the choice and updates aria-expanded both ways', () => {
    const fn = app.slice(app.indexOf('function applyQuickCreateState'), app.indexOf('function renderQuickTasks'));
    expect(fn).to.include("localStorage.setItem(QUICK_CREATE_KEY");
    expect(fn).to.include("btn.setAttribute('aria-expanded'");
    expect(fn).to.match(/aria-expanded', open \? 'true' : 'false'/);
  });
});

describe('Desktop tasks: history rows open a detail instead of expanding', () => {
  it('does not toggle a class on the row to reveal the output', () => {
    expect(app).to.not.match(/th-expanded/);
    expect(app).to.not.match(/classList\.toggle\('expanded'\)/);
  });

  it('caps the list and offers the rest on demand', () => {
    expect(app).to.match(/const HISTORY_PAGE = \d+/);
    expect(app).to.include('historyModalLimit += HISTORY_PAGE');
  });

  it('refetches the history instead of trusting the cached copy', () => {
    const fn = app.slice(app.indexOf('async function showTaskHistory'), app.indexOf('function historyStatusIcon'));
    expect(fn).to.include('await window.api.getHistory()');
    expect(fn).to.not.match(/allHistory\.length === 0/);
  });

  it('shows the run in a wide modal with a summary and a help line', () => {
    const fn = app.slice(app.indexOf('function renderTaskHistoryModal'), app.indexOf('async function refreshHistoryModalSummary'));
    expect(fn).to.include('showRunDetail(');
    expect(fn).to.include('modal-summary');
    expect(fn).to.include('modal-help');
    expect(fn).to.match(/showModal\(`[\s\S]*?`, true\)/);
  });

  it('reuses the same detail from the dashboard and the history screen', () => {
    const dash = app.slice(app.indexOf('recentActivityRows = rows.slice'), app.indexOf('lucide.createIcons();\n  } finally'));
    expect(dash).to.include('showRunDetail(item.entry, item.entryKind)');
    const screen = app.slice(app.indexOf('function renderHistory()'), app.indexOf("document.querySelectorAll('.seg-btn')"));
    expect(screen).to.include('showRunDetail(entry,');
  });
});

describe('Desktop tasks: escaping an inline handler keeps Windows paths', () => {
  it('has a dedicated handler escaper that escapes the backslash first', () => {
    const fn = app.slice(app.indexOf('function escHandler'), app.indexOf('function browseScript'));
    const amp = fn.indexOf(".replace(/&/g");
    const slash = fn.indexOf('.replace(/\\\\/g');
    const quote = fn.indexOf("replace(/'/g");
    expect(amp, 'the ampersand goes first, for the attribute it lives in').to.be.above(-1);
    expect(slash, 'the backslash must be escaped before the quote').to.be.above(amp);
    expect(quote).to.be.above(slash);
  });

  it('has one escaper for attributes, which does not double the backslashes', () => {
    expect(app).to.match(/function escAttr\(s\) \{ return escHtml\(s\)/);
    // The duplicate that mangled paths is gone.
    expect(app.match(/function escAttr\(/g) || []).to.have.lengthOf(1);
    expect(app).to.not.match(/function escAttr\(s\) \{\s*\n\s*return String\(s == null/);
  });

  it('uses the handler escaper wherever a value goes into an onclick', () => {
    const offenders = [...app.matchAll(/onclick="[a-zA-Z_]+\('\$\{([^}]*)\}'/g)]
      .map(m => m[1])
      .filter(expr => !expr.includes('escHandler'));
    expect(offenders, 'a raw value reaches an inline handler').to.deep.equal([]);
  });
});

describe('Desktop tasks: logs scroll and open a modal', () => {
  it('wraps the generated table in a scroll container with a min width', () => {
    const fn = app.slice(app.indexOf('function renderLogsTable'), app.indexOf('function showLogDetail'));
    expect(fn.match(/class="table-wrap table-scroll" data-min="620"/g) || []).to.have.lengthOf(3);
  });

  it('makes the row the hit target, keyboard included', () => {
    expect(app).to.include('data-log-index');
    const fn = app.slice(app.indexOf('(function wireLogRowDetail'), app.indexOf('function showLogDetail'));
    expect(fn).to.include("e.key !== 'Enter' && e.key !== ' '");
    expect(fn).to.include('showLogDetail(currentLogTab, entry)');
  });
});

describe('Desktop tasks: the task dialog reads as four steps', () => {
  it('has steps, tooltips, help and a live summary', () => {
    const fn = app.slice(app.indexOf('function showTaskDialog'), app.indexOf('function scriptEditorSwitchMode'));
    expect(fn).to.include('modal-steps');
    expect(fn).to.include('modal-help');
    expect(fn).to.include('modal-summary');
    expect(fn.match(/data-tip="\$\{/g) || []).to.have.lengthOf.at.least(6);
    expect(app.slice(app.indexOf('function updateTaskDialogSummary'), app.indexOf('// Script mode switching')))
      .to.include('modal-summary-item');
  });

  it('restyles the history row as a button, keeping the expandable one intact', () => {
    expect(css).to.include('button.th-entry {');
    // syncPage still uses the expand behaviour on a div.
    expect(css).to.include('.th-expanded .th-output { display: block; }');
  });
});

describe('Desktop tasks: every new string is translated', () => {
  const sources = { 'app.js': app, 'quickCreate.js': quick, 'index.html': index };

  it('declares each key in both dictionaries', () => {
    const used = new Set();
    const isKey = value => /^[a-zA-Z]+\.[a-zA-Z0-9]+$/.test(value);
    for (const src of Object.values(sources)) {
      for (const m of src.matchAll(/i18n\.t\(\s*'([^']+)'/g)) if (isKey(m[1])) used.add(m[1]);
      for (const m of src.matchAll(/qcT\(\s*'([^']+)'/g)) if (isKey(m[1])) used.add(m[1]);
      for (const m of src.matchAll(/\bT\(\s*'([^']+)'/g)) if (isKey(m[1])) used.add(m[1]);
      for (const m of src.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)) if (isKey(m[1])) used.add(m[1]);
    }
    expect(used.size, 'no keys found - did the screens stop using i18n?').to.be.above(40);

    const missing = [];
    for (const key of used) {
      const occurrences = (i18nSource.match(new RegExp(`'${key.replace('.', '\\.')}':`, 'g')) || []).length;
      if (occurrences !== 2) missing.push(`${key} (${occurrences})`);
    }
    expect(missing, 'keys not defined in both languages').to.deep.equal([]);
  });
});

describe('Desktop tasks in the real Electron renderer', function () {
  this.timeout(60000);

  let result;

  before(async function () {
    if (!fs.existsSync(ELECTRON)) return this.skip();
    result = await runDesktop();
  });

  it('loads the app without a single uncaught error', () => {
    expect(result.errors, JSON.stringify(result.errors)).to.deep.equal([]);
  });

  it('opens Quick Create only on request, and remembers it', () => {
    expect(result.localStorageOk, 'localStorage is unavailable in this renderer').to.equal(true);
    expect(result.hiddenAtStart, 'the panel must be closed by default').to.equal(true);
    expect(result.ariaAtStart).to.equal('false');
    expect(result.storedAtStart).to.equal(null);
    expect(result.openAfterClick).to.equal(true);
    expect(result.ariaAfterClick).to.equal('true');
    expect(result.storedAfterClick).to.equal('true');
    expect(result.closedAfterSecondClick).to.equal(true);
    expect(result.ariaAfterSecondClick).to.equal('false');
    expect(result.quickRestoredOpen, 'a stored "open" must survive a restart').to.equal(true);
    expect(result.quickRestoredAria).to.equal('true');
  });

  it('previews each line with the schedule, the next run and any clash', () => {
    expect(result.previewCount).to.equal(3);
    expect(result.previewValidFlags).to.deep.equal([true, false, false]);
    expect(result.previewCronCalls, 'the cron must be validated through window.api').to.be.at.least(3);
    expect(result.previewDescribed).to.be.at.least(1);
    expect(result.previewNextRuns).to.be.at.least(1);
    expect(result.previewConflicts).to.be.at.least(1);
    expect(result.previewMeta[0]).to.include('Runs at minute 0');
    expect(result.previewMeta[0]).to.include('clashes with');
    expect(result.previewSyntaxBar).to.equal(true);
  });

  it('renders an invalid cron as text, not as markup', () => {
    expect(result.previewStatusText).to.include('99 99 * * *');
    expect(result.previewInjectedNodes).to.equal(0);
    expect(result.previewScriptText).to.include('.<b>');
  });

  it('creates only the lines that validated', () => {
    expect(result.createdCount).to.equal(1);
    expect(result.createdFields[0]).to.deep.equal({
      name: 'Backup noturno',
      cron: '0 5 * * *',
      script: 'C:\\Scripts\\backup.ps1',
      args: '-Full',
      description: 'saida',
    });
    expect(result.inputClearedAfterCreate).to.equal('');
  });

  it('keeps a Windows path and an apostrophe intact through the inline handler', () => {
    expect(result.loadedLineHasBackslashes, result.loadedLine).to.equal(true);
    expect(result.loadedLineHasApostrophe, result.loadedLine).to.equal(true);
    expect(result.loadedLine).to.include('0 5 * * * | ');
  });

  it('reloads the history, pages it, and keeps the rows from collapsing', () => {
    expect(result.historyRefetched).to.equal(true);
    expect(result.historyModalWide).to.equal(true);
    expect(result.historyRows).to.equal(50);
    expect(result.historyRowsAfterMore).to.equal(100);
    expect(result.historySummaryAfterMore, 'paging must not blank the summary')
      .to.deep.equal(['cron', 'script', 'next', 'runs', 'state']);
    expect(result.historyRowIsButton).to.equal(true);
    expect(result.historyRowHeight).to.be.above(20);
    expect(result.historyExpandHandlers).to.equal(0);
    expect(result.historyNoExpandClass).to.equal(0);
    expect(result.historySummary).to.deep.equal(['cron', 'script', 'next', 'runs', 'state']);
    expect(result.historyHelp).to.equal(true);
    expect(result.historyHasMore).to.equal(true);
  });

  it('opens the full run from a history row', () => {
    expect(result.detailTitle).to.include('Backup');
    expect(result.detailOutput).to.include('segunda linha');
    expect(result.detailFacts).to.deep.equal(['when', 'what', 'status', 'duration']);
  });

  it('opens the same detail from the dashboard activity row', () => {
    expect(result.activityRows).to.equal(10);
    expect(result.activityClickable).to.equal(true);
    expect(result.activityDetailTitle).to.include('Backup');
    expect(result.activityDetailFacts).to.deep.equal(['when', 'what', 'status', 'duration']);
    expect(result.activityDetailOutput).to.include('segunda linha');
  });

  it('opens the detail from the history screen too', () => {
    expect(result.historyScreenRows).to.equal(120);
    expect(result.historyScreenDetail).to.include('segunda linha');
    expect(result.historyScreenNoInlineHandler).to.equal(0);
  });

  it('scrolls the log table and opens the entry on click', () => {
    expect(result.logsScrollWrap).to.equal(true);
    expect(result.logRows).to.equal(1);
    expect(result.logRowIndexable).to.equal(1);
    expect(result.logNoExpandHandler).to.equal(0);
    expect(result.logDetailFacts).to.deep.equal(['when', 'level']);
    const blocks = (result.logDetailBlocks || []).join('\n');
    expect(blocks).to.include('Falha ao gravar o log');
    expect(blocks).to.include('EACCES denied');
  });

  it('shows the task dialog as four steps with a summary that follows the typing', () => {
    expect(result.dialogWide).to.equal(true);
    expect(result.dialogSteps).to.equal(4);
    expect(result.dialogSections).to.equal(4);
    expect(result.dialogHelp).to.equal(true);
    expect(result.dialogTooltips).to.be.at.least(6);
    expect(result.dialogStepLabels.every(l => l.length > 2)).to.equal(true);
    expect(result.dialogSummaryKeys).to.deep.equal(['name', 'cron', 'command', 'state']);
    expect(result.dialogSummaryName).to.equal('Backup do João');
    expect(result.dialogSummaryAfterTyping).to.equal('Backup renomeado');
  });
});
