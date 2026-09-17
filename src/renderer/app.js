// app.js - Frontend Application Logic (Enhanced UX)
let allTasks = [];
let allHistory = [];
let currentFilter = 'all';
let smartCron = null;
let autoRefreshTimer = null;


// ============================================================
// Stale-while-revalidate
// ============================================================
//
// Several screens fetch from the main process, and some of those calls are
// genuinely slow (the service control manager takes seconds). Blocking on them
// made the app feel frozen. This keeps the last result per key, paints it at
// once, then refetches in the background and repaints if anything changed.
//
//   swr('tasks', () => window.api.getTasks(), render)
//
const swrCache = new Map();   // key -> { data, at }
const swrInFlight = new Map(); // key -> Promise

async function swr(key, fetcher, render, options = {}) {
  const cached = swrCache.get(key);

  // Paint immediately from cache; the screen is never blank waiting.
  if (cached) {
    try { render(cached.data, { stale: true }); } catch (e) { console.error(e); }
  } else if (options.onLoading) {
    try { options.onLoading(); } catch (e) {}
  }

  // Never run the same fetch twice at once.
  if (swrInFlight.has(key)) return swrInFlight.get(key);

  const promise = (async () => {
    try {
      const data = await fetcher();
      const changed = !cached || JSON.stringify(cached.data) !== JSON.stringify(data);
      swrCache.set(key, { data, at: Date.now() });
      // Repaint only when something actually changed, so a background refresh
      // does not wipe the user's scroll position or hover state for nothing.
      if (changed || !cached) render(data, { stale: false });
      return data;
    } catch (err) {
      if (!cached && options.onError) options.onError(err);
      throw err;
    } finally {
      swrInFlight.delete(key);
    }
  })();

  swrInFlight.set(key, promise);
  return promise.catch(() => cached && cached.data);
}

/** Drop a cached entry after a mutation, so the next read refetches. */
function swrInvalidate(key) {
  if (key) swrCache.delete(key);
  else swrCache.clear();
}

// ============================================================
// Navigation
// ============================================================
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const page = btn.dataset.page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');
    const titleMap = { dashboard: 'dashboard.title', tasks: 'tasks.title', services: 'services.title', history: 'history.title', settings: 'settings.title', logs: 'logs.title', backup: 'Backups' };
    document.getElementById('page-title').textContent = i18n.t(titleMap[page] || page);
    refreshCurrentPage();
    lucide.createIcons();
  });
});

/**
 * Navigate programmatically (used by the dashboard's shortcuts).
 * Clicks the real nav button so the highlight, title and refresh all stay in
 * one place instead of being reimplemented here.
 */
function switchPage(page) {
  const btn = document.querySelector(`.nav-btn[data-page="${page}"]`);
  if (btn) btn.click();
}

// ============================================================
// Window Controls
// ============================================================
document.getElementById('btn-minimize').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-maximize').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

// ============================================================
// Loading State
// ============================================================
function setLoading(containerId, loading) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (loading) {
    el.style.opacity = '0.5';
    el.style.pointerEvents = 'none';
  } else {
    el.style.opacity = '1';
    el.style.pointerEvents = 'auto';
  }
}

// ============================================================
// Toast Notifications (with click dismiss)
// ============================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const iconMap = { info: 'info', success: 'check-circle', warning: 'alert-triangle', error: 'x-circle' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i data-lucide="${iconMap[type] || 'info'}"></i><span>${message}</span>`;
  toast.style.cursor = 'pointer';
  toast.title = 'Click to dismiss';
  toast.addEventListener('click', () => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 200); });
  container.appendChild(toast);
  lucide.createIcons({ nodes: [toast] });
  const timer = setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
  toast.addEventListener('click', () => clearTimeout(timer), { once: true });
}

// ============================================================
// Modal (with Escape and click-outside)
// ============================================================
function showModal(html, wide) {
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-content').classList.toggle('wizard-wide', !!wide);
  lucide.createIcons();
  // Any [data-path-input] inside the modal gets autocomplete, wired here so no
  // caller has to remember to do it.
  if (window.PathInput) PathInput.attachAll(document.getElementById('modal-body'));
  // Focus first input
  setTimeout(() => {
    const firstInput = document.querySelector('#modal-body input[type="text"], #modal-body textarea');
    if (firstInput) firstInput.focus();
  }, 100);
}
function hideModal() {
  if (window.PathInput) PathInput.close();
  document.getElementById('modal-overlay').classList.add('hidden');
  document.getElementById('modal-content').classList.remove('wizard-wide');
}
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) hideModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('modal-overlay');
    if (!modal.classList.contains('hidden')) { hideModal(); e.stopPropagation(); }
  }
});

// ============================================================
// Dashboard
// ============================================================
async function refreshDashboard() {
  setLoading('page-dashboard', true);
  try {
    allTasks = await window.api.getTasks();
    allHistory = await window.api.getHistory();

    let profiles = [];
    try { profiles = (await window.api.getBackupProfiles()) || []; } catch (e) {}

    let backupHistory = [];
    try {
      const bh = await window.api.getBackupHistory(null);
      backupHistory = bh.history || [];
    } catch (e) {}

    await renderSchedulerCard();

    // ─── Tasks ───
    const active = allTasks.filter(t => t.Enabled !== false).length;
    animateCounter('stat-active', active);
    const disabled = allTasks.length - active;
    document.getElementById('stat-active-sub').textContent =
      i18n.t('dash.totalCount', { n: allTasks.length })
      + (disabled > 0 ? ' \u00b7 ' + i18n.t('dash.disabledCount', { n: disabled }) : '');

    // ─── Backups ───
    const activeBackups = profiles.filter(p => p.Enabled).length;
    animateCounter('stat-backups', profiles.length);
    const lastBackup = profiles
      .filter(p => p.LastRun)
      .sort((a, b) => new Date(b.LastRun) - new Date(a.LastRun))[0];
    document.getElementById('stat-backups-sub').textContent = lastBackup
      ? i18n.t('dash.activeCount', { n: activeBackups }) + ' \u00b7 ' + i18n.t(lastBackup.LastStatus === 'Success' ? 'dash.lastOk' : 'dash.lastFailed')
      : i18n.t('dash.activeCount', { n: activeBackups }) + ' \u00b7 ' + i18n.t('dash.neverRun');

    // ─── Next run: the question an operator actually asks ───
    const next = await nextScheduled(allTasks, profiles);
    document.getElementById('stat-next').textContent = next ? next.when : '—';
    document.getElementById('stat-next-sub').textContent = next ? next.name : i18n.t('dash.nothingScheduled');

    // ─── Failures in the last 24h, across tasks and backups ───
    const since = Date.now() - 86400000;
    const taskErrors = allHistory.filter(h => h.Status === 'Error' && new Date(h.Timestamp).getTime() > since).length;
    const backupErrors = backupHistory.filter(h => h.Status !== 'Success' && new Date(h.Timestamp).getTime() > since).length;
    animateCounter('stat-errors', taskErrors + backupErrors);
    document.getElementById('stat-errors-sub').textContent =
      (taskErrors + backupErrors) === 0
        ? i18n.t('dash.allClear')
        : i18n.t('dash.failureBreakdown', { tasks: taskErrors, backups: backupErrors });

    // ─── Recent activity: tasks and backups on one timeline ───
    const rows = [];
    for (const h of allHistory.slice(0, 10)) {
      rows.push({ ts: h.Timestamp, what: h.TaskName, kind: i18n.t('dash.kindTask'), ok: h.Status === 'Success', status: h.Status, duration: h.Duration });
    }
    for (const h of backupHistory.slice(0, 10)) {
      rows.push({ ts: h.Timestamp, what: h.ProfileName, kind: i18n.t('dash.kindBackup'), ok: h.Status === 'Success', status: h.Status, duration: h.Duration });
    }
    rows.sort((a, b) => new Date(b.ts) - new Date(a.ts));

    const tbody = document.getElementById('recent-body');
    const empty = document.getElementById('recent-empty');
    if (!rows.length) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      tbody.innerHTML = rows.slice(0, 10).map(r =>
        '<tr>' +
        '<td>' + formatTime(r.ts) + '</td>' +
        '<td>' + escHtml(r.what || '-') + ' <span class="badge badge-info" style="font-size:9px">' + r.kind + '</span></td>' +
        '<td><span class="badge badge-' + (r.ok ? 'success' : 'error') + '">' + escHtml(r.status) + '</span></td>' +
        '<td>' + escHtml(r.duration || '-') + '</td>' +
        '</tr>').join('');
    }

    lucide.createIcons();
  } finally { setLoading('page-dashboard', false); }
}

/** Earliest upcoming run across tasks and backup profiles. */
async function nextScheduled(tasks, profiles) {
  const candidates = [];

  const add = async (name, cron) => {
    if (!cron) return;
    try {
      const next = await window.api.getNextRun(cron);
      if (next) candidates.push({ at: new Date(next), name: name });
    } catch (e) {}
  };

  for (const t of tasks) { if (t.Enabled !== false) await add(t.Name, t.CronExpression); }
  for (const p of profiles) { if (p.Enabled) await add(p.Name, p.CronExpression); }
  if (!candidates.length) return null;

  candidates.sort((a, b) => a.at - b.at);
  const soonest = candidates[0];
  const mins = Math.max(0, Math.round((soonest.at - Date.now()) / 60000));

  let when;
  if (mins < 1) when = i18n.t('dash.now');
  else if (mins < 60) when = i18n.t('dash.inMinutes', { n: mins });
  else if (mins < 1440) when = i18n.t('dash.inHours', { n: Math.round(mins / 60) });
  else when = soonest.at.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  return { when: when, name: soonest.name };
}

/**
 * The scheduler card.
 *
 * "Installed" is not the useful signal - a service can sit there reporting
 * Running with a dead scheduler, which was the original bug - so this reports
 * the heartbeat, and offers only the action that makes sense next instead of a
 * row of buttons that are mostly irrelevant.
 */
