// app.js - Frontend Application Logic (Enhanced UX)
let allTasks = [];
let allHistory = [];
let currentFilter = 'all';
let smartCron = null;
let autoRefreshTimer = null;
// Rows currently drawn in the dashboard activity table, so a click can hand
// the original entry to the detail modal without re-encoding it in markup.
let recentActivityRows = [];


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
    const titleMap = { dashboard: 'dashboard.title', tasks: 'tasks.title', services: 'services.title', history: 'history.title', settings: 'settings.title', logs: 'logs.title', backup: 'nav.backups', sync: 'nav.sync', retention: 'nav.retention', network: 'nav.network' };
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
// A bandeja manda "navigate-to" para abrir uma aba específica. Sem este
// listener o item de menu funciona, a janela abre e a pessoa cai no painel sem
// saber onde procurou.
window.addEventListener('navigate-to', (e) => {
  if (e.detail) switchPage(e.detail);
});

function switchPage(page) {
  const btn = document.querySelector(`.nav-btn[data-page="${page}"]`);
  if (btn) btn.click();
}

(function wireCalendar() {
  const btn = document.getElementById('btn-open-calendar');
  if (btn) btn.addEventListener('click', () => KyriosCalendar.open('month'));
})();

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
  if (typeof window.onModalClose === 'function') window.onModalClose();
}
document.getElementById('modal-overlay').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal-overlay')) hideModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const scriptOverlay = document.getElementById('script-editor-overlay');
    const richTextOverlay = document.getElementById('rich-text-overlay');
    if ((scriptOverlay && !scriptOverlay.classList.contains('hidden')) || (richTextOverlay && !richTextOverlay.classList.contains('hidden'))) return;
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
    if (window.KyriosCalendar) KyriosCalendar.renderMini();

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
      rows.push({ ts: h.Timestamp, what: h.TaskName, kind: i18n.t('dash.kindTask'), ok: h.Status === 'Success', status: h.Status, duration: h.Duration, entry: h, entryKind: 'task' });
    }
    for (const h of backupHistory.slice(0, 10)) {
      rows.push({ ts: h.Timestamp, what: h.ProfileName, kind: i18n.t('dash.kindBackup'), ok: h.Status === 'Success', status: h.Status, duration: h.Duration, entry: h, entryKind: 'backup' });
    }
    rows.sort((a, b) => new Date(b.ts) - new Date(a.ts));

    recentActivityRows = rows.slice(0, 10);

    const tbody = document.getElementById('recent-body');
    const empty = document.getElementById('recent-empty');
    if (!recentActivityRows.length) {
      tbody.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      tbody.innerHTML = recentActivityRows.map((r, i) =>
        '<tr class="row-clickable" data-activity-index="' + i + '" title="' + escAttr(i18n.t('dash.activityClickHint')) + '">' +
        '<td>' + escHtml(formatTime(r.ts)) + '</td>' +
        '<td>' + escHtml(r.what || '-') + ' <span class="badge badge-info" style="font-size:9px">' + escHtml(r.kind) + '</span></td>' +
        '<td><span class="badge badge-' + (r.ok ? 'success' : 'error') + '">' + escHtml(r.status) + '</span></td>' +
        '<td>' + escHtml(r.duration || '-') + '</td>' +
        '</tr>').join('');
      // Delegated, so the raw entry is passed as data and never re-escaped
      // into an inline handler.
      tbody.onclick = (e) => {
        const row = e.target.closest('[data-activity-index]');
        if (!row) return;
        const item = recentActivityRows[+row.dataset.activityIndex];
        if (item) showRunDetail(item.entry, item.entryKind);
      };
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
  if (page === 'sync' && window.syncPage) syncPage.render();
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
    <div class="task-card clickable ${t.Enabled ? '' : 'task-disabled'}"
         onclick="editTask('${escHandler(t.Id)}')" title="${escHtml(i18n.t('tasks.clickToEdit'))}">
      <div class="task-info">
        <div class="task-name">${escHtml(t.Name)}
          ${window.RunMonitor ? RunMonitor.runningBadge(t.Id) : ''}
          ${t.ScriptType ? `<span class="badge badge-info" style="font-size:9px;padding:1px 5px;">${t.ScriptType.toUpperCase()} inline</span>` : ''}
        </div>
        <div class="task-meta"><i data-lucide="clock"></i>${escHtml(t.CronExpression)}<span style="color:var(--text3)">|</span><i data-lucide="file-code"></i>${escHtml(t.ScriptPath || 'inline')}</div>
        ${t.Description || t.DescriptionHtml ? `<div class="task-desc rich-text-preview">${window.simpleRichText ? simpleRichText.sanitize(t.DescriptionHtml || simpleRichText.fromText(t.Description || '')) : escHtml(t.Description || '')}</div>` : ''}
      </div>
      <div class="task-actions" onclick="event.stopPropagation()">
        <label class="toggle-switch" title="${escHtml(i18n.t('tasks.toggleEnabled'))}" style="margin-right:4px">
          <input type="checkbox" ${t.Enabled ? 'checked' : ''} onchange="toggleTaskEnabled('${escHandler(t.Id)}', this.checked)">
          <span class="toggle-slider"></span>
        </label>
        <button class="btn-glow btn-sm" onclick="runTask('${escHandler(t.Id)}')"><i data-lucide="play"></i>${i18n.t('tasks.run')}</button>
        <button class="btn-secondary-sm" onclick="showTaskHistory('${escHandler(t.Id)}')" title="${escHtml(i18n.t('profile.history'))}"><i data-lucide="history"></i></button>
        <button class="btn-danger" onclick="deleteTask('${escHandler(t.Id)}','${escHandler(t.Name)}')" title="${escHtml(i18n.t('profile.delete'))}"><i data-lucide="trash-2"></i></button>
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
//
// Off by default: the textarea is a power-user shortcut, and a panel of empty
// syntax instructions sitting above the task list pushed the actual work down
// the screen. The choice is remembered, so it opens only where it was left.
const QUICK_CREATE_KEY = 'tasks.quickCreate';

function applyQuickCreateState(open, persist) {
  const panel = document.getElementById('quick-create-panel');
  const btn = document.getElementById('btn-toggle-quick');
  if (!panel || !btn) return;
  panel.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (persist) {
    try { localStorage.setItem(QUICK_CREATE_KEY, open ? 'true' : 'false'); } catch (e) { /* private mode */ }
  }
  if (open) {
    renderQuickTasks();
    const input = document.getElementById('quick-input');
    if (input && input.value.trim()) updateQuickPreview();
  }
  lucide.createIcons();
}

document.getElementById('btn-toggle-quick').addEventListener('click', () => {
  const panel = document.getElementById('quick-create-panel');
  const open = panel.classList.contains('hidden');
  applyQuickCreateState(open, true);
  if (open) {
    const input = document.getElementById('quick-input');
    if (input) input.focus();
  }
});

let quickCreateOpen = false;
try { quickCreateOpen = localStorage.getItem(QUICK_CREATE_KEY) === 'true'; } catch (e) { quickCreateOpen = false; }
applyQuickCreateState(quickCreateOpen, false);

function renderQuickTasks() {
  const container = document.getElementById('quick-tasks-list');
  if (!container) return;
  if (allTasks.length === 0) { container.innerHTML = ''; return; }

  let html = `<div class="quick-tasks-header"><i data-lucide="list"></i> ${escHtml(i18n.t('quick.existingTasks'))} <span class="quick-tasks-count">${allTasks.length}</span></div>`;
  html += allTasks.map(t => {
    const line = `${t.CronExpression} | ${t.Name} | ${t.ScriptPath || ''}${t.Arguments ? ' | ' + t.Arguments : ''}${t.Description ? ' | ' + t.Description : ''}`;
    return `
    <div class="quick-task-row" onclick="loadTaskToEditor('${escHandler(line)}', '${escHandler(t.Id)}')" data-tip="${escAttr(i18n.t('quick.clickToLoad'))}">
      <span class="qtr-dot ${t.Enabled ? 'active' : 'disabled'}"></span>
      <span class="qtr-name">${escHtml(t.Name)}</span>
      <span class="qtr-cron">${escHtml(t.CronExpression)}</span>
      <span class="qtr-script">${escHtml(t.ScriptPath)}</span>
      <span class="qtr-edit-hint"><i data-lucide="arrow-left" style="width:11px;height:11px;"></i> ${escHtml(i18n.t('quick.load'))}</span>
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
  showToast(i18n.t('quick.loaded'), 'info');
}

let quickPreviewTimer = null;
let quickPreviewToken = 0;

document.getElementById('quick-input').addEventListener('input', () => {
  clearTimeout(quickPreviewTimer);
  quickPreviewTimer = setTimeout(() => updateQuickPreview(), 250);
});

/**
 * Preview is asynchronous now: validating a cron means asking the main process,
 * which is the only place the parser lives. A slow answer for an old keystroke
 * must not overwrite a newer one, hence the token.
 */
async function updateQuickPreview() {
  const input = document.getElementById('quick-input');
  if (!input) return;
  const text = input.value;
  const token = ++quickPreviewToken;
  if (!text.trim()) { renderQuickPreview([]); return; }

  const results = await parseQuickLines(text);
  if (token !== quickPreviewToken) return;
  renderQuickPreview(results);
}

document.getElementById('btn-quick-clear').addEventListener('click', () => {
  document.getElementById('quick-input').value = '';
  quickPreviewToken++;
  renderQuickPreview([]);
});

document.getElementById('btn-quick-create').addEventListener('click', async () => {
  const input = document.getElementById('quick-input');
  const text = input ? input.value : '';
  if (!text.trim()) { showToast(i18n.t('quick.emptyPrompt'), 'warning'); return; }

  const results = await parseQuickLines(text);
  const valid = results.filter(r => r.valid);
  if (valid.length === 0) { showToast(i18n.t('quick.noValid'), 'error'); return; }

  const btn = document.getElementById('btn-quick-create');
  btn.disabled = true;
  let created = 0;
  let failed = 0;
  try {
    for (const r of valid) {
      const result = await window.api.addTask({
        Name: r.name,
        CronExpression: r.cron,
        ScriptPath: r.script,
        Arguments: r.args,
        Description: r.description,
        Enabled: true
      });
      // A refusal from the main process must not be reported as a success.
      if (result && result.success === false) { failed++; continue; }
      created++;
    }
  } finally {
    btn.disabled = false;
  }

  if (created > 0) {
    showToast(i18n.t('quick.created', { n: created }), 'success');
    input.value = '';
    quickPreviewToken++;
    renderQuickPreview([]);
    swrInvalidate('tasks');
    refreshTasks();
    refreshDashboard();
  }
  if (failed > 0) showToast(i18n.t('quick.createFailed', { n: failed }), 'error');
  if (created === 0 && failed === 0) showToast(i18n.t('quick.noValid'), 'error');
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
  _scriptMode = hasInline ? 'editor' : 'file';
  _scriptContent = hasInline ? task.ScriptContent : '';
  _scriptType = hasInline ? (task.ScriptType || 'ps1') : 'ps1';
  _taskDescriptionText = isEdit ? (task.Description || '') : '';
  _taskDescriptionHtml = isEdit ? (task.DescriptionHtml || '') : '';
  scriptEditor.destroy();
  const T = (k, p) => escHtml(i18n.t(k, p));

  // Grouped into sections - identity, schedule, what runs, options - so a long
  // form reads as four short ones instead of a wall of fields.
  showModal(`
    <h2>${isEdit
      ? `<i data-lucide="pencil"></i> ${T('taskModal.editTitle')}`
      : `<i data-lucide="plus-circle"></i> ${T('taskModal.newTitle')}`}</h2>

    <div class="modal-steps" role="list">
      <div class="modal-step active" role="listitem">${T('taskModal.stepIdentity')}</div>
      <div class="modal-step" role="listitem">${T('taskModal.stepSchedule')}</div>
      <div class="modal-step" role="listitem">${T('taskModal.stepCommand')}</div>
      <div class="modal-step" role="listitem">${T('taskModal.stepOptions')}</div>
    </div>

    <div class="modal-help">
      <i data-lucide="lightbulb"></i>
      <span>${T('taskModal.formHelp')}</span>
    </div>

    <div class="modal-summary" id="task-dialog-summary"></div>

    <div class="form-section" data-step="identity">
      <div class="form-group">
        <label class="form-label" for="dlg-name" data-tip="${T('taskModal.tipName')}">${T('taskModal.name')} *</label>
        <input type="text" class="form-input" id="dlg-name" value="${isEdit ? escAttr(task.Name) : ''}" placeholder="${T('taskModal.namePlaceholder')}">
      </div>
    </div>

    <div class="form-section" data-step="schedule">
      <div class="form-section-title" data-tip="${T('taskModal.tipSchedule')}"><i data-lucide="clock"></i> ${T('taskModal.scheduleSection')}</div>
      <div id="smart-cron-container"></div>
    </div>

    <div class="form-section" data-step="command">
      <div class="form-section-title" data-tip="${T('taskModal.tipCommand')}"><i data-lucide="terminal"></i> ${T('taskModal.whatSection')}</div>
      <div class="script-mode-tabs">
        <button type="button" class="script-mode-tab ${!hasInline ? 'active' : ''}" id="tab-file" onclick="scriptEditorSwitchMode('file')">
          <i data-lucide="file-input"></i> ${T('taskModal.tabFile')}
        </button>
        <button type="button" class="script-mode-tab ${hasInline ? 'active' : ''}" id="tab-editor" onclick="scriptEditorSwitchMode('editor')">
          <i data-lucide="code-2"></i> ${T('taskModal.tabEditor')}
        </button>
      </div>

      <div id="script-mode-file">
        <div class="input-row">
          <input type="text" class="form-input" id="dlg-script" data-path-input data-path-kind="file" data-path-ext=".ps1,.bat,.cmd,.exe,.vbs,.py" value="${isEdit ? escAttr(task.ScriptPath || '') : ''}" placeholder="C:\\Scripts\\backup.ps1">
          <button class="btn-outline" type="button" onclick="browseScript()"><i data-lucide="folder-open"></i> ${T('taskModal.browse')}</button>
        </div>
        <div class="form-hint">${i18n.t('taskModal.supported', {
          ps1: '<code>.ps1</code>', bat: '<code>.bat</code>', cmd: '<code>.cmd</code>', exe: '<code>.exe</code>',
        })}</div>
      </div>

      <div id="script-mode-editor" style="display:none">
        <div class="script-mode-summary">
          <span id="script-editor-summary">${T('scriptEditor.summary')}</span>
          <button class="btn-outline btn-sm" type="button" onclick="scriptEditorSwitchMode('editor')"><i data-lucide="pencil"></i> ${T('scriptEditor.open')}</button>
        </div>
        <div id="script-file-path" class="script-path-display" style="display:none"></div>
      </div>

      <div class="form-row" style="margin-top:14px">
        <div class="form-group">
          <label class="form-label" for="dlg-args" data-tip="${T('taskModal.tipArgs')}">${T('taskModal.arguments')}</label>
          <input type="text" class="form-input" id="dlg-args" value="${isEdit ? escAttr(task.Arguments || '') : ''}" placeholder="${T('taskModal.argumentsPlaceholder')}">
        </div>
        <div class="form-group">
          <label class="form-label" for="dlg-workdir" data-tip="${T('taskModal.tipWorkdir')}">${T('taskModal.workdir')}</label>
          <input type="text" class="form-input" id="dlg-workdir" data-path-input data-path-kind="directory" value="${isEdit ? escAttr(task.WorkingDirectory || '') : ''}" placeholder="${T('taskModal.optional')}">
        </div>
      </div>
    </div>

    <div class="form-section" data-step="options">
      <div class="form-section-title" data-tip="${T('taskModal.tipOptions')}"><i data-lucide="settings-2"></i> ${T('taskModal.optionsSection')}</div>
      <div class="form-group">
        <label class="form-label" for="dlg-desc" data-tip="${T('taskModal.tipDescription')}">${T('taskModal.description')}</label>
        <div class="script-mode-summary">
          <span id="task-description-summary">${_taskDescriptionText ? T('richText.editedDescription') : T('richText.emptyDescription')}</span>
          <button class="btn-outline btn-sm" type="button" id="btn-edit-description" onclick="editTaskDescription()"><i data-lucide="text"></i> ${T('richText.edit')}</button>
        </div>
        <div id="task-description-preview" class="task-desc rich-text-preview"></div>
      </div>
      <label class="check-row" for="dlg-enabled" data-tip="${T('taskModal.tipEnabled')}">
        <input type="checkbox" id="dlg-enabled" ${isEdit && !task.Enabled ? '' : 'checked'}>
        <span>${T('taskModal.enabled')}
          <span class="check-hint">${T('taskModal.enabledHint')}</span>
        </span>
      </label>
    </div>

    <div class="modal-actions">
      <button class="btn-ghost" type="button" onclick="hideModal()">${T('taskModal.cancel')}</button>
      <button class="btn-glow" type="button" id="btn-save-task" onclick="saveTask(${isEdit ? `'${escHandler(task.Id)}'` : 'null'})">${isEdit
        ? `<i data-lucide="save"></i> ${T('taskModal.save')}`
        : `<i data-lucide="plus"></i> ${T('taskModal.create')}`}</button>
    </div>
  `, true);

  // Smart cron
  smartCron = new SmartCronInput('#smart-cron-container', { value: cron, excludeId: isEdit ? task.Id : null, onChange: updateTaskDialogSummary });

  scriptEditorSwitchMode(_scriptMode, false);
  simpleRichText.renderPreview(document.getElementById('task-description-preview'), { Description: _taskDescriptionText, DescriptionHtml: _taskDescriptionHtml });

  ['dlg-name', 'dlg-script', 'dlg-args', 'dlg-workdir', 'dlg-enabled'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateTaskDialogSummary);
    if (el) el.addEventListener('change', updateTaskDialogSummary);
  });
  updateTaskDialogSummary();

  // Enter to save
  document.getElementById('dlg-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btn-save-task').click(); });
  lucide.createIcons();
}

/**
 * What this task will be, restated while it is being written. The fields are
 * spread over four sections; without this the operator cannot see the result
 * without scrolling back up.
 */
function updateTaskDialogSummary() {
  const host = document.getElementById('task-dialog-summary');
  if (!host) return;
  const T = (k) => escHtml(i18n.t(k));
  const value = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  };
  const name = value('dlg-name') || T('taskModal.summaryUnnamed');
  const cron = (smartCron && smartCron.getValue()) || '';
  const command = _scriptMode === 'editor'
    ? `${_scriptType.toUpperCase()} · ${T('taskModal.summaryInline')}`
    : value('dlg-script') || T('taskModal.summaryNoCommand');
  const args = value('dlg-args');
  const enabled = document.getElementById('dlg-enabled') && document.getElementById('dlg-enabled').checked;

  const cell = (key, label, valueHtml) =>
    `<div class="modal-summary-item" data-summary="${key}">
       <span class="modal-summary-label">${label}</span>
       <span class="modal-summary-value">${valueHtml}</span>
     </div>`;

  host.innerHTML =
    cell('name', T('taskModal.name'), escHtml(name)) +
    cell('cron', T('history.colCron'), `<code>${escHtml(cron || '-')}</code>`) +
    cell('command', T('taskModal.summaryCommand'), escHtml(command) + (args ? ` <span style="color:var(--text3)">${escHtml(args)}</span>` : '')) +
    cell('state', T('history.state'), T(enabled ? 'tasks.enabled' : 'tasks.disabled'));
}

// Script mode switching
let _scriptMode = 'file';
let _scriptContent = '';
let _scriptType = 'ps1';
let _taskDescriptionText = '';
let _taskDescriptionHtml = '';


function scriptEditorSwitchMode(mode, openEditor = true) {
  _scriptMode = mode;
  const fileTab = document.getElementById('tab-file');
  const editorTab = document.getElementById('tab-editor');
  const filePanel = document.getElementById('script-mode-file');
  const editorPanel = document.getElementById('script-mode-editor');
  if (fileTab) fileTab.classList.toggle('active', mode === 'file');
  if (editorTab) editorTab.classList.toggle('active', mode === 'editor');
  if (filePanel) filePanel.style.display = mode === 'file' ? '' : 'none';
  if (editorPanel) editorPanel.style.display = mode === 'editor' ? '' : 'none';
  if (typeof updateTaskDialogSummary === 'function') updateTaskDialogSummary();
  if (mode !== 'editor' || !openEditor) return;
  scriptEditor.open({
    content: _scriptContent,
    type: _scriptType,
    onApply: result => {
      _scriptContent = result.content;
      _scriptType = result.type;
      const summary = document.getElementById('script-editor-summary');
      if (summary) summary.textContent = `${result.content.length} ${i18n.t('scriptEditor.characters')}`;
    },
  });
}

function editTaskDescription() {
  simpleRichText.open({
    html: _taskDescriptionHtml,
    text: _taskDescriptionText,
    onApply: result => {
      _taskDescriptionHtml = result.html;
      _taskDescriptionText = result.text;
      const summary = document.getElementById('task-description-summary');
      if (summary) summary.textContent = result.text ? i18n.t('richText.editedDescription') : i18n.t('richText.emptyDescription');
      simpleRichText.renderPreview(document.getElementById('task-description-preview'), result);
    },
  });
}

async function saveTask(editId) {
  const name = document.getElementById('dlg-name').value.trim();
  if (!name) { showToast(i18n.t('toast.taskNameRequired'), 'error'); document.getElementById('dlg-name').focus(); return; }
  if (!smartCron || !smartCron.isValid()) { showToast(i18n.t('toast.invalidCron'), 'error'); return; }
  const cron = smartCron.getValue();
  const btn = document.getElementById('btn-save-task');

  try {
    // The parser lives in the main process, so its answer is the one that
    // decides whether the task may be saved.
    const cronOk = await window.api.validateCron(cron);
    if (!cronOk) { showToast(i18n.t('toast.invalidCron'), 'error'); return; }

    let scriptPath = '';
    let scriptContent = '';
    let scriptType = '';

    if (_scriptMode === 'editor') {
      const content = _scriptContent.trim();
      if (!content) { showToast(i18n.t('toast.scriptContentRequired'), 'error'); return; }
      scriptContent = content;
      scriptType = _scriptType;
      const ext = _scriptType === 'bat' ? '.bat' : '.ps1';
      const scriptsDir = await window.api.getScriptsDir();
      const taskId = editId || 'task-' + Date.now();
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
      scriptPath = `${scriptsDir}\\${safeName}_${taskId.substring(0, 8)}${ext}`;
      const saveResult = await window.api.saveScriptFile(scriptPath, content);
      if (!saveResult || !saveResult.success) throw new Error((saveResult && saveResult.message) || i18n.t('toast.scriptSaveFailed'));
    } else {
      scriptPath = document.getElementById('dlg-script').value.trim();
      if (!scriptPath) { showToast(i18n.t('toast.scriptPathRequired'), 'error'); document.getElementById('dlg-script').focus(); return; }
    }

    const data = {
      Name: name, CronExpression: cron, ScriptPath: scriptPath,
      ScriptContent: scriptContent, ScriptType: scriptType,
      Arguments: document.getElementById('dlg-args').value,
      WorkingDirectory: document.getElementById('dlg-workdir').value,
      Description: _taskDescriptionText,
      DescriptionHtml: _taskDescriptionHtml,
      Enabled: document.getElementById('dlg-enabled').checked,
    };

    btn.disabled = true;
    btn.style.opacity = '0.5';
    const result = editId
      ? await window.api.updateTask({ ...data, Id: editId })
      : await window.api.addTask(data);
    if (!result || result.success === false) throw new Error((result && result.message) || i18n.t('toast.taskSaveFailed'));

    swrInvalidate('tasks');
    showToast(i18n.t(editId ? 'toast.taskUpdated' : 'toast.taskCreated'), 'success');
    scriptEditor.destroy();
    hideModal();
    refreshTasks();
    refreshDashboard();
  } catch (error) {
    showToast(error && error.message ? error.message : i18n.t('toast.taskSaveFailed'), 'error');
  } finally {
    if (btn && btn.isConnected) {
      btn.disabled = false;
      btn.style.opacity = '';
    }
  }
}

// ─── Task history ───
//
// The list is a preview, not the record: it draws the most recent N runs and
// every row opens the full entry in its own modal, instead of stretching a
// scroll container with thousands of blocks (which is what made the entries
// collapse into each other).
const HISTORY_PAGE = 50;
let historyModalTask = null;
let historyModalEntries = [];
let historyModalLimit = HISTORY_PAGE;

async function showTaskHistory(taskId) {
  const task = allTasks.find(t => t.Id === taskId);
  if (!task) return;

  // Always refetch: the cached copy is what the dashboard loaded, and it is
  // older than the run the user just triggered.
  try { allHistory = (await window.api.getHistory()) || []; }
  catch (e) { allHistory = []; }

  historyModalTask = task;
  historyModalEntries = allHistory.filter(h => h.TaskId === taskId);
  historyModalLimit = HISTORY_PAGE;
  renderTaskHistoryModal();
}

function historyStatusIcon(status) {
  return status === 'Success'
    ? '<span style="color:var(--green)">&#10003;</span>'
    : '<span style="color:var(--red)">&#10007;</span>';
}

function renderTaskHistoryModal() {
  const task = historyModalTask;
  if (!task) return;
  const T = (k, p) => escHtml(i18n.t(k, p));
  const entries = historyModalEntries;
  const shown = entries.slice(0, historyModalLimit);
  const remaining = entries.length - shown.length;

  const rows = shown.length ? shown.map((e, i) => `
    <button type="button" class="th-entry" data-history-index="${i}">
      <span class="th-row">
        <span class="th-icon">${historyStatusIcon(e.Status)}</span>
        <span class="th-time">${escHtml(formatTime(e.Timestamp))}</span>
        <span class="th-duration">${escHtml(e.Duration || '-')}</span>
        <span class="badge badge-${e.Status === 'Success' ? 'success' : 'error'}">${escHtml(e.Status || '-')}</span>
        <i data-lucide="chevron-right" class="th-chevron"></i>
      </span>
    </button>`).join('')
    : `<div class="modal-empty"><i data-lucide="history"></i><p>${T('history.noHistory')}</p></div>`;

  showModal(`
    <h2><i data-lucide="history"></i> ${escHtml(task.Name)} <span class="modal-title-sub">${T('history.title')}</span></h2>

    <div class="modal-summary" id="task-history-summary"></div>

    <div class="modal-help">
      <i data-lucide="info"></i>
      <span>${T('history.clickForDetail')}</span>
    </div>

    <div class="task-history-list" id="task-history-list" style="max-height:min(48vh,420px);overflow-y:auto">
      ${rows}
    </div>

    <div class="modal-actions">
      <span class="modal-foot-note">${T(remaining > 0 ? 'history.showingLast' : 'history.totalEntries', { n: shown.length, total: entries.length })}</span>
      ${remaining > 0 ? `<button class="btn-outline btn-sm" id="task-history-more"><i data-lucide="chevrons-down"></i> ${T('history.loadMore', { n: Math.min(remaining, HISTORY_PAGE) })}</button>` : ''}
      ${entries.length > 0 ? `<button class="btn-outline btn-sm" onclick="exportTaskHistory('${escHandler(task.Id)}')"><i data-lucide="download"></i> ${T('history.exportCsv')}</button>` : ''}
      <button class="btn-ghost" onclick="hideModal()">${T('common.close')}</button>
    </div>
  `, true);

  const list = document.getElementById('task-history-list');
  if (list) {
    list.onclick = (e) => {
      const row = e.target.closest('[data-history-index]');
      if (row) showRunDetail(historyModalEntries[+row.dataset.historyIndex], 'task');
    };
  }
  const more = document.getElementById('task-history-more');
  if (more) {
    more.onclick = () => { historyModalLimit += HISTORY_PAGE; renderTaskHistoryModal(); };
  }
  // Paging rebuilds the modal, so the summary has to be painted again.
  refreshHistoryModalSummary();
}

/** The summary needs the next run, which only the main process can compute. */
async function refreshHistoryModalSummary() {
  const task = historyModalTask;
  const host = document.getElementById('task-history-summary');
  if (!task || !host) return;
  renderHistorySummary(host, task, historyModalEntries);
  try {
    const next = await window.api.getNextRun(task.CronExpression);
    if (historyModalTask !== task || !document.getElementById('task-history-summary')) return;
    const cell = host.querySelector('[data-summary="next"] .modal-summary-value');
    if (cell) cell.textContent = next ? formatTime(next) : i18n.t('dash.nothingScheduled');
  } catch (e) { /* the next run is a nicety, not a reason to fail the modal */ }
}

function renderHistorySummary(host, task, entries) {
  const T = (k, p) => escHtml(i18n.t(k, p));
  const failed = entries.filter(e => e.Status !== 'Success').length;
  const cell = (key, label, value) =>
    `<div class="modal-summary-item" data-summary="${key}">
       <span class="modal-summary-label">${label}</span>
       <span class="modal-summary-value">${value}</span>
     </div>`;

  host.innerHTML =
    cell('cron', T('history.colCron'), `<code>${escHtml(task.CronExpression || '-')}</code>`) +
    cell('script', T('history.colScript'), escHtml(task.ScriptPath || T('history.inlineScript'))) +
    cell('next', T('dash.nextRun'), escHtml(i18n.t('dash.loadingShort'))) +
    cell('runs', T('history.entries'), `${entries.length} ${T('history.entriesUnit')}` +
      (failed ? ` <span style="color:var(--red)">· ${T('history.failedCount', { n: failed })}</span>` : '')) +
    cell('state', T('history.state'), task.Enabled === false ? T('tasks.disabled') : T('tasks.enabled'));
}

/**
 * One execution, in full. Reached from the task history, from the dashboard
 * activity list and from the history screen, so the three agree on what a run
 * looks like instead of each growing its own truncated row.
 */
function showRunDetail(entry, kind) {
  if (!entry) return;
  const T = (k, p) => escHtml(i18n.t(k, p));
  const kindName = kind || entry._type || 'task';
  const isBackup = kindName === 'backup';
  const kindLabel = kindName === 'backup' ? 'dash.kindBackup' : kindName === 'sync' ? 'dash.kindSync' : kindName === 'retention' ? 'dash.kindRetention' : 'dash.kindTask';
  const at = entry.Timestamp || entry.timestamp;
  const status = entry.Status || entry.status;
  const duration = entry.Duration || entry.duration;
  const name = entry.TaskName || entry.ProfileName || entry.Name || '-';
  const message = entry.Message != null ? entry.Message : (entry.Output || entry.message || '');
  const ok = status === 'Success';

  const facts = [
    ['when', T('history.colTime'), escHtml(at ? formatTime(at) : '-')],
    ['what', T('history.colWhat'), escHtml(name) + ` <span class="badge badge-info" style="font-size:9px">${T(kindLabel)}</span>`],
    ['status', T('history.colStatus'), `<span class="badge badge-${ok ? 'success' : 'error'}">${escHtml(status || '-')}</span>`],
    ['duration', T('history.colDuration'), escHtml(duration || '-')],
  ];
  if (isBackup && entry.Databases) {
    facts.push(['databases', T('backup.databases'), escHtml([].concat(entry.Databases).join(', '))]);
  }
  if (entry.TotalSizeHuman) {
    facts.push(['size', T('backup.sizeLabel'), escHtml(entry.TotalSizeHuman)]);
  }
  if (entry.FolderPath) facts.push(['folder', T('history.folder'), escHtml(entry.FolderPath)]);
  if (entry.CronExpression) facts.push(['cron', T('history.colCron'), escHtml(entry.CronExpression)]);

  const output = String(message == null ? '' : message).trim();
  const blocks = [];
  if (output) blocks.push(`<div class="th-output-label">${T('history.outputLabel')}</div><pre class="th-output-text">${escHtml(output)}</pre>`);
  if (entry.ErrorMessage) blocks.push(`<div class="th-output-label">${T('history.errorLabel')}</div><pre class="th-output-text">${escHtml(entry.ErrorMessage)}</pre>`);
  // A backup carries its report per database; the whole record is in there.
  if (Array.isArray(entry.Results) && entry.Results.length) {
    blocks.push(`<div class="th-output-label">${T('history.resultsLabel')}</div><pre class="th-output-text">${escHtml(JSON.stringify(entry.Results, null, 2))}</pre>`);
  }
  if (!blocks.length) blocks.push(`<div class="th-output-label">${T('history.outputLabel')}</div><pre class="th-output-text">${T('history.noOutput')}</pre>`);

  showModal(`
    <h2><i data-lucide="${ok ? 'check-circle-2' : 'alert-triangle'}"></i> ${escHtml(name)}</h2>

    <div class="modal-summary">
      ${facts.map(([key, label, value]) => `
        <div class="modal-summary-item" data-summary="${key}">
          <span class="modal-summary-label">${label}</span>
          <span class="modal-summary-value">${value}</span>
        </div>`).join('')}
    </div>

    <div class="modal-help">
      <i data-lucide="terminal"></i>
      <span>${T('history.detailHelp')}</span>
    </div>

    <div class="run-detail-output">${blocks.join('')}</div>

    <div class="modal-actions">
      <button class="btn-ghost" type="button" onclick="hideModal()">${T('common.close')}</button>
    </div>
  `, true);
  lucide.createIcons();
}

function exportTaskHistory(taskId) {
  const entries = (allHistory || []).filter(h => h.TaskId === taskId);
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
      <button class="btn-danger" onclick="confirmDelete('${escHandler(id)}')"><i data-lucide="trash-2"></i> Delete</button>
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
              <button class="btn-glow" onclick="restartServiceFromBadge('${escHandler(status.serviceName)}')"><i data-lucide="rotate-cw"></i> Restart</button>
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
    return `<tr class="${cls}" onclick="editServiceScript('${escHandler(s.Name)}')" title="${escHtml(i18n.t('svc.clickToEdit'))}">
      <td>${escHtml(s.Name)}${isManaged ? `<span class="badge badge-info" style="font-size:9px;margin-left:6px">${escHtml(i18n.t('svc.managed'))}</span>` : ''}</td>
      <td><span class="badge badge-${isRunning ? 'success' : 'error'}">${escHtml(s.Status)}</span></td>
      <td>${escHtml(s.Application || '-')}</td>
      <td>${escHtml(s.StartupType)}</td>
      <td onclick="event.stopPropagation()">
        ${!isRunning ? `<button class="btn-secondary-sm" onclick="svcAction('start','${escHandler(s.Name)}')" title="${escHtml(i18n.t('svc.start'))}"><i data-lucide="play"></i></button>` : ''}
        ${isRunning ? `<button class="btn-secondary-sm" onclick="svcAction('stop','${escHandler(s.Name)}')" title="${escHtml(i18n.t('svc.stop'))}"><i data-lucide="square"></i></button>` : ''}
        <button class="btn-secondary-sm" onclick="svcAction('restart','${escHandler(s.Name)}')" title="${escHtml(i18n.t('svc.restart'))}"><i data-lucide="rotate-cw"></i></button>
        <button class="btn-secondary-sm" onclick="cloneService('${escHandler(s.Name)}')" title="${escHtml(i18n.t('svc.clone'))}"><i data-lucide="copy"></i></button>
        <button class="btn-danger" onclick="svcAction('uninstall','${escHandler(s.Name)}')" title="${escHtml(i18n.t('svc.remove'))}"><i data-lucide="trash-2"></i></button>
      </td>
    </tr>`;
  }).join('');
  lucide.createIcons();
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
      <button class="btn-glow" onclick="saveServiceParams('${escHandler(serviceName)}')"><i data-lucide="save"></i> Save</button>
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
        <button class="btn-danger" onclick="hideModal();confirmSvcUninstall('${escHandler(name)}')"><i data-lucide="trash-2"></i> Uninstall</button>
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
      <button class="btn-glow" style="width:100%;justify-content:center;" onclick="installNssm('${escHandler(m.name)}')">
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
// The merged list currently drawn on the History screen, so a click can hand
// the entry to the detail modal without re-encoding it in markup.
let historyScreenRows = [];

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

  historyScreenRows = all;
  const tbody = document.getElementById('history-body');
  const empty = document.getElementById('history-empty');
  if (all.length === 0) { tbody.innerHTML = ''; tbody.onclick = null; empty.style.display = 'block'; lucide.createIcons(); return; }
  empty.style.display = 'none';
  tbody.innerHTML = historyScreenRows.map((h, i) => {
    const isBackup = h._type === 'backup';
    const typeBadge = isBackup
      ? `<span class="badge badge-info" style="font-size:9px">${escHtml(i18n.t('dash.kindBackup'))}</span>`
      : `<span class="badge badge-active" style="font-size:9px">${escHtml(i18n.t('dash.kindTask'))}</span>`;
    const statusClass = h.Status === 'Success' ? 'success' : 'error';
    return `<tr class="row-clickable" data-history-row="${i}" title="${escAttr(i18n.t('dash.activityClickHint'))}">
      <td>${escHtml(formatTime(h.Timestamp))}</td>
      <td>${typeBadge} ${escHtml(h.TaskName)}</td>
      <td>${escHtml(h.CronExpression || h.Duration || '')}</td>
      <td><span class="badge badge-${statusClass}">${escHtml(h.Status || '-')}</span></td>
      <td>${escHtml(h.Duration || '-')}</td>
    </tr>`;
  }).join('');

  // Task rows open the run detail; backup rows keep the backup history screen,
  // which the backup page owns.
  tbody.onclick = (e) => {
    const row = e.target.closest('[data-history-row]');
    if (!row) return;
    const entry = historyScreenRows[+row.dataset.historyRow];
    if (!entry) return;
    if (entry._type === 'backup') {
      if (entry.ProfileId && window.backupPage) backupPage.showHistory(entry.ProfileId);
      else showRunDetail(entry, 'backup');
      return;
    }
    showRunDetail(entry, 'task');
  };
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
  else if (page === 'sync') await syncPage.load();
  else if (page === 'retention') await retentionPage.load();
  else if (page === 'network') await networkPage.load();
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
function escHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

/** Escape a value that lands inside an HTML attribute (value, title, data-*). */
function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

/**
 * Escape a value that lands inside a single-quoted string literal of an inline
 * handler, as in onclick="run('...')".
 *
 * Backslashes are escaped first, otherwise a Windows path arrives as
 * C:Scriptsbackup.ps1 (\\b is a backspace) and the whole line silently loses
 * every folder separator. The ampersand is escaped for the HTML attribute the
 * literal lives in, and the quote for the JS literal, so a name with an
 * apostrophe cannot break out of the call.
 */
function escHandler(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}
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
  showModal(`<div class="gh-shell">
    <div class="gh-loading" id="gh-loading"><i data-lucide="loader"></i><p>${escHtml(i18n.t('credits.loading'))}</p></div>
    <div id="gh-content" style="display:none"></div>
  </div>`);
  try {
    const [userRes, reposRes] = await Promise.all([
      fetch(`https://api.github.com/users/${GH_USERNAME}`),
      fetch(`https://api.github.com/users/${GH_USERNAME}/repos?sort=updated&per_page=6`)
    ]);
    const user = await userRes.json();
    const repos = await reposRes.json();

    const loading = document.getElementById('gh-loading');
    const content = document.getElementById('gh-content');

    // Tudo que vem da API do GitHub passa por escHtml/escAttr. Descrição de
    // repositório e bio são texto livre de terceiros e iam direto para o
    // innerHTML: um <img onerror=...> ali é execução de script dentro do app.
    const location = user.location ? `<span><i data-lucide="map-pin"></i>${escHtml(user.location)}</span>` : '';
    const company = user.company ? `<span><i data-lucide="building-2"></i>${escHtml(user.company)}</span>` : '';
    const blog = user.blog ? `<a href="${escAttr(user.blog.startsWith('http') ? user.blog : 'https://' + user.blog)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary);text-decoration:none;"><i data-lucide="link"></i>${escHtml(user.blog)}</a>` : '';

    let reposHtml = '';
    if (repos.length > 0) {
      reposHtml = `
        <div class="gh-repos">
          <h4><i data-lucide="folder-git-2"></i> ${escHtml(i18n.t('credits.reposTitle'))}</h4>
          <div class="gh-repo-list">
            ${repos.map(r => `
              <a class="gh-repo" href="${escAttr(r.html_url)}" target="_blank" rel="noopener noreferrer">
                <div>
                  <div class="gh-repo-name">${escHtml(r.name)}</div>
                  ${r.description ? `<div class="gh-repo-desc">${escHtml(r.description.substring(0, 80))}</div>` : ''}
                </div>
                <div style="text-align:right;flex-shrink:0;margin-left:12px;">
                  ${r.language ? `<div class="gh-repo-lang">${escHtml(r.language)}</div>` : ''}
                  <div style="font-size:11px;color:#7a7a8c;margin-top:4px;display:flex;align-items:center;gap:4px;justify-content:flex-end;"><i data-lucide="star" style="width:12px;height:12px;"></i>${Number(r.stargazers_count) || 0}</div>
                </div>
              </a>
            `).join('')}
          </div>
        </div>`;
    }

    content.innerHTML = `
      <div class="gh-profile">
        <div class="gh-header">
          <img class="gh-avatar" src="${escAttr(user.avatar_url)}" alt="${escAttr(user.login)}"/>
          <div class="gh-info">
            <h3>${escHtml(user.name || user.login)}</h3>
            <div class="gh-login">@${escHtml(user.login)}</div>
            ${user.bio ? `<div class="gh-bio">${escHtml(user.bio)}</div>` : ''}
            <div class="gh-meta">
              ${location}
              ${company}
              ${blog}
              <span><i data-lucide="calendar"></i>${escHtml(i18n.t('credits.joined').replace('{when}', new Date(user.created_at).toLocaleDateString(i18n.getLang() === 'pt-BR' ? 'pt-BR' : 'en-US', { month: 'short', year: 'numeric' })))}</span>
            </div>
          </div>
        </div>
        <div class="gh-actions">
          <a class="gh-coffee-btn" href="https://www.buymeacoffee.com/lindsonfranca" target="_blank" rel="noopener noreferrer">
            <i data-lucide="coffee"></i> ${escHtml(i18n.t('credits.donate'))}
          </a>
          <div class="gh-coffee-note">
            <i data-lucide="sparkles"></i> ${escHtml(i18n.t('credits.donateNote'))}
          </div>
          <div class="gh-secondary-links">
            <a href="https://github.com/${escAttr(user.login)}" target="_blank" rel="noopener noreferrer">
              <i data-lucide="github"></i> ${escHtml(i18n.t('credits.viewProfile'))}
            </a>
            <a href="https://github.com/L1NDS0N/KyriosKronou/releases" target="_blank" rel="noopener noreferrer">
              <i data-lucide="download"></i> ${escHtml(i18n.t('credits.releases'))}
            </a>
          </div>
        </div>
        <div class="gh-stats">
          <div class="gh-stat"><div class="gh-stat-value">${Number(user.public_repos) || 0}</div><div class="gh-stat-label">${escHtml(i18n.t('credits.statRepos'))}</div></div>
          <div class="gh-stat"><div class="gh-stat-value">${Number(user.followers) || 0}</div><div class="gh-stat-label">${escHtml(i18n.t('credits.statFollowers'))}</div></div>
          <div class="gh-stat"><div class="gh-stat-value">${Number(user.following) || 0}</div><div class="gh-stat-label">${escHtml(i18n.t('credits.statFollowing'))}</div></div>
          <div class="gh-stat"><div class="gh-stat-value">${Number(user.public_gists) || 0}</div><div class="gh-stat-label">${escHtml(i18n.t('credits.statGists'))}</div></div>
        </div>
        ${reposHtml}
      </div>`;

    loading.style.display = 'none';
    content.style.display = 'block';
    lucide.createIcons();
  } catch (e) {
    const loading = document.getElementById('gh-loading');
    if (loading) loading.innerHTML = `<p style="color:var(--red);">${escHtml(i18n.t('credits.loadFailed'))}</p>`;
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
  // A level filter from one tab means nothing on another.
  logFilters.level = '';
  logPageSize = LOG_PAGE;
  renderLogFilters();
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
      // The level/action options come from the data, so the filter bar has to
      // be rebuilt whenever the data changes - not only on the fallback path.
      renderLogFilters();
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
    renderLogFilters();
    renderLogsTable();
  } catch (e) {
    console.error('Failed to load logs:', e);
  }
}

