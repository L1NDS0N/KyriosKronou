// tests/fixtures/desktop-ui-runner.js
//
// Drives app.js in the real Electron renderer: the quick create preview, the
// task history modal, the dashboard activity rows, the logs table and the task
// dialog. Everything asserted here is a behaviour that was broken before -
// the preview died on a CronParser that does not exist in the renderer, the
// history rows collapsed instead of scrolling, a Windows path lost its
// backslashes on the way into an inline handler, and the log cell grew on hover
// instead of opening the entry.

const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

// Phase 1 runs on a load with nothing stored: the panel must be closed, and
// the toggle must record the choice.
const TOGGLE_SCENARIO = `(() => {
  const out = {};
  const panel = document.getElementById('quick-create-panel');
  const toggle = document.getElementById('btn-toggle-quick');
  let localStorageOk = true;
  try { localStorage.setItem('__probe', '1'); localStorage.removeItem('__probe'); }
  catch (e) { localStorageOk = false; }

  out.localStorageOk = localStorageOk;
  out.hiddenAtStart = panel.classList.contains('hidden');
  out.ariaAtStart = toggle.getAttribute('aria-expanded');
  out.storedAtStart = localStorageOk ? localStorage.getItem('tasks.quickCreate') : null;

  toggle.click();
  out.openAfterClick = !panel.classList.contains('hidden');
  out.ariaAfterClick = toggle.getAttribute('aria-expanded');
  out.storedAfterClick = localStorageOk ? localStorage.getItem('tasks.quickCreate') : null;

  toggle.click();
  out.closedAfterSecondClick = panel.classList.contains('hidden');
  out.ariaAfterSecondClick = toggle.getAttribute('aria-expanded');
  out.errors = window.api.__errors.slice();
  return out;
})()`;