async function renderSchedulerCard() {
  const indicator = document.getElementById('sched-indicator');
  const title = document.getElementById('sched-title');
  const detail = document.getElementById('sched-detail');
  const actions = document.getElementById('sched-actions');
  if (!indicator) return;

  let status = {};
  try { status = await window.api.getKyrionServiceStatus(); } catch (e) { status = {}; }

  const btn = (id, label, cls) =>
    '<button class="' + (cls || 'btn-outline') + ' btn-sm" id="' + id + '">' + label + '</button>';

  const wire = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };

  if (!status.nssmAvailable) {
    indicator.className = 'sched-indicator warn';
    title.textContent = i18n.t('dash.schedRunningApp');
    detail.textContent = i18n.t('dash.schedNssmDetail');
    actions.innerHTML = btn('btn-dash-nssm', escHtml(i18n.t('dash.schedConfigureNssm')));
    wire('btn-dash-nssm', () => switchPage('settings'));
    return;
  }

  if (!status.installed) {
    indicator.className = 'sched-indicator warn';
    title.textContent = i18n.t('dash.schedRunningApp');
    detail.textContent = i18n.t('dash.schedRunningAppDetail');
    actions.innerHTML = btn('btn-dash-install', escHtml(i18n.t('dash.schedInstall')), 'btn-glow');
    wire('btn-dash-install', async () => {
      showToast(i18n.t('dash.schedInstalling'), 'info');
      const r = await window.api.installKyrionService();
      showToast(r.message, r.success ? 'success' : 'error');
      refreshDashboard();
    });
    return;
  }

  if (status.running && status.schedulerAlive) {
    indicator.className = 'sched-indicator ok';
    title.textContent = i18n.t('dash.schedActive');
    detail.textContent = i18n.t('dash.schedActiveDetail');
    actions.innerHTML = btn('btn-dash-restart', escHtml(i18n.t('dash.schedRestart')))
      + btn('btn-dash-remove', escHtml(i18n.t('dash.schedRemove')), 'btn-danger');
  } else if (status.running) {
    indicator.className = 'sched-indicator bad';
    title.textContent = i18n.t('dash.schedUnresponsive');
    detail.textContent = i18n.t(status.heartbeatStale ? 'dash.schedStaleDetail' : 'dash.schedPendingDetail');
    actions.innerHTML = btn('btn-dash-restart', escHtml(i18n.t('dash.schedRestart')), 'btn-glow')
      + btn('btn-dash-logs', escHtml(i18n.t('dash.schedViewLogs')));
  } else {
    indicator.className = 'sched-indicator bad';
    title.textContent = i18n.t('dash.schedStopped') + (status.status ? ' (' + status.status + ')' : '');
    detail.textContent = i18n.t('dash.schedStoppedDetail');
    actions.innerHTML = btn('btn-dash-start', escHtml(i18n.t('dash.schedStart')), 'btn-glow')
      + btn('btn-dash-remove', escHtml(i18n.t('dash.schedRemove')), 'btn-danger');
  }

  wire('btn-dash-restart', async () => {
    showToast(i18n.t('dash.schedRestarting'), 'info');
    const r = await window.api.restartKyrionService();
    showToast(r.message || (r.success ? 'OK' : 'Erro'), r.success ? 'success' : 'error');
    refreshDashboard();
  });
  wire('btn-dash-start', async () => {
    showToast(i18n.t('dash.schedStarting'), 'info');
    const r = await window.api.startKyrionService();
    showToast(r.message || (r.success ? 'OK' : 'Erro'), r.success ? 'success' : 'error');
    refreshDashboard();
  });
  wire('btn-dash-remove', async () => {
    if (!confirm(i18n.t('dash.schedRemoveConfirm'))) return;
    const r = await window.api.uninstallKyrionService();
    showToast(r.message, r.success ? 'success' : 'error');
    refreshDashboard();
  });
  wire('btn-dash-logs', () => switchPage('logs'));
}

// Smooth counter animation
function animateCounter(id, target) {
  const el = document.getElementById(id);
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  const diff = target - current;
  const steps = Math.min(Math.abs(diff), 10);
  const increment = diff / steps;
  let step = 0;
  const interval = setInterval(() => {
    step++;
    el.textContent = Math.round(current + increment * step);
    if (step >= steps) { el.textContent = target; clearInterval(interval); }
  }, 30);
}

// ============================================================
// Tasks
// ============================================================
async function refreshTasks() {
  await swr('tasks', () => window.api.getTasks(), (tasks) => {
    allTasks = tasks;
    renderTasks();
  });
}

// A run starting or ending changes the badges on whatever list is open.
document.addEventListener('kyrios-runs-changed', () => {
  const active = document.querySelector('.nav-btn.active');
  const page = active && active.dataset.page;
  if (page === 'tasks' && typeof renderTasks === 'function') renderTasks();
  if (page === 'backup' && window.backupPage) backupPage.render();
});

function renderTasks() {
  const search = document.getElementById('search-tasks').value.toLowerCase();
  const filtered = search ? allTasks.filter(t => t.Name.toLowerCase().includes(search) || (t.Description || '').toLowerCase().includes(search)) : allTasks;
  const list = document.getElementById('tasks-list');
  const empty = document.getElementById('tasks-empty');

  if (filtered.length === 0) { list.innerHTML = ''; empty.style.display = 'block'; lucide.createIcons(); return; }
  empty.style.display = 'none';

  list.innerHTML = filtered.map(t => {
    return `
    <div class="task-card ${t.Enabled ? '' : 'task-disabled'}" style="cursor:pointer">
      <div class="task-info" onclick="event.stopPropagation(); showTaskHistory('${t.Id}')">
        <div class="task-name">${escHtml(t.Name)}
          ${window.RunMonitor ? RunMonitor.runningBadge(t.Id) : ''}
          ${t.ScriptType ? `<span class="badge badge-info" style="font-size:9px;padding:1px 5px;">${t.ScriptType.toUpperCase()} inline</span>` : ''}
        </div>
        <div class="task-meta"><i data-lucide="clock"></i>${escHtml(t.CronExpression)}<span style="color:var(--text3)">|</span><i data-lucide="file-code"></i>${escHtml(t.ScriptPath || 'inline')}</div>
        ${t.Description ? `<div class="task-desc">${escHtml(t.Description)}</div>` : ''}
      </div>
      <div class="task-actions" onclick="event.stopPropagation()">
        <label class="toggle-switch" title="Enable/Disable" style="margin-right:4px">
          <input type="checkbox" ${t.Enabled ? 'checked' : ''} onchange="toggleTaskEnabled('${t.Id}', this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <button class="btn-glow btn-sm" onclick="runTask('${t.Id}')"><i data-lucide="play"></i>${i18n.t('tasks.run')}</button>
        <button class="btn-secondary-sm" onclick="editTask('${t.Id}')"><i data-lucide="pencil"></i>${i18n.t('tasks.edit')}</button>
        <button class="btn-danger" onclick="deleteTask('${t.Id}','${escHtml(t.Name)}')"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`;
  }).join('');
  lucide.createIcons();
  // Check service status for each task
  // Also render in quick panel
  renderQuickTasks();
}

document.getElementById('search-tasks').addEventListener('input', renderTasks);

// ─── Quick Create Panel ───
let quickPreviewTimer = null;
document.getElementById('btn-toggle-quick').addEventListener('click', () => {
  const panel = document.getElementById('quick-create-panel');
  panel.classList.toggle('hidden');
  lucide.createIcons();
  if (!panel.classList.contains('hidden')) {
    renderQuickTasks();
    document.getElementById('quick-input').focus();
  }
});

function renderQuickTasks() {
  const container = document.getElementById('quick-tasks-list');
  if (!container) return;
  if (allTasks.length === 0) { container.innerHTML = ''; return; }

  let html = `<div class="quick-tasks-header"><i data-lucide="list"></i> Existing Tasks <span class="quick-tasks-count">${allTasks.length}</span></div>`;
  html += allTasks.map(t => {
    const line = `${t.CronExpression} | ${t.Name} | ${t.ScriptPath || ''}${t.Arguments ? ' | ' + t.Arguments : ''}${t.Description ? ' | ' + t.Description : ''}`;
    return `
    <div class="quick-task-row" onclick="loadTaskToEditor('${escAttr(line)}', '${t.Id}')" title="Click to load into editor">
      <span class="qtr-dot ${t.Enabled ? 'active' : 'disabled'}"></span>
      <span class="qtr-name">${escHtml(t.Name)}</span>
      <span class="qtr-cron">${escHtml(t.CronExpression)}</span>
      <span class="qtr-script">${escHtml(t.ScriptPath)}</span>
      <span class="qtr-edit-hint"><i data-lucide="arrow-left" style="width:11px;height:11px;"></i> load</span>
    </div>`;
  }).join('');
  container.innerHTML = html;
  lucide.createIcons();
}

function loadTaskToEditor(line, taskId) {
  const textarea = document.getElementById('quick-input');
  if (!textarea) return;
  // If textarea already has content, append on new line
  const existing = textarea.value.trim();
  if (existing && !existing.endsWith('\n')) {
    textarea.value = existing + '\n' + line;
  } else {
    textarea.value = existing ? existing + line : line;
  }
  textarea.focus();
  // Trigger preview update
  textarea.dispatchEvent(new Event('input'));
  showToast('Task loaded into editor', 'info');
}

document.getElementById('quick-input').addEventListener('input', () => {
  clearTimeout(quickPreviewTimer);
  quickPreviewTimer = setTimeout(() => {
    const text = document.getElementById('quick-input').value;
    const parser = new CronParser();
    const results = parseQuickLines(text, parser);
    renderQuickPreview(results);
  }, 200);
});

document.getElementById('btn-quick-clear').addEventListener('click', () => {
  document.getElementById('quick-input').value = '';
  renderQuickPreview([]);
});

document.getElementById('btn-quick-create').addEventListener('click', async () => {
  const text = document.getElementById('quick-input').value;
  if (!text.trim()) { showToast('Enter at least one task', 'warning'); return; }
  const parser = new CronParser();
  const results = parseQuickLines(text, parser);
  const valid = results.filter(r => r.valid);
  if (valid.length === 0) { showToast('No valid tasks to create', 'error'); return; }

  let created = 0;
  for (const r of valid) {
    await window.api.addTask({
      Name: r.name,
      CronExpression: r.cron,
      ScriptPath: r.script,
      Arguments: r.args,
      Description: r.description,
      Enabled: true
    });
    created++;
  }
  showToast(`Created ${created} task${created > 1 ? 's' : ''}`, 'success');
  document.getElementById('quick-input').value = '';
  renderQuickPreview([]);
  refreshTasks();
  refreshDashboard();
});

document.getElementById('btn-new-task').addEventListener('click', () => showTaskDialog());
document.getElementById('btn-import').addEventListener('click', async () => {
  const r = await window.api.importTasks();
  if (r.success) { showToast(`Imported ${r.count} tasks`, 'success'); refreshTasks(); refreshDashboard(); }
  else if (r.message !== 'Cancelled') showToast(r.message, 'error');
});
document.getElementById('btn-export').addEventListener('click', async () => {
  const r = await window.api.exportTasks();
  if (r.success) showToast(i18n.t('toast.tasksExported'), 'success');
  else if (r.message !== 'Cancelled') showToast(r.message, 'error');
});

// Drag & drop import on tasks page
const tasksPage = document.getElementById('page-tasks');
tasksPage.addEventListener('dragover', (e) => { e.preventDefault(); tasksPage.style.outline = '2px dashed var(--primary)'; tasksPage.style.outlineOffset = '-4px'; });
tasksPage.addEventListener('dragleave', () => { tasksPage.style.outline = 'none'; });
tasksPage.addEventListener('drop', async (e) => {
  e.preventDefault();
  tasksPage.style.outline = 'none';
  const files = e.dataTransfer.files;
  if (files.length > 0 && files[0].name.endsWith('.json')) {
    // Use IPC to import from path
    showToast(`Dropping ${files[0].name}...`, 'info');
    const r = await window.api.importTasks();
    if (r.success) { showToast(`Imported ${r.count} tasks`, 'success'); refreshTasks(); refreshDashboard(); }
  } else {
    showToast('Drop a .json file to import tasks', 'warning');
  }
});