// ─── Logs screen ───
//
// Rewritten after a crash report found in the app's own error log:
// renderLogsTable wrote into #logs-table-wrap with innerHTML, which destroyed
// the #logs-empty element living inside it, and the next render then did
// empty.style.display on null. The empty state is now a sibling that is never
// replaced.
//
// Filters live here rather than in the main process: the data is already
// loaded, and filtering in the renderer keeps typing instant.

let logFilters = { text: '', level: '', since: '24h' };
const LOG_PAGE = 200;
let logPageSize = LOG_PAGE;
// The rows currently drawn, resolved by the click handler on the row index.
let logPageRows = [];

function logsSince() {
  const now = Date.now();
  switch (logFilters.since) {
    case '1h': return now - 3600000;
    case '24h': return now - 86400000;
    case '7d': return now - 7 * 86400000;
    default: return 0;
  }
}

/** Rows for the current tab, after filters. */
function filteredLogRows() {
  const since = logsSince();
  const text = logFilters.text.trim().toLowerCase();

  const matches = (haystack) => !text || String(haystack).toLowerCase().includes(text);
  const inRange = (ts) => new Date(ts).getTime() >= since;

  if (currentLogTab === 'errors') {
    return allErrors.filter(e => inRange(e.timestamp)
      && matches(e.message + ' ' + (e.error ? e.error.message : '') + ' ' + JSON.stringify(e.context || '')));
  }

  if (currentLogTab === 'audit') {
    return allAudit.filter(a => inRange(a.timestamp)
      && (!logFilters.level || a.action === logFilters.level)
      && matches([a.action, a.target, a.actor, JSON.stringify(a.before || ''), JSON.stringify(a.after || '')].join(' ')));
  }

  return allLogs.filter(l => inRange(l.timestamp)
    && (!logFilters.level || (l.level || 'INFO').toUpperCase() === logFilters.level)
    && matches(l.message + ' ' + JSON.stringify(l.meta || '')));
}