const SCENARIO = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = sel => document.querySelector(sel);
  const out = { errors: window.api.__errors.slice() };

  const waitFor = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const value = fn();
      if (value) return value;
      await sleep(25);
    }
    return null;
  };

  // Phase 2 starts from a load that found the panel open in storage, so the
  // restore path is the one under test.
  const panel = document.getElementById('quick-create-panel');
  out.quickRestoredOpen = !panel.classList.contains('hidden');
  out.quickRestoredAria = document.getElementById('btn-toggle-quick').getAttribute('aria-expanded');

  // ─── 2. Preview: cron validated through window.api, with description,
  //         next run and clash warnings, and errors escaped ───
  const before = window.api.__calls.filter(c => c.name === 'validateCron').length;
  const input = document.getElementById('quick-input');
  input.value = [
    '0 5 * * * | Backup noturno | C:\\\\Scripts\\\\backup.ps1 | -Full | saida',
    '99 99 * * * | Cron quebrado | C:\\\\Scripts\\\\outro.ps1',
    '0 6 * * * | Nome <img src=x onerror=alert(1)> | C:\\\\Scripts\\\\x.<b>',
  ].join('\\n');
  input.dispatchEvent(new Event('input'));

  await waitFor(() => document.querySelectorAll('.quick-preview-item').length === 3);
  await sleep(150);
  const items = [...document.querySelectorAll('.quick-preview-item')];
  out.previewCount = items.length;
  out.previewValidFlags = items.map(i => i.classList.contains('valid'));
  out.previewStatuses = items.map(i => i.querySelector('.qpi-status').textContent.trim());
  out.previewMeta = items.map(i => (i.querySelector('.qpi-meta') || {}).textContent || '');
  out.previewCronCalls = window.api.__calls.filter(c => c.name === 'validateCron').length - before;
  out.previewDescribed = window.api.__calls.filter(c => c.name === 'getCronDescription').length;
  out.previewNextRuns = window.api.__calls.filter(c => c.name === 'getNextRun').length;
  out.previewConflicts = window.api.__calls.filter(c => c.name === 'checkScheduleConflicts').length;
  // The failing line must render the word, not the markup it carries.
  out.previewInjectedNodes = document.querySelectorAll('#quick-preview img, #quick-preview b').length;
  out.previewScriptText = (items[2] && items[2].querySelector('.qpi-script') || {}).textContent || '';
  out.previewStatusText = out.previewStatuses[1];
  out.previewSyntaxBar = !!document.querySelector('#quick-syntax-bar .sb-field');
  out.previewStatusSummary = document.getElementById('quick-status').textContent.trim();

  // ─── 3. Create only what validated ───
  const created = [];
  const originalAdd = window.api.addTask;
  window.api.addTask = async (data) => { created.push(data); return originalAdd(data); };
  document.getElementById('btn-quick-create').click();
  await waitFor(() => created.length > 0);
  await sleep(120);
  out.createdCount = created.length;
  out.createdFields = created.map(c => ({ name: c.Name, cron: c.CronExpression, script: c.ScriptPath, args: c.Arguments, description: c.Description }));
  out.inputClearedAfterCreate = input.value;
  window.api.addTask = originalAdd;

  // ─── 4. A Windows path with a name containing an apostrophe survives the
  //         inline handler that loads an existing task into the editor ───
  allTasks = await window.api.getTasks();
  renderTasks();
  const quickRow = document.querySelector('#quick-tasks-list .quick-task-row');
  out.quickRowHandler = quickRow ? quickRow.getAttribute('onclick') : '';
  if (quickRow) quickRow.click();
  out.loadedLine = input.value;
  out.loadedLineHasBackslashes = input.value.includes('C:\\\\Scripts\\\\backup.ps1');
  out.loadedLineHasApostrophe = input.value.includes("Jo\\\\'o") || input.value.includes("Jo\'o") || input.value.includes("João");

  // ─── 5. Task history: refetched, paged, with a summary and a help line ───
  allHistory = [];
  const historyCallsBefore = window.api.__calls.filter(c => c.name === 'getHistory').length;
  await showTaskHistory('task-1');
  await sleep(120);
  out.historyModalWide = document.getElementById('modal-content').classList.contains('wizard-wide');
  out.historyRefetched = window.api.__calls.filter(c => c.name === 'getHistory').length > historyCallsBefore;
  out.historyRows = document.querySelectorAll('#task-history-list .th-entry').length;
  out.historyRowIsButton = !!document.querySelector('#task-history-list button.th-entry');
  out.historySummary = [...document.querySelectorAll('#task-history-summary .modal-summary-item')].map(i => i.getAttribute('data-summary'));
  out.historyHelp = !!document.querySelector('#modal-body .modal-help');
  out.historyHasMore = !!document.getElementById('task-history-more');
  out.historyFootNote = (document.querySelector('.modal-foot-note') || {}).textContent || '';
  // Rows must not collapse into each other inside the scroll container.
  const rowBox = document.querySelector('#task-history-list .th-entry');
  out.historyRowHeight = rowBox ? Math.round(rowBox.getBoundingClientRect().height) : 0;
  out.historyNoExpandClass = document.querySelectorAll('#task-history-list .th-expanded').length;
  out.historyExpandHandlers = document.querySelectorAll('#task-history-list [onclick*="th-expanded"]').length;

  document.getElementById('task-history-more').click();
  await sleep(60);
  out.historyRowsAfterMore = document.querySelectorAll('#task-history-list .th-entry').length;
  out.historySummaryAfterMore = [...document.querySelectorAll('#task-history-summary .modal-summary-item')].map(i => i.getAttribute('data-summary'));

  // A row opens the full entry.
  document.querySelector('#task-history-list .th-entry').click();
  await sleep(60);
  out.detailTitle = ($('#modal-body h2') || {}).textContent || '';
  out.detailOutput = ($('.run-detail-output .th-output-text') || {}).textContent || '';
  out.detailFacts = [...document.querySelectorAll('#modal-body .modal-summary-item')].map(i => i.getAttribute('data-summary'));
  hideModal();

  // ─── 6. Dashboard activity row opens the same detail ───
  await refreshDashboard();
  await sleep(120);
  const activityRow = document.querySelector('#recent-body tr');
  out.activityRows = document.querySelectorAll('#recent-body tr').length;
  out.activityClickable = activityRow ? activityRow.classList.contains('row-clickable') : false;
  if (activityRow) activityRow.click();
  await sleep(60);
  out.activityDetailTitle = ($('#modal-body h2') || {}).textContent || '';
  out.activityDetailFacts = [...document.querySelectorAll('#modal-body .modal-summary-item')].map(i => i.getAttribute('data-summary'));
  out.activityDetailOutput = ($('.run-detail-output .th-output-text') || {}).textContent || '';
  hideModal();

  // ─── 7. History screen: same detail for a task row ───
  await refreshHistory();
  await sleep(120);
  out.historyScreenRows = document.querySelectorAll('#history-body tr').length;
  const screenRow = document.querySelector('#history-body tr');
  if (screenRow) screenRow.click();
  await sleep(60);
  out.historyScreenDetail = ($('.run-detail-output .th-output-text') || {}).textContent || '';
  out.historyScreenNoInlineHandler = document.querySelectorAll('#history-body [onclick]').length;
  hideModal();

  // ─── 8. Logs: responsive wrapper, row opens a modal, no hover expansion ───
  await refreshLogs();
  await sleep(150);
  out.logsScrollWrap = !!document.querySelector('#logs-table-wrap .table-wrap.table-scroll[data-min="620"]');
  out.logRows = document.querySelectorAll('#logs-table-wrap tbody tr').length;
  out.logRowIndexable = document.querySelectorAll('#logs-table-wrap tbody tr[data-log-index]').length;
  out.logNoExpandHandler = document.querySelectorAll('#logs-table-wrap [onclick*="expanded"]').length;
  document.querySelector('#logs-table-wrap tbody tr').click();
  await sleep(60);
  out.logDetailFacts = [...document.querySelectorAll('#modal-body .modal-summary-item')].map(i => i.getAttribute('data-summary'));
  out.logDetailBlocks = [...document.querySelectorAll('.run-detail-output .th-output-text')].map(b => b.textContent);
  hideModal();

  // ─── 9. Task dialog: steps, tooltips, help and a live summary ───
  showTaskDialog(allTasks[0]);
  await sleep(80);
  out.dialogWide = document.getElementById('modal-content').classList.contains('wizard-wide');
  out.dialogSteps = document.querySelectorAll('#modal-body .modal-step').length;
  out.dialogStepLabels = [...document.querySelectorAll('#modal-body .modal-step')].map(s => s.textContent.trim());
  out.dialogHelp = !!document.querySelector('#modal-body .modal-help');
  out.dialogTooltips = document.querySelectorAll('#modal-body [data-tip]').length;
  out.dialogSummaryKeys = [...document.querySelectorAll('#task-dialog-summary .modal-summary-item')].map(i => i.getAttribute('data-summary'));
  out.dialogSummaryName = ($('#task-dialog-summary [data-summary="name"] .modal-summary-value') || {}).textContent || '';
  const nameField = document.getElementById('dlg-name');
  nameField.value = 'Backup renomeado';
  nameField.dispatchEvent(new Event('input'));
  out.dialogSummaryAfterTyping = ($('#task-dialog-summary [data-summary="name"] .modal-summary-value') || {}).textContent || '';
  out.dialogSections = document.querySelectorAll('#modal-body .form-section[data-step]').length;

  hideModal();
  out.errors = window.api.__errors.slice();
  return out;
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });

  const fixture = path.join(__dirname, 'desktop-ui.html');
  const settle = () => new Promise(resolve => setTimeout(resolve, 350));

  try {
    // Nothing stored: the panel has to come up closed.
    await win.loadFile(fixture);
    await settle();
    await win.webContents.executeJavaScript("localStorage.removeItem('tasks.quickCreate')");
    await win.loadFile(fixture);
    await settle();
    const toggleResult = await win.webContents.executeJavaScript(TOGGLE_SCENARIO);

    // Stored open: the panel has to come back the way it was left.
    await win.webContents.executeJavaScript("localStorage.setItem('tasks.quickCreate', 'true')");
    await win.loadFile(fixture);
    await settle();
    const result = await win.webContents.executeJavaScript(SCENARIO);

    process.stdout.write(`DESKTOP_UI_RESULT=${JSON.stringify(Object.assign(toggleResult, result))}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    app.exit(1);
  }
});