function showTaskDialog(task = null) {
  const isEdit = !!task;
  const cron = isEdit ? task.CronExpression : '* * * * *';
  const hasInline = isEdit && task.ScriptContent;
  const T = (k, p) => escHtml(i18n.t(k, p));

  // Grouped into sections - identity, schedule, what runs, options - so a long
  // form reads as four short ones instead of a wall of fields.
  showModal(`
    <h2>${isEdit
      ? `<i data-lucide="pencil"></i> ${T('taskModal.editTitle')}`
      : `<i data-lucide="plus-circle"></i> ${T('taskModal.newTitle')}`}</h2>

    <div class="form-section">
      <div class="form-group">
        <label class="form-label" for="dlg-name">${T('taskModal.name')} *</label>
        <input type="text" class="form-input" id="dlg-name" value="${isEdit ? escAttr(task.Name) : ''}" placeholder="${T('taskModal.namePlaceholder')}">
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title"><i data-lucide="clock"></i> ${T('taskModal.scheduleSection')}</div>
      <div id="smart-cron-container"></div>
    </div>

    <div class="form-section">
      <div class="form-section-title"><i data-lucide="terminal"></i> ${T('taskModal.whatSection')}</div>
      <div class="script-mode-tabs">
        <button class="script-mode-tab ${!hasInline ? 'active' : ''}" id="tab-file" onclick="scriptEditorSwitchMode('file')">
          <i data-lucide="file-input"></i> ${T('taskModal.tabFile')}
        </button>
        <button class="script-mode-tab ${hasInline ? 'active' : ''}" id="tab-editor" onclick="scriptEditorSwitchMode('editor')">
          <i data-lucide="code-2"></i> ${T('taskModal.tabEditor')}
        </button>
      </div>

      <div id="script-mode-file">
        <div class="input-row">
          <input type="text" class="form-input" id="dlg-script" data-path-input data-path-kind="file" data-path-ext=".ps1,.bat,.cmd,.exe,.vbs,.py" value="${isEdit ? escAttr(task.ScriptPath || '') : ''}" placeholder="C:\\Scripts\\backup.ps1">
          <button class="btn-outline" onclick="browseScript()"><i data-lucide="folder-open"></i> ${T('taskModal.browse')}</button>
        </div>
        <div class="form-hint">${i18n.t('taskModal.supported', {
          ps1: '<code>.ps1</code>', bat: '<code>.bat</code>', cmd: '<code>.cmd</code>', exe: '<code>.exe</code>',
        })}</div>
      </div>

      <div id="script-mode-editor" style="display:none">
        <div id="dialog-script-editor"></div>
        <div id="script-file-path" class="script-path-display" style="display:none"></div>
      </div>

      <div class="form-row" style="margin-top:14px">
        <div class="form-group">
          <label class="form-label" for="dlg-args">${T('taskModal.arguments')}</label>
          <input type="text" class="form-input" id="dlg-args" value="${isEdit ? escAttr(task.Arguments || '') : ''}" placeholder="${T('taskModal.argumentsPlaceholder')}">
        </div>
        <div class="form-group">
          <label class="form-label" for="dlg-workdir">${T('taskModal.workdir')}</label>
          <input type="text" class="form-input" id="dlg-workdir" data-path-input data-path-kind="directory" value="${isEdit ? escAttr(task.WorkingDirectory || '') : ''}" placeholder="${T('taskModal.optional')}">
        </div>
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title"><i data-lucide="settings-2"></i> ${T('taskModal.optionsSection')}</div>
      <div class="form-group">
        <label class="form-label" for="dlg-desc">${T('taskModal.description')}</label>
        <textarea class="form-input" id="dlg-desc" placeholder="${T('taskModal.descriptionPlaceholder')}">${isEdit ? escHtml(task.Description || '') : ''}</textarea>
      </div>
      <label class="check-row" for="dlg-enabled">
        <input type="checkbox" id="dlg-enabled" ${isEdit && !task.Enabled ? '' : 'checked'}>
        <span>${T('taskModal.enabled')}
          <span class="check-hint">${T('taskModal.enabledHint')}</span>
        </span>
      </label>
    </div>

    <div class="modal-actions">
      <button class="btn-ghost" onclick="hideModal()">${T('taskModal.cancel')}</button>
      <button class="btn-glow" id="btn-save-task" onclick="saveTask(${isEdit ? `'${task.Id}'` : 'null'})">${isEdit
        ? `<i data-lucide="save"></i> ${T('taskModal.save')}`
        : `<i data-lucide="plus"></i> ${T('taskModal.create')}`}</button>
    </div>
  `);

  // Smart cron
  smartCron = new SmartCronInput('#smart-cron-container', { value: cron });

  // Script editor
  if (hasInline) {
    scriptEditorSwitchMode('editor');
    setTimeout(() => {
      scriptEditor.init('dialog-script-editor');
      scriptEditor.loadContent(task.ScriptContent, task.ScriptType || 'ps1');
    }, 50);
  }

  // Enter to save
  document.getElementById('dlg-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btn-save-task').click(); });
  lucide.createIcons();
}

// Script mode switching
let _scriptMode = 'file';


function scriptEditorSwitchMode(mode) {
  _scriptMode = mode;
  document.getElementById('tab-file').classList.toggle('active', mode === 'file');
  document.getElementById('tab-editor').classList.toggle('active', mode === 'editor');
  document.getElementById('script-mode-file').style.display = mode === 'file' ? '' : 'none';
  document.getElementById('script-mode-editor').style.display = mode === 'editor' ? '' : 'none';

  if (mode === 'editor' && !scriptEditor.editor) {
    setTimeout(() => {
      scriptEditor.init('dialog-script-editor');
      lucide.createIcons();
    }, 50);
  }
}

async function saveTask(editId) {
  const name = document.getElementById('dlg-name').value.trim();
  if (!name) { showToast(i18n.t('toast.taskNameRequired'), 'error'); document.getElementById('dlg-name').focus(); return; }
  if (!smartCron || !smartCron.isValid()) { showToast(i18n.t('toast.invalidCron'), 'error'); return; }
  const cron = smartCron.getValue();

  let scriptPath = '';
  let scriptContent = '';
  let scriptType = '';

  if (_scriptMode === 'editor') {
    // Inline script mode
    const content = scriptEditor.getContent().trim();
    if (!content) { showToast(i18n.t('toast.scriptContentRequired'), 'error'); return; }
    scriptContent = content;
    scriptType = scriptEditor.getMode();
    const ext = scriptEditor.getExtension();

    // Save script to managed directory
    const scriptsDir = await window.api.getScriptsDir();
    const taskId = editId || 'task-' + Date.now();
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
    const scriptFile = `${safeName}_${taskId.substring(0, 8)}${ext}`;
    scriptPath = `${scriptsDir}\${scriptFile}`;

    const saveResult = await window.api.saveScriptFile(scriptPath, content);
    if (!saveResult.success) {
      showToast(`Failed to save script: ${saveResult.message}`, 'error');
      return;
    }
  } else {
    // File path mode
    scriptPath = document.getElementById('dlg-script').value.trim();
    if (!scriptPath) { showToast(i18n.t('toast.scriptPathRequired'), 'error'); document.getElementById('dlg-script').focus(); return; }
  }

  const data = {
    Name: name, CronExpression: cron, ScriptPath: scriptPath,
    ScriptContent: scriptContent, ScriptType: scriptType,
    Arguments: document.getElementById('dlg-args').value,
    WorkingDirectory: document.getElementById('dlg-workdir').value,
    Description: document.getElementById('dlg-desc').value,
    Enabled: document.getElementById('dlg-enabled').checked
  };

  const btn = document.getElementById('btn-save-task');
  btn.disabled = true; btn.style.opacity = '0.5';

  if (editId) {
    data.Id = editId;
    await window.api.updateTask(data);
    swrInvalidate('tasks'); showToast(i18n.t('toast.taskUpdated'), 'success');
  } else {
    await window.api.addTask(data);
    swrInvalidate('tasks'); showToast(i18n.t('toast.taskCreated'), 'success');
  }
  scriptEditor.destroy();
  hideModal();
  refreshTasks();
  refreshDashboard();
}