function renderLogFilters() {
  const host = document.getElementById('logs-filters');
  if (!host) return;

  // A background refresh must not yank the caret out of the search box.
  if (document.activeElement && document.activeElement.id === 'log-search') {
    updateLogCount();
    return;
  }

  // The level filter offers what is actually present, so it never lists an
  // option that would return nothing.
  let levelOptions = '';
  if (currentLogTab === 'app') {
    const levels = [...new Set(allLogs.map(l => (l.level || 'INFO').toUpperCase()))].sort();
    levelOptions = `<select class="form-input" id="log-level">
      <option value="">${escHtml(i18n.t('logs.allLevels'))}</option>
      ${levels.map(lv => `<option value="${escHtml(lv)}" ${logFilters.level === lv ? 'selected' : ''}>${escHtml(lv)}</option>`).join('')}
    </select>`;
  } else if (currentLogTab === 'audit') {
    const actions = [...new Set(allAudit.map(a => a.action).filter(Boolean))].sort();
    levelOptions = `<select class="form-input" id="log-level">
      <option value="">${escHtml(i18n.t('logs.allActions'))}</option>
      ${actions.map(a => `<option value="${escHtml(a)}" ${logFilters.level === a ? 'selected' : ''}>${escHtml(a)}</option>`).join('')}
    </select>`;
  }

  host.innerHTML = `
    <div class="logs-filter-row">
      <div class="search-input logs-search">
        <i data-lucide="search" class="search-icon"></i>
        <input type="text" id="log-search" placeholder="${escHtml(i18n.t('logs.searchPlaceholder'))}" value="${escHtml(logFilters.text)}">
      </div>
      ${levelOptions}
      <select class="form-input" id="log-since">
        <option value="1h" ${logFilters.since === '1h' ? 'selected' : ''}>${escHtml(i18n.t('logs.lastHour'))}</option>
        <option value="24h" ${logFilters.since === '24h' ? 'selected' : ''}>${escHtml(i18n.t('logs.last24h'))}</option>
        <option value="7d" ${logFilters.since === '7d' ? 'selected' : ''}>${escHtml(i18n.t('logs.last7d'))}</option>
        <option value="all" ${logFilters.since === 'all' ? 'selected' : ''}>${escHtml(i18n.t('logs.allTime'))}</option>
      </select>
      <button class="btn-ghost btn-sm" id="log-clear-filters">${escHtml(i18n.t('logs.clearFilters'))}</button>
      <span class="logs-count" id="logs-count"></span>
    </div>`;

  const search = document.getElementById('log-search');
  let typing = null;
  search.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      logFilters.text = search.value;
      logPageSize = LOG_PAGE;
      renderLogsTable();
      // Re-rendering the filter bar would steal focus mid-word.
      updateLogCount();
    }, 180);
  });

  const level = document.getElementById('log-level');
  if (level) level.addEventListener('change', () => { logFilters.level = level.value; logPageSize = LOG_PAGE; renderLogsTable(); updateLogCount(); });

  document.getElementById('log-since').addEventListener('change', (e) => {
    logFilters.since = e.target.value; logPageSize = LOG_PAGE; renderLogsTable(); updateLogCount();
  });

  document.getElementById('log-clear-filters').addEventListener('click', () => {
    logFilters = { text: '', level: '', since: '24h' };
    logPageSize = LOG_PAGE;
    renderLogFilters();
    renderLogsTable();
  });

  lucide.createIcons();
  updateLogCount();
}