async function showTaskHistory(taskId) {
  const task = allTasks.find(t => t.Id === taskId);
  if (!task) return;
  // Ensure history is loaded
  if (!allHistory || allHistory.length === 0) {
    allHistory = await window.api.getHistory();
  }
  const entries = allHistory.filter(h => h.TaskId === taskId);

  const statusIcon = (s) => s === 'Success' ? '<span style="color:var(--green)">&#10003;</span>' : '<span style="color:var(--red)">&#10007;</span>';
  const fmtTime = (ts) => {
    try { const d = new Date(ts); return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR'); } catch { return ts; }
  };

  const rows = entries.length > 0 ? entries.map((e, i) => `
    <div class="th-entry" onclick="this.classList.toggle('th-expanded')">
      <div class="th-row">
        <span class="th-icon">${statusIcon(e.Status)}</span>
        <span class="th-time">${fmtTime(e.Timestamp)}</span>
        <span class="th-duration">${e.Duration || '-'}</span>
        <span class="th-status badge badge-${e.Status === 'Success' ? 'active' : 'badge-disabled'}">${e.Status}</span>
        <i data-lucide="chevron-down" class="th-chevron"></i>
      </div>
      <div class="th-output">
        <div class="th-output-label">Output / Error</div>
        <pre class="th-output-text">${escHtml(e.Message || 'No output')}</pre>
      </div>
    </div>
  `).join('') : '<div style="text-align:center;padding:24px;color:var(--text3)"><i data-lucide="history" style="width:32px;height:32px;margin-bottom:8px;opacity:.3"></i><p>No execution history yet</p></div>';

  showModal(`
    <h2><i data-lucide="history"></i> ${escHtml(task.Name)} - History</h2>
    <div style="display:flex;gap:12px;margin:8px 0 12px;font-size:11px;color:var(--text3)">
      <span>Cron: <code style="color:var(--text2)">${escHtml(task.CronExpression)}</code></span>
      <span>Script: <code style="color:var(--text2)">${escHtml(task.ScriptPath || 'inline')}</code></span>
      <span>Entries: <strong style="color:var(--text2)">${entries.length}</strong></span>
    </div>
    <div class="task-history-list" style="max-height:400px;overflow-y:auto">
      ${rows}
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="hideModal()">Close</button>
      ${entries.length > 0 ? `<button class="btn-outline btn-sm" onclick="exportTaskHistory('${taskId}')"><i data-lucide="download"></i> Export CSV</button>` : ''}
    </div>
  `);
  lucide.createIcons();
}

function exportTaskHistory(taskId) {
  const entries = allHistory.filter(h => h.TaskId === taskId);
  if (entries.length === 0) return;
  const header = 'Timestamp,Status,Duration,Message\n';
  const rows = entries.map(e => {
    const msg = (e.Message || '').replace(/"/g, '""').replace(/\n/g, ' ');
    return `"${e.Timestamp}","${e.Status}","${e.Duration}","${msg}"`;
  }).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `task-history-${taskId}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function editTask(id) {
  const task = allTasks.find(t => t.Id === id);
  if (task) showTaskDialog(task);
}

async function deleteTask(id, name) {
  showModal(`
    <h2><i data-lucide="alert-triangle"></i> Delete Task</h2>
    <p style="color:var(--text2);font-size:14px;margin-top:8px;">Are you sure you want to delete "<strong style="color:var(--text)">${escHtml(name)}</strong>"?<br>This action cannot be undone.</p>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn-danger" onclick="confirmDelete('${id}')"><i data-lucide="trash-2"></i> Delete</button>
    </div>
  `);
}

async function confirmDelete(id) {
  await window.api.deleteTask(id);
  hideModal();
  swrInvalidate('tasks'); showToast(i18n.t('toast.taskDeleted'), 'success');
  refreshTasks();
  refreshDashboard();
}

// ─── Service Deploy (NSSM per task) ───
async function checkTaskServiceStatus(taskId) {
  const badge = document.getElementById(`badge-svc-${taskId}`);
  const btn = document.getElementById(`btn-deploy-${taskId}`);
  if (!badge) return;

  try {
    const status = await window.api.getTaskServiceStatus(taskId);
    if (status.nssmAvailable === false) {
      // NSSM not installed — hide deploy button
      badge.className = 'badge badge-service-off';
      badge.innerHTML = '<i data-lucide="package"></i> NSSM needed';
      if (btn) { btn.style.display = 'none'; }
    } else if (status.installed) {
      const isRunning = status.status === 'Running';
      badge.className = `badge ${isRunning ? 'badge-service-running' : 'badge-service-stopped'}`;
      const statusLabel = isRunning ? 'Running' : (status.status === 'Stopped' ? 'Stopped' : status.status || 'Unknown');
      badge.innerHTML = `<i data-lucide="${isRunning ? 'check-circle' : 'circle-dot'}"></i> ${status.serviceName} (${statusLabel})`;
      badge.title = `Service: ${status.serviceName} — Click to view logs`;
      badge.style.cursor = isRunning ? 'default' : 'pointer';
      badge.onclick = isRunning ? null : async () => {
        try {
          const logResult = await window.api.readServiceLog(taskId);
          const task = allTasks.find(t => t.Id === taskId);
          showModal(`
            <h2><i data-lucide="file-text"></i> Service Log — ${escHtml(task ? task.Name : taskId)}</h2>
            <div class="form-group">
              <label class="form-label">Status: <span class="badge badge-service-stopped">${statusLabel}</span> | Service: <code>${status.serviceName}</code></label>
              <label class="form-label">Wrapper: <code style="font-size:11px;">${status.wrapperPath || 'N/A'}</code></label>
            </div>
            <div class="service-log-content">
              <pre class="service-log-pre">${escHtml(logResult.content || 'No logs yet. The service may not have started.\n\nPossible causes:\n1. PowerShell execution policy blocking the script\n2. Script path contains special characters\n3. NSSM cannot find powershell.exe\n4. The wrapper script crashed immediately')}</pre>
            </div>
            <div class="modal-actions">
              <button class="btn-ghost" onclick="hideModal()">Close</button>
              <button class="btn-glow" onclick="restartServiceFromBadge('${status.serviceName}')"><i data-lucide="rotate-cw"></i> Restart</button>
            </div>
          `);
          lucide.createIcons();
        } catch (e) {
          showToast('Failed to read service log', 'error');
        }
      };
      if (btn) {
        if (!isRunning) {
          btn.className = 'btn-secondary-sm';
          btn.innerHTML = '<i data-lucide="play"></i>Start';
          btn.onclick = async () => {
            btn.disabled = true;
            const r = await window.api.startService(status.serviceName);
            showToast(r.message, r.success ? 'success' : 'error');
            btn.disabled = false;
            checkTaskServiceStatus(taskId);
          };
        } else {
          btn.className = 'btn-secondary-sm btn-undeploy';
          btn.innerHTML = '<i data-lucide="package-minus"></i>Undeploy';
          btn.onclick = null;
        }
        btn.style.display = '';
      }
    } else {
      badge.className = 'badge badge-service-off';
      badge.innerHTML = '<i data-lucide="package"></i> No Service';
      if (btn) {
        btn.className = 'btn-secondary-sm btn-deploy';
        btn.innerHTML = '<i data-lucide="package-plus"></i>Deploy';
        btn.style.display = '';
      }
    }
    lucide.createIcons();
  } catch (e) {
    badge.style.display = 'none';
  }
}

async function toggleDeploy(taskId) {
  const task = allTasks.find(t => t.Id === taskId);
  if (!task) return;

  const btn = document.getElementById(`btn-deploy-${taskId}`);
  const badge = document.getElementById(`badge-svc-${taskId}`);

  try {
    // Check current status
    const status = await window.api.getTaskServiceStatus(taskId);

    if (status.installed) {
      // Undeploy
      if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader"></i> Removing...'; lucide.createIcons(); }
      const result = await window.api.undeployTaskService(task);
      if (result.success) {
        showToast(`Service removed for "${task.Name}"`, 'success');
      } else {
        showToast(`Failed to remove: ${result.message}`, 'error');
      }
    } else {
      // Deploy
      if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader"></i> Deploying...'; lucide.createIcons(); }
      showToast(`Deploying "${task.Name}" as NSSM service...`, 'info');
      try {
        const result = await window.api.deployTaskService(task);
        if (result.success) {
          showToast(`"${task.Name}" deployed as service: ${result.serviceName}`, 'success');
        } else {
          showToast(`Deploy failed: ${result.message}`, 'error');
        }
      } catch (deployErr) {
        showToast(`Deploy error: ${deployErr.message || 'Unknown error'}`, 'error');
      }
    }
  } catch (err) {
    showToast(`Error: ${err.message || 'Unknown error'}`, 'error');
  }

  // Refresh status
  if (btn) { btn.disabled = false; }
  checkTaskServiceStatus(taskId);
  refreshServices();
  refreshDashboard();
}

async function toggleTaskEnabled(id, enabled) {
  const task = allTasks.find(t => t.Id === id);
  if (!task) return;
  task.Enabled = enabled;
  await window.api.updateTask(task);
  showToast(`${task.Name} ${enabled ? 'enabled' : 'disabled'}`, 'info');
  renderTasks();
  refreshDashboard();
}

async function runTask(id) {
  const task = allTasks.find(t => t.Id === id);
  if (!task) return;
  showToast(`Running "${task.Name}"...`, 'info');
  const result = await window.api.executeTask(task);
  showToast(`"${task.Name}": ${result.Status} (${result.Duration})`, result.Status === 'Success' ? 'success' : 'error');
  refreshTasks();
  refreshDashboard();
  refreshHistory();
}

// ============================================================
// Services
// ============================================================
// ─── Services list, stale-while-revalidate ───
//
// Querying the service control manager takes seconds (several NSSM calls per
// service), and blocking the screen on every visit made it feel frozen. The
// last result is kept and painted immediately, then refreshed in the
// background and swapped in - the list is usable while the real data arrives.
let servicesCache = null;
let servicesFetching = false;

function renderServicesTable(services) {
  const tbody = document.getElementById('services-body');
  const empty = document.getElementById('services-empty');
  if (!tbody) return;

  const filterManaged = document.getElementById('filter-managed-only').checked;
  const list = filterManaged
    ? services.filter(s => s.Name && (s.Name.startsWith('Kyrion_') || s.Name.startsWith('KyrionBackup_')))
    : services;

  if (!list.length) {
    tbody.innerHTML = '';
    if (empty) empty.style.display = 'block';
    lucide.createIcons();
    return;
  }
  if (empty) empty.style.display = 'none';

  tbody.innerHTML = list.map(s => {
    const isRunning = s.Status === 'Running';
    const isManaged = s.Name && s.Name.startsWith('Kyrion_');
    const cls = ['svc-row', isManaged ? 'kyrion-managed' : ''].filter(Boolean).join(' ');
    return `<tr class="${cls}" onclick="editServiceScript('${escAttr(s.Name)}')" title="${escHtml(i18n.t('svc.clickToEdit'))}">
      <td>${escHtml(s.Name)}${isManaged ? `<span class="badge badge-info" style="font-size:9px;margin-left:6px">${escHtml(i18n.t('svc.managed'))}</span>` : ''}</td>
      <td><span class="badge badge-${isRunning ? 'success' : 'error'}">${escHtml(s.Status)}</span></td>
      <td>${escHtml(s.Application || '-')}</td>
      <td>${escHtml(s.StartupType)}</td>
      <td onclick="event.stopPropagation()">
        ${!isRunning ? `<button class="btn-secondary-sm" onclick="svcAction('start','${escAttr(s.Name)}')" title="${escHtml(i18n.t('svc.start'))}"><i data-lucide="play"></i></button>` : ''}
        ${isRunning ? `<button class="btn-secondary-sm" onclick="svcAction('stop','${escAttr(s.Name)}')" title="${escHtml(i18n.t('svc.stop'))}"><i data-lucide="square"></i></button>` : ''}
        <button class="btn-secondary-sm" onclick="svcAction('restart','${escAttr(s.Name)}')" title="${escHtml(i18n.t('svc.restart'))}"><i data-lucide="rotate-cw"></i></button>
        <button class="btn-secondary-sm" onclick="cloneService('${escAttr(s.Name)}')" title="${escHtml(i18n.t('svc.clone'))}"><i data-lucide="copy"></i></button>
        <button class="btn-danger" onclick="svcAction('uninstall','${escAttr(s.Name)}')" title="${escHtml(i18n.t('svc.remove'))}"><i data-lucide="trash-2"></i></button>
      </td>
    </tr>`;
  }).join('');
  lucide.createIcons();
}

/** Escape a value being embedded in a single-quoted inline handler. */
function escAttr(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function setServicesRefreshing(on) {
  const badge = document.getElementById('services-refreshing');
  if (badge) badge.style.display = on ? '' : 'none';
}

async function refreshServices({ force = false } = {}) {
  // Paint whatever we already have, so the screen is never blank or frozen.
  if (servicesCache) renderServicesTable(servicesCache);
  else {
    const tbody = document.getElementById('services-body');
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="tbl-loading">
      <i data-lucide="loader-circle"></i>${escHtml(i18n.t('svc.loading'))}</td></tr>`;
    lucide.createIcons();
  }

  refreshKyrionBanner();

  if (servicesFetching && !force) return;
  servicesFetching = true;
  setServicesRefreshing(true);

  try {
    const services = await window.api.getServices();
    servicesCache = services;
    renderServicesTable(services);
  } catch (err) {
    if (!servicesCache) {
      const tbody = document.getElementById('services-body');
      if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="tbl-empty">Erro: ${escHtml(err.message)}</td></tr>`;
    }
  } finally {
    servicesFetching = false;
    setServicesRefreshing(false);
  }
}

/** The banner above the table, refreshed independently of the list. */
async function refreshKyrionBanner() {
  const bannerStatus = document.getElementById('kyrion-svc-banner-status');
  const bannerBtn = document.getElementById('btn-kyrion-svc-toggle');
  if (!bannerStatus) return;

  try {
    const s = await window.api.getKyrionServiceStatus();
    if (s.installed) {
      const running = s.status === 'Running';
      const alive = running && s.schedulerAlive;
      bannerStatus.innerHTML = `<span style="color:${alive ? 'var(--green)' : running ? 'var(--amber)' : 'var(--red)'}">\u25cf ${escHtml(s.status)}</span>`
        + (running && !alive ? ' \u2014 ' + escHtml(i18n.t('svc.schedulerUnresponsive')) : '')
        + ` \u2014 ${escHtml(s.serviceName)}`;
      bannerBtn.style.display = '';
      bannerBtn.textContent = running ? i18n.t('svc.stop') : i18n.t('svc.start');
      bannerBtn.onclick = async () => {
        const r = running ? await window.api.stopKyrionService() : await window.api.startKyrionService();
        showToast(r.message || (r.success ? 'OK' : 'Erro'), r.success ? 'success' : 'error');
        refreshServices({ force: true });
      };
    } else if (s.nssmAvailable) {
      bannerStatus.textContent = i18n.t('svc.notInstalled');
      bannerBtn.style.display = '';
      bannerBtn.textContent = i18n.t('svc.install');
      bannerBtn.onclick = async () => {
        showToast(i18n.t('dash.schedInstalling'), 'info');
        const r = await window.api.installKyrionService();
        showToast(r.message, r.success ? 'success' : 'error');
        refreshServices({ force: true });
      };
    } else {
      bannerStatus.textContent = i18n.t('svc.nssmMissing');
      bannerBtn.style.display = 'none';
    }
  } catch (e) {
    bannerStatus.textContent = i18n.t('svc.statusFailed');
  }
}

/**
 * Duplicate a Windows service: read the original's configuration and install a
 * new one with the same executable, arguments and working directory. The copy
 * starts Manual so a clone made for editing cannot start competing with the
 * original before it has been reviewed.
 */
async function cloneService(serviceName) {
  const suggested = nextServiceCopyName(serviceName);
  const newName = prompt(i18n.t('svc.clonePrompt', { name: serviceName }), suggested);
  if (!newName || !newName.trim()) return;

  const name = newName.trim();
  if (servicesCache && servicesCache.some(s => s.Name.toLowerCase() === name.toLowerCase())) {
    showToast(i18n.t('svc.cloneExists', { name }), 'error');
    return;
  }

  showToast(i18n.t('svc.cloneReading'), 'info');
  const source = await window.api.getServiceParams(serviceName);
  if (!source.success) {
    showToast(source.message || i18n.t('svc.cloneFailed'), 'error');
    return;
  }

  const p = source.params || {};
  showToast(i18n.t('svc.cloneCreating', { name }), 'info');
  const result = await window.api.installService({
    name,
    appPath: p.Application,
    args: p.AppParameters || '',
    workDir: p.AppDirectory || '',
    // Manual on purpose: a fresh copy should not start on its own.
    startupType: 'Manual',
  });

  if (result.success) {
    showToast(i18n.t('svc.cloneCreated', { name }), 'success');
    servicesCache = null;
    await refreshServices({ force: true });
    editServiceScript(name);
  } else {
    showToast(result.message || i18n.t('svc.cloneFailed'), 'error');
  }
}

function nextServiceCopyName(baseName) {
  const base = String(baseName || 'Service').replace(/_copy(\d+)?$/i, '');
  const taken = new Set((servicesCache || []).map(s => s.Name.toLowerCase()));
  let candidate = `${base}_copy`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${base}_copy${n++}`;
  return candidate;
}

// Managed-only filter toggle
const filterManagedEl = document.getElementById('filter-managed-only');
// Restore saved state from localStorage
if (localStorage.getItem('services.filterManaged') !== null) {
  filterManagedEl.checked = localStorage.getItem('services.filterManaged') === 'true';
}
filterManagedEl.addEventListener('change', () => {
  localStorage.setItem('services.filterManaged', String(filterManagedEl.checked));
  refreshServices();
});


async function restartServiceFromBadge(serviceName) {
  hideModal();
  showToast(`Restarting ${serviceName}...`, 'info');
  const r = await window.api.restartService(serviceName);
  showToast(r.message, r.success ? 'success' : 'error');
  refreshTasks();
  refreshDashboard();
}
async function editServiceScript(serviceName) {
  showToast(i18n.t('service.loadingScript'), 'info');
  const result = await window.api.getServiceParams(serviceName);
  if (!result.success) { showToast(result.message || 'Service not found', 'error'); return; }
  const p = result.params;

  const startupMap = { 'SERVICE_AUTO_START': 'Automatic', 'SERVICE_DEMAND_START': 'Manual', 'SERVICE_DISABLED': 'Disabled' };
  const currentStartup = Object.keys(startupMap).find(k => p.Start?.includes(k)) || 'SERVICE_AUTO_START';

  showModal(`
    <h2><i data-lucide="settings"></i> Edit Service — ${escHtml(serviceName)}</h2>
    <p style="font-size:12px;color:var(--text2);margin-bottom:12px">Configure NSSM service parameters. Change name to rename (removes and reinstalls).</p>

    <div class="svc-edit-tabs">
      <button class="svc-edit-tab active" onclick="showSvcTab('app')" id="stab-app"><i data-lucide="terminal"></i> Application</button>
      <button class="svc-edit-tab" onclick="showSvcTab('details')" id="stab-details"><i data-lucide="file-text"></i> Details</button>
      <button class="svc-edit-tab" onclick="showSvcTab('logging')" id="stab-logging"><i data-lucide="scroll-text"></i> Logging</button>
      <button class="svc-edit-tab" onclick="showSvcTab('rename')" id="stab-rename"><i data-lucide="pen-line"></i> Rename</button>
    </div>

    <div id="svc-tab-app" class="svc-tab-content">
      <label class="form-label">Application Path *</label>
      <div class="input-row">
        <input type="text" class="form-input" id="se-path" value="${escAttr(p.Application || '')}" style="flex:1">
        <button class="btn-outline btn-sm" onclick="browseSvcPath('se-path')"><i data-lucide="folder-open"></i></button>
      </div>
      <label class="form-label">Startup Directory</label>
      <div class="input-row">
        <input type="text" class="form-input" id="se-dir" value="${escAttr(p.AppDirectory || '')}" style="flex:1">
        <button class="btn-outline btn-sm" onclick="browseSvcPath('se-dir')"><i data-lucide="folder-open"></i></button>
      </div>
      <label class="form-label">Arguments</label>
      <input type="text" class="form-input" id="se-args" value="${escAttr(p.AppParameters || '')}">
    </div>

    <div id="svc-tab-details" class="svc-tab-content" style="display:none">
      <label class="form-label">Display Name</label>
      <input type="text" class="form-input" id="se-display" value="${escAttr(p.DisplayName || '')}">
      <label class="form-label">Description</label>
      <input type="text" class="form-input" id="se-desc" value="${escAttr(p.Description || '')}">
      <label class="form-label">Startup Type</label>
      <select class="form-input" id="se-startup">
        <option value="SERVICE_AUTO_START" ${currentStartup==='SERVICE_AUTO_START'?'selected':''}>Automatic</option>
        <option value="SERVICE_DEMAND_START" ${currentStartup==='SERVICE_DEMAND_START'?'selected':''}>Manual</option>
        <option value="SERVICE_DISABLED" ${currentStartup==='SERVICE_DISABLED'?'selected':''}>Disabled</option>
      </select>
    </div>

    <div id="svc-tab-logging" class="svc-tab-content" style="display:none">
      <label class="form-label">Stdout Log File</label>
      <input type="text" class="form-input" id="se-stdout" value="${escAttr(p.AppStdout || '')}" placeholder="C:\logs\service-out.log">
      <label class="form-label">Stderr Log File</label>
      <input type="text" class="form-input" id="se-stderr" value="${escAttr(p.AppStderr || '')}" placeholder="C:\logs\service-err.log">
      <div class="checkbox-row" style="margin-top:8px">
        <input type="checkbox" id="se-rotate" ${p.AppRotateFiles === '1' || p.AppRotateFiles === 1 ? 'checked' : ''}>
        <label for="se-rotate">Rotate log files</label>
      </div>
      <div class="form-group" style="margin-top:6px"><label class="form-label">Rotate after (bytes)</label><input type="number" class="form-input" id="se-rotatebytes" value="${escAttr(p.AppRotateBytes || '0')}"></div>
    </div>

    <div id="svc-tab-rename" class="svc-tab-content" style="display:none">
      <label class="form-label">Current Name</label>
      <input type="text" class="form-input" value="${escAttr(serviceName)}" disabled style="opacity:.6">
      <label class="form-label">New Name</label>
      <input type="text" class="form-input" id="se-newname" placeholder="NewServiceName">
      <p style="font-size:11px;color:var(--amber);margin-top:6px">Renaming will stop the service, remove it, reinstall with the new name, and restart.</p>
    </div>

    <div class="modal-actions">
      <button class="btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn-glow" onclick="saveServiceParams('${escAttr(serviceName)}')"><i data-lucide="save"></i> Save</button>
    </div>
  `);
  lucide.createIcons();
}

function showSvcTab(tab) {
  ['app','details','logging','rename'].forEach(t => {
    const el = document.getElementById(`svc-tab-${t}`);
    const btn = document.getElementById(`stab-${t}`);
    if (el) el.style.display = t === tab ? '' : 'none';
    if (btn) btn.classList.toggle('active', t === tab);
  });
}

async function browseSvcPath(inputId) {
  const result = await window.api.openScriptDialog();
  if (result && result.success) document.getElementById(inputId).value = result.path;
}

async function saveServiceParams(serviceName) {
  const newName = document.getElementById('se-newname')?.value?.trim(); 
  
  // If rename requested
  if (newName && newName !== serviceName) {
    showToast(`Renaming service to ${newName}...`, 'info');
    const r = await window.api.renameService(serviceName, newName);
    if (r.success) {
      showToast(`Service renamed to ${newName}`, 'success');
      hideModal();
      refreshServices();
    } else {
      showToast('Rename failed: ' + r.message, 'error');
    }
    return;
  }

  // Save parameters
  const params = {
    Application: document.getElementById('se-path')?.value || '',
    AppDirectory: document.getElementById('se-dir')?.value || '',
    AppParameters: document.getElementById('se-args')?.value || '',
    DisplayName: document.getElementById('se-display')?.value || '',
    Description: document.getElementById('se-desc')?.value || '',
    Start: document.getElementById('se-startup')?.value || 'SERVICE_AUTO_START',
    AppStdout: document.getElementById('se-stdout')?.value || '',
    AppStderr: document.getElementById('se-stderr')?.value || '',
    AppRotateFiles: document.getElementById('se-rotate')?.checked || false,
    AppRotateBytes: document.getElementById('se-rotatebytes')?.value || '0'
  };

  const result = await window.api.setServiceParams(serviceName, params);
  if (result.success) {
    showToast('Service parameters saved', 'success');
    hideModal();
    servicesCache = null;
    refreshServices({ force: true });
  } else {
    showToast('Save failed: ' + result.message, 'error');
  }
}

async function svcAction(action, name) {
  // Confirm before uninstalling a Kyrion-managed service
  if (action === 'uninstall' && name.startsWith('Kyrion_')) {
    const taskId = name.replace('Kyrion_', '');
    const task = allTasks.find(t => t.Id && t.Id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20) === taskId);
    const taskName = task ? task.Name : name;
    showModal(`
      <h2><i data-lucide="alert-triangle"></i> Uninstall Managed Service</h2>
      <p style="color:var(--text2);font-size:13px;margin-top:8px;">You are about to uninstall the NSSM service <strong style="color:var(--text)">${escHtml(name)}</strong>\nlinked to task <strong style="color:var(--text)">${escHtml(taskName)}</strong>.</p>
      <p style="color:var(--text3);font-size:12px;margin-top:8px;">This will stop and remove the service. To redeploy, use the Deploy button on the task.</p>
      <div class="modal-actions">
        <button class="btn-ghost" onclick="hideModal()">Cancel</button>
        <button class="btn-danger" onclick="hideModal();confirmSvcUninstall('${name}')"><i data-lucide="trash-2"></i> Uninstall</button>
      </div>
    `);
    lucide.createIcons();
    return;
  }
  const map = { start: window.api.startService, stop: window.api.stopService, restart: window.api.restartService, uninstall: window.api.uninstallService };
  const r = await map[action](name);
  showToast(r.message, r.success ? 'success' : 'error');
  // The cached list is stale now, so refetch instead of repainting it.
  servicesCache = null;
  refreshServices({ force: true });
  refreshDashboard();
}

async function confirmSvcUninstall(name) {
  const r = await window.api.uninstallService(name);
  showToast(r.message, r.success ? 'success' : 'error');
  servicesCache = null;
  refreshServices({ force: true });
  refreshDashboard();
}

document.getElementById('btn-install-service').addEventListener('click', () => {
  const T = (k) => escHtml(i18n.t(k));
  showModal(`
    <h2><i data-lucide="server"></i> ${T('svcModal.title')}</h2>

    <div class="form-section">
      <div class="form-section-title"><i data-lucide="tag"></i> ${T('svcModal.identitySection')}</div>
      <div class="form-group">
        <label class="form-label" for="dlg-svc-name">${T('svcModal.name')} *</label>
        <input type="text" class="form-input" id="dlg-svc-name" placeholder="${T('svcModal.namePlaceholder')}">
        <div class="form-hint">${T('svcModal.nameHint')}</div>
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title"><i data-lucide="terminal"></i> ${T('svcModal.whatSection')}</div>
      <div class="form-group">
        <label class="form-label" for="dlg-svc-app">${T('svcModal.executable')} *</label>
        <input type="text" class="form-input" id="dlg-svc-app" data-path-input data-path-kind="file" data-path-ext=".exe,.bat,.cmd,.ps1" placeholder="C:\\app\\servico.exe">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="dlg-svc-args">${T('svcModal.arguments')}</label>
          <input type="text" class="form-input" id="dlg-svc-args" placeholder="${T('taskModal.optional')}">
        </div>
        <div class="form-group">
          <label class="form-label" for="dlg-svc-workdir">${T('svcModal.workdir')}</label>
          <input type="text" class="form-input" id="dlg-svc-workdir" data-path-input data-path-kind="directory" placeholder="${T('taskModal.optional')}">
        </div>
      </div>
    </div>

    <div class="form-section">
      <div class="form-section-title"><i data-lucide="power"></i> ${T('svcModal.startupSection')}</div>
      <div class="form-group">
        <label class="form-label" for="dlg-svc-startup">${T('svcModal.startupWhen')}</label>
        <select class="form-input" id="dlg-svc-startup">
          <option value="Automatic">${T('svcModal.startupAuto')}</option>
          <option value="Manual">${T('svcModal.startupManual')}</option>
          <option value="Disabled">${T('svcModal.startupDisabled')}</option>
        </select>
      </div>
    </div>

    <div class="modal-actions">
      <button class="btn-ghost" onclick="hideModal()">${T('taskModal.cancel')}</button>
      <button class="btn-glow" onclick="installService()"><i data-lucide="download"></i> ${T('svcModal.install')}</button>
    </div>
  `);
});

async function installService() {
  const name = document.getElementById('dlg-svc-name').value.trim();
  const appPath = document.getElementById('dlg-svc-app').value.trim();
  if (!name) { showToast(i18n.t('toast.serviceNameRequired'), 'error'); return; }
  if (!appPath) { showToast(i18n.t('toast.appPathRequired'), 'error'); return; }
  const r = await window.api.installService({
    name, appPath,
    args: document.getElementById('dlg-svc-args').value,
    workDir: document.getElementById('dlg-svc-workdir').value,
    startupType: document.getElementById('dlg-svc-startup').value
  });
  if (r.success) { showToast(i18n.t('toast.serviceInstalled'), 'success'); servicesCache = null; refreshServices({ force: true }); refreshDashboard(); }
  else showToast(r.message, 'error');
  hideModal();
}

document.getElementById('btn-refresh-services').addEventListener('click', () => refreshServices());

document.getElementById('btn-check-nssm').addEventListener('click', async () => {
  await showNssmManager();
});

// ─── NSSM Manager ───
async function showNssmManager() {
  showToast(i18n.t('toast.checkingNssm'), 'info');
  const status = await window.api.nssmCheckInstalled('nssm');

  if (status.installed) {
    showModal(`
      <h2><i data-lucide="check-circle"></i> NSSM Installed</h2>
      <div class="nssm-status-card">
        <div class="nssm-status-row"><span class="nssm-label">Status</span><span class="badge badge-success">Installed</span></div>
        <div class="nssm-status-row"><span class="nssm-label">Path</span><span class="nssm-value">${status.path}</span></div>
        <div class="nssm-status-row"><span class="nssm-label">Version</span><span class="nssm-value">${status.version}</span></div>
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" onclick="hideModal()">Close</button>
      </div>
    `);
    lucide.createIcons();
    return;
  }

  // NSSM not found — show installer
  showToast(i18n.t('toast.nssmNotFound'), 'warning');
  const managers = await window.api.nssmCheckManagers();
  const available = managers.filter(m => m.available);

  let installOptions = '';
  if (available.length > 0) {
    installOptions = available.map(m => `
      <button class="btn-glow" style="width:100%;justify-content:center;" onclick="installNssm('${m.name}')">
        <i data-lucide="download"></i> Install via ${m.label}
      </button>
    `).join('<div style="height:8px"></div>');
  }

  const unavailable = managers.filter(m => !m.available);
  let altOptions = '';
  if (unavailable.length > 0 || available.length === 0) {
    altOptions = `
      <div style="height:12px;border-top:1px solid var(--glass-border);margin:16px 0 0;"></div>
      <p style="font-size:11px;color:var(--text3);margin:12px 0 8px;text-transform:uppercase;letter-spacing:.5px;font-weight:600;">Alternative Options</p>
      <button class="btn-ghost" style="width:100%;justify-content:center;" onclick="downloadNssmManual()">
        <i data-lucide="globe"></i> Download from nssm.cc
      </button>
      <button class="btn-ghost" style="width:100%;justify-content:center;margin-top:6px;" onclick="window.api.openScriptDialog()">
        <i data-lucide="folder-open"></i> I already have NSSM — set path
      </button>
    `;
  }

  showModal(`
    <h2><i data-lucide="package-search"></i> Install NSSM</h2>
    <p style="font-size:13px;color:var(--text2);margin-bottom:16px;line-height:1.5;">
      NSSM (Non-Sucking Service Manager) is required to manage Windows services.
      Choose an installation method below:
    </p>
    <div id="nssm-install-options">
      ${installOptions}
      ${altOptions}
    </div>
    <div id="nssm-progress" style="display:none;margin-top:16px;">
      <div class="nssm-progress-bar"><div class="nssm-progress-fill" id="nssm-progress-fill"></div></div>
      <p id="nssm-progress-text" style="font-size:12px;color:var(--text3);margin-top:8px;text-align:center;"></p>
    </div>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="hideModal()">Cancel</button>
    </div>
  `);
  lucide.createIcons();
}

async function installNssm(manager) {
  const options = document.getElementById('nssm-install-options');
  const progress = document.getElementById('nssm-progress');
  const fill = document.getElementById('nssm-progress-fill');
  const text = document.getElementById('nssm-progress-text');

  options.style.opacity = '0.3';
  options.style.pointerEvents = 'none';
  progress.style.display = 'block';
  fill.style.width = '60%';
  text.textContent = `Installing NSSM via ${manager}... This may take a moment.`;

  const result = await window.api.nssmInstallVia(manager);

  if (result.success) {
    fill.style.width = '100%';
    fill.style.background = 'var(--green)';
    text.textContent = `NSSM installed successfully! Path: ${result.path}`;
    text.style.color = 'var(--green)';
    showToast('NSSM installed successfully!', 'success');
    // Save the path
    await window.api.setSetting('NssmPath', result.path);
    setTimeout(() => hideModal(), 2000);
  } else {
    fill.style.width = '100%';
    fill.style.background = 'var(--red)';
    text.textContent = `Installation failed: ${result.message}`;
    text.style.color = 'var(--red)';
    options.style.opacity = '1';
    options.style.pointerEvents = 'auto';
    showToast(`Installation failed: ${result.message}`, 'error');
  }
}

async function downloadNssmManual() {
  const options = document.getElementById('nssm-install-options');
  const progress = document.getElementById('nssm-progress');
  const fill = document.getElementById('nssm-progress-fill');
  const text = document.getElementById('nssm-progress-text');

  options.style.opacity = '0.3';
  options.style.pointerEvents = 'none';
  progress.style.display = 'block';
  fill.style.width = '40%';
  text.textContent = 'Downloading NSSM from nssm.cc...';

  const result = await window.api.nssmDownloadManual();

  if (result.success) {
    fill.style.width = '100%';
    fill.style.background = 'var(--green)';
    text.textContent = `NSSM downloaded to: ${result.path}`;
    text.style.color = 'var(--green)';
    await window.api.setSetting('NssmPath', result.path);
    showToast('NSSM downloaded successfully!', 'success');
    setTimeout(() => hideModal(), 2000);
  } else {
    fill.style.width = '100%';
    fill.style.background = 'var(--red)';
    text.textContent = `Download failed: ${result.message}`;
    text.style.color = 'var(--red)';
    options.style.opacity = '1';
    options.style.pointerEvents = 'auto';
    showToast(`Download failed: ${result.message}`, 'error');
  }
}

// ============================================================
// History
// ============================================================
let allBackupHistory = [];

async function refreshHistory() {
  setLoading('page-history', true);
  try {
    allHistory = await window.api.getHistory();
    // Also load backup history
    try {
      const bh = await window.api.getBackupHistory();
      allBackupHistory = (bh.history || []).map(h => ({
        ...h,
        TaskName: h.ProfileName || 'Backup',
        CronExpression: h.Databases ? h.Databases.join(', ') : '',
        _type: 'backup'
      }));
    } catch (e) { allBackupHistory = []; }
    renderHistory();
  } finally { setLoading('page-history', false); }
}

function renderHistory() {
  const now = Date.now();
  // Merge task + backup history and sort by timestamp
  let all = [...allHistory, ...allBackupHistory].sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
  if (currentFilter === '24h') all = all.filter(h => new Date(h.Timestamp) > new Date(now - 86400000));
  else if (currentFilter === 'week') all = all.filter(h => new Date(h.Timestamp) > new Date(now - 604800000));
  else if (currentFilter === 'month') all = all.filter(h => new Date(h.Timestamp) > new Date(now - 2592000000));

  const tbody = document.getElementById('history-body');
  const empty = document.getElementById('history-empty');
  if (all.length === 0) { tbody.innerHTML = ''; empty.style.display = 'block'; lucide.createIcons(); return; }
  empty.style.display = 'none';
  tbody.innerHTML = all.map(h => {
    const isBackup = h._type === 'backup';
    const typeBadge = isBackup ? '<span class="badge badge-info" style="font-size:9px">backup</span>' : '<span class="badge badge-active" style="font-size:9px">task</span>';
    const statusClass = h.Status === 'Success' ? 'success' : 'error';
    return `<tr style="cursor:${isBackup ? 'pointer' : 'default'}" ${isBackup ? `onclick="backupPage.showHistory('${h.ProfileId}')"` : ''}>
      <td>${formatTime(h.Timestamp)}</td>
      <td>${typeBadge} ${escHtml(h.TaskName)}</td>
      <td>${escHtml(h.CronExpression || h.Duration || '')}</td>
      <td><span class="badge badge-${statusClass}">${h.Status}</span></td>
      <td>${h.Duration || '-'}</td>
    </tr>`;
  }).join('');
  lucide.createIcons();
}

document.querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderHistory();
  });
});