function updateLogCount() {
  const el = document.getElementById('logs-count');
  if (!el) return;
  const total = currentLogTab === 'errors' ? allErrors.length : currentLogTab === 'audit' ? allAudit.length : allLogs.length;
  const shown = filteredLogRows().length;
  el.textContent = shown === total
    ? i18n.t('logs.showingAll', { n: total })
    : i18n.t('logs.showingFiltered', { n: shown, total });
}

function renderLogsStats() {
  const stats = document.getElementById('logs-stats');
  if (!stats) return;
  stats.innerHTML = `
    <div class="logs-stat">
      <div class="logs-stat-icon errors"><i data-lucide="alert-circle"></i></div>
      <div class="logs-stat-info"><div class="logs-stat-value">${allErrors.length}</div><div class="logs-stat-label">${escHtml(i18n.t('logs.errors'))}</div></div>
    </div>
    <div class="logs-stat">
      <div class="logs-stat-icon audit"><i data-lucide="shield"></i></div>
      <div class="logs-stat-info"><div class="logs-stat-value">${allAudit.length}</div><div class="logs-stat-label">${escHtml(i18n.t('logs.auditEvents'))}</div></div>
    </div>
    <div class="logs-stat">
      <div class="logs-stat-icon total"><i data-lucide="scroll-text"></i></div>
      <div class="logs-stat-info"><div class="logs-stat-value">${allLogs.length}</div><div class="logs-stat-label">${escHtml(i18n.t('logs.totalLogs'))}</div></div>
    </div>
  `;
  lucide.createIcons();
}