document.getElementById('btn-export-csv').addEventListener('click', async () => {
  const r = await window.api.exportHistory('csv');
  if (r.success) showToast(i18n.t('toast.historyExported'), 'success');
  else if (r.message !== 'Cancelled') showToast(r.message, 'error');
});

// ============================================================
// Settings
// ============================================================
async function loadSettings() {
  document.getElementById('cfg-profile').value = await window.api.getSetting('ProfileName', 'default');
  document.getElementById('cfg-nssm').value = await window.api.getSetting('NssmPath', 'nssm');
  loadTraySettings();
  updateApiStatus();
  refreshKyrionService();
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  await window.api.setSetting('ProfileName', document.getElementById('cfg-profile').value);
  await window.api.setSetting('NssmPath', document.getElementById('cfg-nssm').value);
  showToast(i18n.t('toast.settingsSaved'), 'success');
});

// ─── System Tray Toggles ───
async function loadTraySettings() {
  if (!window.api.getTraySettings) return;
  const settings = await window.api.getTraySettings();
  document.getElementById('cfg-close-to-tray').checked = settings.closeToTray;
  document.getElementById('cfg-start-windows').checked = settings.startWithWindows;
  document.getElementById('cfg-start-minimized').checked = settings.startMinimized;
  syncStartMinimizedRow();
  const notifEnabled = await window.api.getSetting('Notifications', true);
  document.getElementById('cfg-notifications').checked = notifEnabled;
}