function renderLogsTable() {
  const wrap = document.getElementById('logs-table-wrap');
  const empty = document.getElementById('logs-empty');
  if (!wrap) return;

  const rows = filteredLogRows().slice().reverse();

  // The empty state is a sibling of the table host, so replacing the table
  // never destroys it - the previous version did, and the next render then
  // crashed on a null reference.
  if (empty) empty.style.display = rows.length ? 'none' : 'block';
  if (!rows.length) { wrap.innerHTML = ''; logPageRows = []; lucide.createIcons(); return; }

  const page = rows.slice(0, logPageSize);
  const more = rows.length - page.length;
  logPageRows = page;

  // The row keeps only what identifies it; the full entry opens in a modal, so
  // no cell has to grow a max-height to show the rest.
  const row = (index, cls, cells) =>
    `<tr class="${cls} row-clickable" data-log-index="${index}" tabindex="0" title="${escAttr(i18n.t('logs.openDetail'))}">${cells}</tr>`;

  let table;
  if (currentLogTab === 'errors') {
    table = `<div class="table-wrap table-scroll" data-min="620"><table class="logs-table"><thead><tr>
        <th>${escHtml(i18n.t('logs.colTime'))}</th><th>${escHtml(i18n.t('logs.colLevel'))}</th>
        <th>${escHtml(i18n.t('logs.colMessage'))}</th><th>${escHtml(i18n.t('logs.colDetails'))}</th>
      </tr></thead><tbody>${page.map((e, i) => row(i, 'log-row-error',
        `<td class="log-ts">${escHtml(formatTime(e.timestamp))}</td>
        <td><span class="log-level error">ERROR</span></td>
        <td class="log-message">${escHtml(e.message)}</td>
        <td class="log-meta">${e.error ? escHtml(e.error.message) : ''}${e.context ? `<br><span style="color:var(--text3)">${escHtml(JSON.stringify(e.context))}</span>` : ''}</td>`
      )).join('')}</tbody></table></div>`;
  } else if (currentLogTab === 'audit') {
    table = `<div class="table-wrap table-scroll" data-min="620"><table class="logs-table"><thead><tr>
        <th>${escHtml(i18n.t('logs.colTime'))}</th><th>${escHtml(i18n.t('logs.colAction'))}</th>
        <th>${escHtml(i18n.t('logs.colActor'))}</th><th>${escHtml(i18n.t('logs.colTarget'))}</th>
        <th>${escHtml(i18n.t('logs.colChange'))}</th>
      </tr></thead><tbody>${page.map((a, i) => row(i, 'log-row-audit',
        `<td class="log-ts">${escHtml(formatTime(a.timestamp))}</td>
        <td><span class="log-action">${escHtml(a.action)}</span></td>
        <td class="log-actor">${a.actor ? escHtml(a.actor) : `<span class="muted">${escHtml(i18n.t('logs.system'))}</span>`}${a.ipAddress ? `<br><span class="log-ip">${escHtml(a.ipAddress)}</span>` : ''}</td>
        <td class="log-target">${a.target ? escHtml(String(a.target)) : '-'}</td>
        <td class="log-meta">${[
          a.before ? escHtml(i18n.t('logs.before')) + ': ' + escHtml(JSON.stringify(a.before)) : '',
          a.after ? escHtml(i18n.t('logs.after')) + ': ' + escHtml(JSON.stringify(a.after)) : '',
        ].filter(Boolean).join('<br>') || '-'}</td>`
      )).join('')}</tbody></table></div>`;
  } else {
    table = `<div class="table-wrap table-scroll" data-min="620"><table class="logs-table"><thead><tr>
        <th>${escHtml(i18n.t('logs.colTime'))}</th><th>${escHtml(i18n.t('logs.colLevel'))}</th><th>${escHtml(i18n.t('logs.colMessage'))}</th>
      </tr></thead><tbody>${page.map((l, i) => {
        const level = (l.level || 'INFO').toLowerCase();
        const rowClass = level === 'error' ? 'log-row-error' : level === 'warn' ? 'log-row-warn' : '';
        return row(i, rowClass,
          `<td class="log-ts">${escHtml(formatTime(l.timestamp))}</td>
          <td><span class="log-level ${level}">${escHtml(l.level || 'INFO')}</span></td>
          <td class="log-message">${escHtml(l.message)}${l.meta ? `<br><span class="log-meta">${escHtml(JSON.stringify(l.meta))}</span>` : ''}</td>`
        );
      }).join('')}</tbody></table></div>`;
  }

  // Rendering thousands of rows at once is what made the screen feel stuck.
  if (more > 0) {
    table += `<button type="button" class="btn-ghost logs-more" id="logs-more">${escHtml(i18n.t('logs.loadMore', { n: Math.min(more, LOG_PAGE) }))}</button>`;
  }

  wrap.innerHTML = table;
  const moreBtn = document.getElementById('logs-more');
  if (moreBtn) moreBtn.addEventListener('click', () => { logPageSize += LOG_PAGE; renderLogsTable(); });

  lucide.createIcons();
}