document.getElementById('cfg-close-to-tray').addEventListener('change', async (e) => {
  if (window.api.setCloseToTray) {
    await window.api.setCloseToTray(e.target.checked);
  } else {
    await window.api.setSetting('CloseToTray', e.target.checked);
  }
  showToast(e.target.checked ? i18n.t('settings.willCloseToTray') : i18n.t('settings.willCloseNormally'), 'info');
});

/** "Start minimized" only means anything when autostart is on. */
function syncStartMinimizedRow() {
  const row = document.getElementById('row-start-minimized');
  const on = document.getElementById('cfg-start-windows').checked;
  if (row) row.classList.toggle('muted', !on);
}

document.getElementById('cfg-start-windows').addEventListener('change', async (e) => {
  if (window.api.setStartWithWindows) {
    await window.api.setStartWithWindows(e.target.checked);
  } else {
    await window.api.setSetting('StartWithWindows', e.target.checked);
  }
  syncStartMinimizedRow();
  showToast(e.target.checked ? i18n.t('settings.willStartWithWindows') : i18n.t('settings.removedFromStartup'), 'info');
});

document.getElementById('cfg-start-minimized').addEventListener('change', async (e) => {
  if (window.api.setStartMinimized) {
    await window.api.setStartMinimized(e.target.checked);
  } else {
    await window.api.setSetting('StartMinimized', e.target.checked);
  }
  showToast(i18n.t(e.target.checked ? 'settings.willStartMinimized' : 'settings.willStartWindowed'), 'info');
});