// One listener for every tab and every page: the host is replaced on each
// render, the row indexes resolve against whatever is drawn right now.
(function wireLogRowDetail() {
  const wrap = document.getElementById('logs-table-wrap');
  if (!wrap) return;
  const open = (e) => {
    const target = e.target.closest('[data-log-index]');
    if (!target) return;
    const entry = logPageRows[+target.dataset.logIndex];
    if (entry) showLogDetail(currentLogTab, entry);
  };
  wrap.addEventListener('click', open);
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target.closest('[data-log-index]');
    if (!target) return;
    e.preventDefault();
    open(e);
  });
})();

/** One log entry in full - the same place the table's truncated cell pointed. */
function showLogDetail(tab, entry) {
  if (!entry) return;
  const T = (k, p) => escHtml(i18n.t(k, p));
  const facts = [];
  const blocks = [];
  const push = (text) => { if (text) blocks.push(text); };

  facts.push(['when', T('logs.colTime'), escHtml(formatTime(entry.timestamp))]);

  if (tab === 'errors') {
    facts.push(['level', T('logs.colLevel'), '<span class="log-level error">ERROR</span>']);
    push(`<div class="th-output-label">${T('logs.colMessage')}</div><pre class="th-output-text">${escHtml(entry.message)}</pre>`);
    if (entry.error && entry.error.message) {
      push(`<div class="th-output-label">${T('logs.colDetails')}</div><pre class="th-output-text">${escHtml(entry.error.message)}</pre>`);
    }
    if (entry.error && entry.error.stack) {
      push(`<div class="th-output-label">${T('logs.stack')}</div><pre class="th-output-text">${escHtml(entry.error.stack)}</pre>`);
    }
    if (entry.context) {
      push(`<div class="th-output-label">${T('logs.context')}</div><pre class="th-output-text">${escHtml(JSON.stringify(entry.context, null, 2))}</pre>`);
    }
  } else if (tab === 'audit') {
    facts.push(['action', T('logs.colAction'), escHtml(entry.action || '-')]);
    facts.push(['actor', T('logs.colActor'), escHtml(entry.actor || i18n.t('logs.system')) + (entry.ipAddress ? ` <span class="log-ip">${escHtml(entry.ipAddress)}</span>` : '')]);
    facts.push(['target', T('logs.colTarget'), escHtml(entry.target ? String(entry.target) : '-')]);
    if (entry.before) push(`<div class="th-output-label">${T('logs.before')}</div><pre class="th-output-text">${escHtml(JSON.stringify(entry.before, null, 2))}</pre>`);
    if (entry.after) push(`<div class="th-output-label">${T('logs.after')}</div><pre class="th-output-text">${escHtml(JSON.stringify(entry.after, null, 2))}</pre>`);
  } else {
    const level = (entry.level || 'INFO').toUpperCase();
    facts.push(['level', T('logs.colLevel'), `<span class="log-level ${level.toLowerCase()}">${escHtml(level)}</span>`]);
    push(`<div class="th-output-label">${T('logs.colMessage')}</div><pre class="th-output-text">${escHtml(entry.message)}</pre>`);
    if (entry.meta) push(`<div class="th-output-label">${T('logs.meta')}</div><pre class="th-output-text">${escHtml(JSON.stringify(entry.meta, null, 2))}</pre>`);
  }

  if (!blocks.length) blocks.push(`<pre class="th-output-text">${T('logs.noDetails')}</pre>`);

  showModal(`
    <h2><i data-lucide="scroll-text"></i> ${T('logs.detailTitle', { tab: T('logs.' + tab) })}</h2>

    <div class="modal-summary">
      ${facts.map(([key, label, value]) => `
        <div class="modal-summary-item" data-summary="${key}">
          <span class="modal-summary-label">${label}</span>
          <span class="modal-summary-value">${value}</span>
        </div>`).join('')}
    </div>

    <div class="run-detail-output">${blocks.join('')}</div>

    <div class="modal-actions">
      <button class="btn-ghost" type="button" onclick="hideModal()">${T('common.close')}</button>
    </div>
  `, true);
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
  // O menu da bandeja é montado no processo main e não vê esta tela. Sem
  // avisar o idioma, ele ficava em inglês - o único lugar da interface que não
  // falava a língua do usuário.
  if (window.api.setUiLanguage) window.api.setUiLanguage(savedLang);
  i18n.onChange(() => {
    applyTranslations();
    if (window.api.setUiLanguage) window.api.setUiLanguage(i18n.getLang());
  });
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
    if (window.webPermissionsUI) {
      window.webPermissionsUI.access = cfg;
      if (!window.webPermissionsUI.selected) window.webPermissionsUI.selected = cfg.users[0] || null;
      window.webPermissionsUI.render();
    }

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