document.getElementById('cfg-notifications').addEventListener('change', async (e) => {
  await window.api.setSetting('Notifications', e.target.checked);
  showToast(e.target.checked ? i18n.t('settings.notifEnabled') : i18n.t('settings.notifDisabled'), 'info');
});

// ─── API Server Controls ───
document.getElementById('cfg-api-enabled').addEventListener('change', async (e) => {
  if (e.target.checked) {
    const port = parseInt(document.getElementById('cfg-api-port').value) || 7600;
    showToast(`${i18n.t('settings.startingApi')} ${port}...`, 'info');
    const r = await window.api.apiServerStart(port);
    if (r.success) {
      showToast(`${i18n.t('settings.apiRunning')} ${r.url}`, 'success');
      updateApiStatus();
    } else {
      showToast(`Failed: ${r.message}`, 'error');
      e.target.checked = false;
    }
  } else {
    const r = await window.api.apiServerStop();
    showToast(r.success ? i18n.t('toast.apiStopped') : r.message, r.success ? 'success' : 'error');
    updateApiStatus();
  }
});

document.getElementById('cfg-api-port').addEventListener('change', async (e) => {
  await window.api.setSetting('ApiPort', parseInt(e.target.value) || 7600);
});

async function updateApiStatus() {
  const status = await window.api.apiServerStatus();
  const el = document.getElementById('api-server-status');
  const badge = document.getElementById('api-status-badge');
  const dashLink = document.getElementById('api-dashboard-link');
  const docsLink = document.getElementById('api-docs-link');
  el.style.display = 'block';
  document.getElementById('cfg-api-enabled').checked = status.running;
  document.getElementById('cfg-api-port').value = status.port;
  if (status.running) {
    badge.className = 'badge badge-active';
    badge.textContent = `Running on :${status.port}`;
    dashLink.href = status.url;
    dashLink.style.display = '';
    docsLink.href = status.url + '/docs';
    docsLink.style.display = '';
  } else {
    badge.className = 'badge badge-disabled';
    badge.textContent = 'Stopped';
    dashLink.style.display = 'none';
    docsLink.style.display = 'none';
  }
}

// ─── Kyrios Chronos Scheduler Service ───
async function refreshKyrionService() {
  try {
    const status = await window.api.getKyrionServiceStatus();
    const statusEl = document.getElementById('kyrion-svc-status');
    const installBtn = document.getElementById('btn-install-kyrion-svc');
    const uninstallBtn = document.getElementById('btn-uninstall-kyrion-svc');
    const restartBtn = document.getElementById('btn-restart-kyrion-svc');

    if (!status.nssmAvailable) {
      statusEl.innerHTML = '<span class="badge" style="background:var(--glass3);color:var(--text3)">NSSM not found — install via <code>choco install nssm</code> or download from nssm.cc</span>';
      installBtn.style.display = 'none';
      uninstallBtn.style.display = 'none';
      restartBtn.style.display = 'none';
      return;
    }

    if (status.installed) {
      const isRunning = status.status === 'Running';
      // "Running" only means the SCM started the process. The heartbeat is what
      // proves the scheduler loop is actually alive and processing tasks.
      let detail = '';
      if (isRunning && status.schedulerAlive) {
        detail = '<span class="badge badge-active" style="font-size:11px;margin-left:6px">Scheduler active</span>';
      } else if (isRunning) {
        detail = `<span class="badge badge-error" style="font-size:11px;margin-left:6px">Running, but the scheduler is not responding${status.heartbeatStale ? ' (stale heartbeat)' : ''}</span>`;
      }
      statusEl.innerHTML = `<span class="badge ${isRunning ? 'badge-active' : 'badge-error'}" style="font-size:12px">Service: ${status.serviceName} - ${status.status}</span>${detail}`;
      installBtn.style.display = 'none';
      uninstallBtn.style.display = '';
      restartBtn.style.display = isRunning ? '' : 'none';
      restartBtn.textContent = isRunning ? 'Restart Service' : 'Start Service';
    } else {
      statusEl.innerHTML = '<span class="badge" style="background:var(--glass3);color:var(--text3)">Not installed - Tasks and backups run only when the app is open</span>';
      installBtn.style.display = '';
      uninstallBtn.style.display = 'none';
      restartBtn.style.display = 'none';
    }
  } catch (err) {
    console.error('Failed to check Kyrion service status:', err);
  }
}

document.getElementById('btn-install-kyrion-svc').addEventListener('click', async () => {
  showToast('Installing Kyrios Chronos Scheduler as Windows service...', 'info');
  const result = await window.api.installKyrionService();
  if (result.success) {
    showToast(result.message, 'success');
  } else {
    showToast(result.message, 'error');
  }
  refreshKyrionService();
});

document.getElementById('btn-uninstall-kyrion-svc').addEventListener('click', async () => {
  showToast('Uninstalling Kyrios Chronos Scheduler service...', 'info');
  const result = await window.api.uninstallKyrionService();
  if (result.success) {
    showToast(result.message, 'success');
  } else {
    showToast(result.message, 'error');
  }
  refreshKyrionService();
});

document.getElementById('btn-restart-kyrion-svc').addEventListener('click', async () => {
  showToast('Restarting service...', 'info');
  const result = await window.api.restartKyrionService();
  if (result.success) {
    showToast(result.message || 'Service restarted', 'success');
  } else {
    showToast(result.message, 'error');
  }
  refreshKyrionService();
});

// ============================================================
// Refresh
// ============================================================
document.getElementById('btn-refresh').addEventListener('click', () => {
  const btn = document.getElementById('btn-refresh');
  btn.style.transform = 'rotate(360deg)';
  setTimeout(() => btn.style.transform = '', 500);
  refreshCurrentPage();
});

async function refreshCurrentPage() {
  const active = document.querySelector('.nav-btn.active');
  if (!active) return;
  const page = active.dataset.page;
  if (page === 'dashboard') await refreshDashboard();
  else if (page === 'tasks') await refreshTasks();
  else if (page === 'services') await refreshServices();
  else if (page === 'history') await refreshHistory();
  else if (page === 'settings') await loadSettings();
  else if (page === 'logs') await refreshLogs();
  else if (page === 'backup') await backupPage.load();
}

// Auto-refresh every 30s
autoRefreshTimer = setInterval(() => {
  const active = document.querySelector('.nav-btn.active');
  if (active && active.dataset.page === 'dashboard') refreshDashboard();
}, 30000);

// ============================================================
// Helpers
// ============================================================
function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-CA') + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
async function browseScript() {
  const result = await window.api.openScriptDialog();
  if (result && result.success) document.getElementById('dlg-script').value = result.path;
}

// ============================================================
// Keyboard Shortcuts
// ============================================================
document.addEventListener('keydown', (e) => {
  if (e.key === 'F5') { e.preventDefault(); refreshCurrentPage(); }
  if (e.ctrlKey && e.key === 'n') { e.preventDefault(); showTaskDialog(); }
  if (e.ctrlKey && e.key === 'e') { e.preventDefault(); document.getElementById('btn-export').click(); }
  if (e.ctrlKey && e.key === 'i') { e.preventDefault(); document.getElementById('btn-import').click(); }
});

// ============================================================
// IPC Events
// ============================================================
window.api.onDataUpdated(() => { refreshDashboard(); });
window.api.onTaskExecuted((result) => {
  showToast(`"${result.TaskName}": ${result.Status}`, result.Status === 'Success' ? 'success' : 'error');
});

// ============================================================
// GitHub Profile (l1nds0n)
// ============================================================
const GH_USERNAME = 'l1nds0n';

async function showGitHubProfile() {
  showModal(`<div class="gh-loading" id="gh-loading"><i data-lucide="loader"></i><p>Loading profile...</p></div><div id="gh-content" style="display:none"></div>`);
  try {
    const [userRes, reposRes] = await Promise.all([
      fetch(`https://api.github.com/users/${GH_USERNAME}`),
      fetch(`https://api.github.com/users/${GH_USERNAME}/repos?sort=updated&per_page=6`)
    ]);
    const user = await userRes.json();
    const repos = await reposRes.json();

    const loading = document.getElementById('gh-loading');
    const content = document.getElementById('gh-content');

    const location = user.location ? `<span><i data-lucide="map-pin"></i>${user.location}</span>` : '';
    const company = user.company ? `<span><i data-lucide="building-2"></i>${user.company}</span>` : '';
    const blog = user.blog ? `<a href="${user.blog.startsWith('http') ? user.blog : 'https://' + user.blog}" target="_blank" style="color:var(--primary);text-decoration:none;"><i data-lucide="link"></i>${user.blog}</a>` : '';

    let reposHtml = '';
    if (repos.length > 0) {
      reposHtml = `
        <div class="gh-repos">
          <h4><i data-lucide="folder-git-2"></i> Top Repositories</h4>
          <div class="gh-repo-list">
            ${repos.map(r => `
              <a class="gh-repo" href="${r.html_url}" target="_blank">
                <div>
                  <div class="gh-repo-name">${r.name}</div>
                  ${r.description ? `<div class="gh-repo-desc">${r.description.substring(0, 80)}</div>` : ''}
                </div>
                <div style="text-align:right;flex-shrink:0;margin-left:12px;">
                  ${r.language ? `<div class="gh-repo-lang">${r.language}</div>` : ''}
                  <div style="font-size:11px;color:var(--text3);margin-top:4px;display:flex;align-items:center;gap:4px;justify-content:flex-end;"><i data-lucide="star" style="width:12px;height:12px;"></i>${r.stargazers_count}</div>
                </div>
              </a>
            `).join('')}
          </div>
        </div>`;
    }

    content.innerHTML = `
      <div class="gh-profile">
        <div class="gh-header">
          <img class="gh-avatar" src="${user.avatar_url}" alt="${user.login}"/>
          <div class="gh-info">
            <h3>${user.name || user.login}</h3>
            <div class="gh-login">@${user.login}</div>
            ${user.bio ? `<div class="gh-bio">${user.bio}</div>` : ''}
            <div class="gh-meta">
              ${location}
              ${company}
              ${blog}
              <span><i data-lucide="calendar"></i>Joined ${new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span>
            </div>
          </div>
        </div>
        <div class="gh-stats">
          <div class="gh-stat"><div class="gh-stat-value">${user.public_repos}</div><div class="gh-stat-label">Repos</div></div>
          <div class="gh-stat"><div class="gh-stat-value">${user.followers}</div><div class="gh-stat-label">Followers</div></div>
          <div class="gh-stat"><div class="gh-stat-value">${user.following}</div><div class="gh-stat-label">Following</div></div>
          <div class="gh-stat"><div class="gh-stat-value">${user.public_gists}</div><div class="gh-stat-label">Gists</div></div>
        </div>
        ${reposHtml}
      </div>`;

    loading.style.display = 'none';
    content.style.display = 'block';
    lucide.createIcons();
  } catch (e) {
    const loading = document.getElementById('gh-loading');
    if (loading) loading.innerHTML = `<p style="color:var(--red);">Failed to load GitHub profile</p>`;
  }
}

document.getElementById('credits-author').addEventListener('click', (e) => {
  e.preventDefault();
  showGitHubProfile();
});

// ============================================================
// NSSM Startup Check
// ============================================================
async function startupNssmCheck() {
  const status = await window.api.nssmCheckInstalled('nssm');
  if (!status.installed) {
    showToast(i18n.t('toast.nssmNotFoundHint'), 'warning');
  }
}
startupNssmCheck();

// ============================================================
// Init
// ============================================================
refreshDashboard();
lucide.createIcons();

// ============================================================
// Renderer Error Reporting
// ============================================================
window.onerror = function(message, source, lineno, colno, error) {
  try {
    window.api.reportError({
      message: String(message),
      stack: error?.stack || null,
      filename: source || null,
      lineno: lineno || null,
      colno: colno || null
    });
  } catch (e) { /* ignore to prevent infinite loop */ }
};
window.addEventListener('unhandledrejection', function(e) {
  try {
    window.api.reportError({
      message: `Unhandled promise rejection: ${e.reason?.message || e.reason}`,
      stack: e.reason?.stack || null
    });
  } catch (e) { /* ignore */ }
});

// ============================================================
// Logs Page
// ============================================================
let currentLogTab = 'errors';
let allLogs = [];
let allErrors = [];
let allAudit = [];

function switchLogTab(tab) {
  currentLogTab = tab;
  document.querySelectorAll('.logs-tab').forEach(t => t.classList.toggle('active', t.dataset.logTab === tab));
  renderLogsTable();
}

document.querySelectorAll('.logs-tab').forEach(btn => {
  btn.addEventListener('click', () => switchLogTab(btn.dataset.logTab));
});

async function refreshLogs() {
  try {
    await swr('logs', () => Promise.all([
      window.api.getErrors(),
      window.api.getAuditLogs(),
      window.api.getLogs(),
    ]), ([errors, audit, logs]) => {
      allErrors = errors; allAudit = audit; allLogs = logs;
      renderLogsStats();
      renderLogsTable();
    });
    return;
  } catch (e) { /* fall through to the original path below */ }

  try {
    [allErrors, allAudit, allLogs] = await Promise.all([
      window.api.getErrors(),
      window.api.getAuditLogs(),
      window.api.getLogs()
    ]);
    renderLogsStats();
    renderLogsTable();
  } catch (e) {
    console.error('Failed to load logs:', e);
  }
}

function renderLogsStats() {
  const stats = document.getElementById('logs-stats');
  if (!stats) return;
  stats.innerHTML = `
    <div class="logs-stat">
      <div class="logs-stat-icon errors"><i data-lucide="alert-circle"></i></div>
      <div class="logs-stat-info"><div class="logs-stat-value">${allErrors.length}</div><div class="logs-stat-label">Errors</div></div>
    </div>
    <div class="logs-stat">
      <div class="logs-stat-icon audit"><i data-lucide="shield"></i></div>
      <div class="logs-stat-info"><div class="logs-stat-value">${allAudit.length}</div><div class="logs-stat-label">Audit Events</div></div>
    </div>
    <div class="logs-stat">
      <div class="logs-stat-icon total"><i data-lucide="scroll-text"></i></div>
      <div class="logs-stat-info"><div class="logs-stat-value">${allLogs.length}</div><div class="logs-stat-label">Total Logs</div></div>
    </div>
  `;
  lucide.createIcons();
}

function renderLogsTable() {
  const wrap = document.getElementById('logs-table-wrap');
  const empty = document.getElementById('logs-empty');
  if (!wrap) return;

  if (currentLogTab === 'errors') {
    if (allErrors.length === 0) { wrap.innerHTML = ''; wrap.appendChild(empty); empty.style.display = 'block'; lucide.createIcons(); return; }
    empty.style.display = 'none';
    const rows = allErrors.slice().reverse();
    wrap.innerHTML = `<table class="logs-table"><thead><tr><th>Time</th><th>Level</th><th>Message</th><th>Details</th></tr></thead><tbody>${
      rows.map(e => `<tr class="log-row-error">
        <td class="log-ts">${formatTime(e.timestamp)}</td>
        <td><span class="log-level error">ERROR</span></td>
        <td class="log-message">${escHtml(e.message)}</td>
        <td class="log-meta" onclick="this.style.maxHeight=this.style.maxHeight==='none'?'60px':'none'">${e.error ? escHtml(e.error.message) : ''}${e.context ? `<br><span style="color:var(--text3)">context: ${escHtml(JSON.stringify(e.context))}</span>` : ''}</td>
      </tr>`).join('')
    }</tbody></table>`;
  } else if (currentLogTab === 'audit') {
    if (allAudit.length === 0) { wrap.innerHTML = ''; wrap.appendChild(empty); empty.style.display = 'block'; lucide.createIcons(); return; }
    empty.style.display = 'none';
    const rows = allAudit.slice().reverse();
    wrap.innerHTML = `<table class="logs-table"><thead><tr><th>Time</th><th>Action</th><th>Target</th><th>Before</th><th>After</th></tr></thead><tbody>${
      rows.map(a => `<tr class="log-row-audit">
        <td class="log-ts">${formatTime(a.timestamp)}</td>
        <td><span class="log-action">${escHtml(a.action)}</span></td>
        <td class="log-target">${a.target ? escHtml(String(a.target)) : '-'}</td>
        <td class="log-meta" onclick="this.style.maxHeight=this.style.maxHeight==='none'?'60px':'none'">${a.before ? escHtml(JSON.stringify(a.before)) : '-'}</td>
        <td class="log-meta" onclick="this.style.maxHeight=this.style.maxHeight==='none'?'60px':'none'">${a.after ? escHtml(JSON.stringify(a.after)) : '-'}</td>
      </tr>`).join('')
    }</tbody></table>`;
  } else {
    if (allLogs.length === 0) { wrap.innerHTML = ''; wrap.appendChild(empty); empty.style.display = 'block'; lucide.createIcons(); return; }
    empty.style.display = 'none';
    const rows = allLogs.slice().reverse();
    wrap.innerHTML = `<table class="logs-table"><thead><tr><th>Time</th><th>Level</th><th>Message</th></tr></thead><tbody>${
      rows.map(l => {
        const level = (l.level || 'INFO').toLowerCase();
        const rowClass = level === 'error' ? 'log-row-error' : level === 'warn' ? 'log-row-warn' : '';
        return `<tr class="${rowClass}">
          <td class="log-ts">${formatTime(l.timestamp)}</td>
          <td><span class="log-level ${level}">${escHtml(l.level || 'INFO')}</span></td>
          <td class="log-message">${escHtml(l.message)}${l.meta ? `<br><span class="log-meta">${escHtml(JSON.stringify(l.meta))}</span>` : ''}</td>
        </tr>`;
      }).join('')
    }</tbody></table>`;
  }
  lucide.createIcons();
}

document.getElementById('btn-refresh-logs')?.addEventListener('click', () => {
  const icon = document.querySelector('#btn-refresh-logs i');
  if (icon) icon.style.animation = 'spin .5s linear';
  refreshLogs();
  setTimeout(() => { if (icon) icon.style.animation = ''; }, 600);
});

document.getElementById('btn-export-logs')?.addEventListener('click', async () => {
  const type = currentLogTab;
  const result = await window.api.exportLogs(type, 'json');
  if (result.success) showToast(`Exported ${result.count || 0} ${type} log entries`, 'success');
  else if (result.message !== 'Cancelled') showToast(result.message || 'Export failed', 'error');
});

// ============================================================
// i18n - Internationalization
// ============================================================
async function initI18n() {
  const savedLang = await window.api.getSetting('Language', 'en');
  i18n.init(savedLang);
  document.getElementById('cfg-language').value = savedLang;
  applyTranslations();
  i18n.onChange(() => applyTranslations());
}

function applyTranslations() {
  // Update all elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = i18n.t(key);
  });
  // Update placeholders
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = i18n.t(key);
  });
  // Update page title based on current page
  const activePage = document.querySelector('.nav-btn.active');
  if (activePage) {
    const page = activePage.dataset.page;
    const titleMap = {
      dashboard: 'dashboard.title',
      tasks: 'tasks.title',
      services: 'services.title',
      history: 'history.title',
      logs: 'logs.title',
      settings: 'settings.title'
    };
    if (titleMap[page]) {
      document.getElementById('page-title').textContent = i18n.t(titleMap[page]);
    }
  }
  lucide.createIcons();
}

document.getElementById('cfg-language').addEventListener('change', async (e) => {
  const lang = e.target.value;
  i18n.setLang(lang);
  await window.api.setSetting('Language', lang);
  applyTranslations();
  showToast(i18n.t('lang.changed'), 'info');
});

// Initialize i18n on load
initI18n();

// ─── Web Access (GitHub sign-in allowlist) ───
async function refreshWebAccess() {
  const list = document.getElementById('gh-users-list');
  if (!list) return;
  try {
    const cfg = await window.api.getWebAccess();

    document.getElementById('cfg-gh-client-id').value = cfg.clientId || '';
    document.getElementById('cfg-gh-client-secret').placeholder = cfg.hasClientSecret ? '•••••••• (salvo)' : '••••••••••••';
    document.getElementById('cfg-web-base-url').value = cfg.baseUrl || '';
    document.getElementById('cfg-api-bind-all').checked = !!cfg.bindAll;

    const base = (cfg.baseUrl || `http://localhost:${cfg.port || 7600}`).replace(/\/+$/, '');
    document.getElementById('oauth-callback-hint').textContent = base + '/auth/github/callback';

    if (!cfg.users.length) {
      list.innerHTML = `<div style="color:var(--amber);font-size:12px;padding:10px 0">${escHtml(i18n.t('webAccess.noUsers'))}</div>`;
      return;
    }
    list.innerHTML = cfg.users.map(u => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--glass-border)">
        <i data-lucide="user" style="width:14px;height:14px;color:var(--text3)"></i>
        <span style="flex:1;font-size:12.5px;color:var(--text2)">${escHtml(u)}</span>
        <button class="btn-danger" data-rm-gh="${escHtml(u)}">${escHtml(i18n.t('webAccess.remove'))}</button>
      </div>`).join('');
    lucide.createIcons();
  } catch (err) {
    list.innerHTML = `<div style="color:var(--red);font-size:12px">${escHtml(i18n.t('webAccess.error'))}: ${escHtml(err.message)}</div>`;
  }
}

async function saveWebAccessFields() {
  const secretEl = document.getElementById('cfg-gh-client-secret');
  const result = await window.api.setWebAccess({
    clientId: document.getElementById('cfg-gh-client-id').value,
    clientSecret: secretEl.value,   // empty keeps the stored one
    baseUrl: document.getElementById('cfg-web-base-url').value,
    bindAll: document.getElementById('cfg-api-bind-all').checked,
  });
  if (result.success) {
    secretEl.value = '';
    showToast(i18n.t('webAccess.saved'), 'success');
    refreshWebAccess();
  } else {
    showToast(result.message || i18n.t('webAccess.saveFailed'), 'error');
  }
}

(function wireWebAccess() {
  const addBtn = document.getElementById('btn-add-gh-user');
  if (!addBtn) return;

  const input = document.getElementById('gh-user-input');
  const add = async () => {
    const result = await window.api.addWebUser(input.value);
    if (result.success) { input.value = ''; showToast(i18n.t('webAccess.userAdded'), 'success'); refreshWebAccess(); }
    else showToast(result.message, 'error');
  };
  addBtn.addEventListener('click', add);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  document.getElementById('gh-users-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-rm-gh]');
    if (!btn) return;
    const login = btn.getAttribute('data-rm-gh');
    if (!confirm(i18n.t('webAccess.removeConfirm', { login }))) return;
    await window.api.removeWebUser(login);
    showToast(i18n.t('webAccess.userRemoved'), 'success');
    refreshWebAccess();
  });

  ['cfg-gh-client-id', 'cfg-web-base-url'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveWebAccessFields);
  });
  document.getElementById('cfg-gh-client-secret').addEventListener('change', saveWebAccessFields);
  document.getElementById('cfg-api-bind-all').addEventListener('change', saveWebAccessFields);

  refreshWebAccess();
})();
