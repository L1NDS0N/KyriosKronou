// app.js - Frontend Application Logic (Enhanced UX)
let allTasks = [];
let allHistory = [];
let currentFilter = 'all';
let smartCron = null;
let autoRefreshTimer = null;

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
  // Focus first input
  setTimeout(() => {
    const firstInput = document.querySelector('#modal-body input[type="text"], #modal-body textarea');
    if (firstInput) firstInput.focus();
  }, 100);
}
function hideModal() {
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

    const total = allTasks.length;
    const active = allTasks.filter(t => t.Enabled).length;
    const errors = allHistory.filter(h => h.Status === 'Error' && new Date(h.Timestamp) > new Date(Date.now() - 86400000)).length;

    animateCounter('stat-total', total);
    animateCounter('stat-active', active);
    animateCounter('stat-errors', errors);

    const count = await window.api.getServiceCount();
    animateCounter('stat-services', count);

    const recent = allHistory.slice(0, 10);
    const tbody = document.getElementById('recent-body');
    const empty = document.getElementById('recent-empty');
    if (recent.length === 0) { tbody.innerHTML = ''; empty.style.display = 'block'; }
    else {
      empty.style.display = 'none';
      tbody.innerHTML = recent.map(h => `<tr>
        <td>${formatTime(h.Timestamp)}</td><td>${h.TaskName}</td>
        <td><span class="badge badge-${h.Status === 'Success' ? 'success' : 'error'}">${h.Status}</span></td>
        <td>${h.Duration || '-'}</td>
      </tr>`).join('');
    }

    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    if (count > 0) { dot.style.background = 'var(--green)'; statusText.textContent = `${count} service(s)`; }
    else { dot.style.background = 'var(--text3)'; statusText.textContent = 'No services'; }
    lucide.createIcons();
  } finally { setLoading('page-dashboard', false); }
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
  setLoading('page-tasks', true);
  try {
    allTasks = await window.api.getTasks();
    renderTasks();
  } finally { setLoading('page-tasks', false); }
}

function renderTasks() {
  const search = document.getElementById('search-tasks').value.toLowerCase();
  const filtered = search ? allTasks.filter(t => t.Name.toLowerCase().includes(search) || (t.Description || '').toLowerCase().includes(search)) : allTasks;
  const list = document.getElementById('tasks-list');
  const empty = document.getElementById('tasks-empty');

  if (filtered.length === 0) { list.innerHTML = ''; empty.style.display = 'block'; lucide.createIcons(); return; }
  empty.style.display = 'none';

  list.innerHTML = filtered.map(t => {
    const svcId = `svc-${t.Id}`;
    return `
    <div class="task-card ${t.ManagementMode === 'nssm' ? 'task-card-nssm' : ''}" style="cursor:pointer">
      <div class="task-info" onclick="event.stopPropagation(); showTaskHistory('${t.Id}')">
        <div class="task-name">${escHtml(t.Name)}
          <span class="badge ${t.Enabled ? 'badge-active' : 'badge-disabled'}">${t.Enabled ? i18n.t('tasks.active') : i18n.t('tasks.disabled')}</span>
          <span class="badge ${t.ManagementMode === 'nssm' ? 'badge-service-running' : 'badge-info'}" style="font-size:9px;padding:1px 6px;"><i data-lucide="${t.ManagementMode === 'nssm' ? 'server' : 'monitor'}" style="width:10px;height:10px;"></i> ${t.ManagementMode === 'nssm' ? 'NSSM Service' : 'Κύριος Κρόνου'}</span>
          <span class="badge badge-service" id="badge-${svcId}"><i data-lucide="loader" style="width:10px;height:10px;"></i></span>
        </div>
        <div class="task-meta"><i data-lucide="clock"></i>${escHtml(t.CronExpression)}<span style="color:var(--text3)">|</span><i data-lucide="file-code"></i>${escHtml(t.ScriptPath)}${t.ScriptType ? ` <span class="badge badge-info" style="font-size:9px;padding:1px 5px;">${t.ScriptType.toUpperCase()} inline</span>` : ''}</div>
        ${t.Description ? `<div class="task-desc">${escHtml(t.Description)}</div>` : ''}
      </div>
      <div class="task-actions" onclick="event.stopPropagation()">
        ${t.ManagementMode !== 'nssm' ? `<button class="btn-glow btn-sm" onclick="runTask('${t.Id}')"><i data-lucide="play"></i>${i18n.t('tasks.run')}</button>` : ''}
        <button class="btn-secondary-sm" onclick="editTask('${t.Id}')"><i data-lucide="pencil"></i>${i18n.t('tasks.edit')}</button>
        ${t.ManagementMode === 'nssm' ? `<button class="btn-secondary-sm btn-deploy" id="btn-deploy-${t.Id}" onclick="toggleDeploy('${t.Id}')"><i data-lucide="package-plus"></i>${i18n.t('tasks.deploy')}</button>` : ''}
        <button class="btn-danger" onclick="deleteTask('${t.Id}','${escHtml(t.Name)}')"><i data-lucide="trash-2"></i></button>
      </div>
    </div>`;
  }).join('');
  lucide.createIcons();
  // Check service status for each task
  filtered.forEach(t => checkTaskServiceStatus(t.Id));
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
  showModal(`
    <h2>${isEdit ? '<i data-lucide="pencil"></i> Edit Task' : '<i data-lucide="plus-circle"></i> New Task'}</h2>
    <label class="form-label">Task Name *</label>
    <input type="text" class="form-input" id="dlg-name" value="${isEdit ? escAttr(task.Name) : ''}" placeholder="e.g. Daily Backup">
    <label class="form-label">Schedule</label>
    <div id="smart-cron-container"></div>
    <label class="form-label">Script</label>
    <div class="script-mode-tabs">
      <button class="script-mode-tab ${!hasInline ? 'active' : ''}" id="tab-file" onclick="scriptEditorSwitchMode('file')">
        <i data-lucide="file-input"></i> File Path
      </button>
      <button class="script-mode-tab ${hasInline ? 'active' : ''}" id="tab-editor" onclick="scriptEditorSwitchMode('editor')">
        <i data-lucide="code-2"></i> Write Script
      </button>
    </div>
    <div id="script-mode-file">
      <div class="input-row">
        <input type="text" class="form-input" id="dlg-script" value="${isEdit ? escAttr(task.ScriptPath || '') : ''}" placeholder="C:\Scripts\backup.ps1">
        <button class="btn-outline" onclick="browseScript()"><i data-lucide="folder-open"></i> Browse</button>
      </div>
      <div class="script-hint">Supported: <code>.ps1</code> PowerShell, <code>.bat</code> <code>.cmd</code> Batch</div>
    </div>
    <div id="script-mode-editor" style="display:none">
      <div id="dialog-script-editor"></div>
      <div id="script-file-path" class="script-path-display" style="display:none"></div>
    </div>
    <label class="form-label">Arguments</label>
    <input type="text" class="form-input" id="dlg-args" value="${isEdit ? escAttr(task.Arguments || '') : ''}" placeholder="-Param Value">
    <label class="form-label">Working Directory</label>
    <input type="text" class="form-input" id="dlg-workdir" value="${isEdit ? escAttr(task.WorkingDirectory || '') : ''}">
    <label class="form-label">Description</label>
    <textarea class="form-input" id="dlg-desc" placeholder="Optional description">${isEdit ? escHtml(task.Description || '') : ''}</textarea>
    <div class="checkbox-row">
      <input type="checkbox" id="dlg-enabled" ${isEdit && !task.Enabled ? '' : 'checked'}>
      <label for="dlg-enabled">Enable this task</label>
    </div>
    <label class="form-label">Management Mode</label>
    <div class="mgmt-mode-selector">
      <div class="mgmt-mode-option ${(isEdit ? task.ManagementMode : 'cronmaster') === 'cronmaster' ? 'active' : ''}" id="mode-cronmaster" onclick="selectMgmtMode('cronmaster')">
        <div class="mgmt-mode-icon"><i data-lucide="monitor"></i></div>
        <div class="mgmt-mode-info">
          <div class="mgmt-mode-name">Κύριος Κρόνου</div>
          <div class="mgmt-mode-desc">Managed by Kyrion Kronou scheduler. Requires the app to be running.</div>
        </div>
      </div>
      <div class="mgmt-mode-option ${(isEdit ? task.ManagementMode : '') === 'nssm' ? 'active' : ''}" id="mode-nssm" onclick="selectMgmtMode('nssm')">
        <div class="mgmt-mode-icon"><i data-lucide="server"></i></div>
        <div class="mgmt-mode-info">
          <div class="mgmt-mode-name">NSSM Service</div>
          <div class="mgmt-mode-desc">Runs as a Windows service via NSSM. Always active, independent of Kyrion Kronou.</div>
        </div>
      </div>
    </div>
    <input type="hidden" id="dlg-mgmt-mode" value="${isEdit ? task.ManagementMode || 'cronmaster' : 'cronmaster'}">
    <div class="modal-actions">
      <button class="btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn-glow" id="btn-save-task" onclick="saveTask(${isEdit ? `'${task.Id}'` : 'null'})">${isEdit ? '<i data-lucide="save"></i> Save Changes' : '<i data-lucide="plus"></i> Create Task'}</button>
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
function selectMgmtMode(mode) {
  document.getElementById('dlg-mgmt-mode').value = mode;
  document.getElementById('mode-cronmaster').classList.toggle('active', mode === 'cronmaster');
  document.getElementById('mode-nssm').classList.toggle('active', mode === 'nssm');
}

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
    ManagementMode: document.getElementById('dlg-mgmt-mode').value,
    Enabled: document.getElementById('dlg-enabled').checked
  };

  const btn = document.getElementById('btn-save-task');
  btn.disabled = true; btn.style.opacity = '0.5';

  if (editId) {
    data.Id = editId;
    await window.api.updateTask(data);
    showToast(i18n.t('toast.taskUpdated'), 'success');
  } else {
    await window.api.addTask(data);
    showToast(i18n.t('toast.taskCreated'), 'success');
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
  showToast(i18n.t('toast.taskDeleted'), 'success');
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
async function refreshServices() {
  setLoading('page-services', true);
  try {
    const allServices = await window.api.getServices();
    const filterManaged = document.getElementById('filter-managed-only').checked;
    const services = filterManaged ? allServices.filter(s => s.Name && (s.Name.startsWith('Kyrion_') || s.Name.startsWith('KyrionBackup_'))) : allServices;
    const tbody = document.getElementById('services-body');
    const empty = document.getElementById('services-empty');
    if (services.length === 0) { tbody.innerHTML = ''; empty.style.display = 'block'; lucide.createIcons(); return; }
    empty.style.display = 'none';
    tbody.innerHTML = services.map(s => {
      const isRunning = s.Status === 'Running';
      const isCronMaster = s.Name && s.Name.startsWith('Kyrion_');
      // For Kyrion services: uninstall button should warn (removes task too)
      return `<tr${isCronMaster ? ' class="kyrion-managed"' : ''}>
        <td>${escHtml(s.Name)}${isCronMaster ? ' <span class="badge badge-info" style="font-size:9px;">managed</span>' : ''}</td>
        <td><span class="badge badge-${isRunning ? 'success' : 'error'}">${s.Status}</span></td>
        <td>${escHtml(s.Application || '-')}</td>
        <td>${s.StartupType}</td>
        <td>
          <button class="btn-secondary-sm" onclick="editServiceScript('${s.Name}')" title="Edit Parameters"><i data-lucide="pencil"></i></button>
          ${!isRunning ? `<button class="btn-secondary-sm" onclick="svcAction('start','${s.Name}')" title="Start"><i data-lucide="play"></i></button>` : ''}
          ${isRunning ? `<button class="btn-secondary-sm" onclick="svcAction('stop','${s.Name}')" title="Stop"><i data-lucide="square"></i></button>` : ''}
          <button class="btn-secondary-sm" onclick="svcAction('restart','${s.Name}')" title="Restart"><i data-lucide="rotate-cw"></i></button>
          ${isCronMaster ? `<button class="btn-danger" onclick="svcAction('uninstall','${s.Name}')" title="Uninstall (removes service)"><i data-lucide="trash-2"></i></button>` : `<button class="btn-danger" onclick="svcAction('uninstall','${s.Name}')" title="Uninstall"><i data-lucide="trash-2"></i></button>`}
        </td>
      </tr>`;
    }).join('');
    lucide.createIcons();
  } finally { setLoading('page-services', false); }
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
    refreshServices();
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
  refreshServices();
  refreshDashboard();
}

async function confirmSvcUninstall(name) {
  const r = await window.api.uninstallService(name);
  showToast(r.message, r.success ? 'success' : 'error');
  refreshServices();
  refreshDashboard();
}

document.getElementById('btn-install-service').addEventListener('click', () => {
  showModal(`
    <h2><i data-lucide="server"></i> Install NSSM Service</h2>
    <label class="form-label">Service Name *</label>
    <input type="text" class="form-input" id="dlg-svc-name" placeholder="MyService">
    <label class="form-label">Application Path *</label>
    <input type="text" class="form-input" id="dlg-svc-app" placeholder="C:\app\service.exe">
    <label class="form-label">Arguments</label>
    <input type="text" class="form-input" id="dlg-svc-args">
    <label class="form-label">Startup Directory</label>
    <input type="text" class="form-input" id="dlg-svc-workdir">
    <label class="form-label">Startup Type</label>
    <select class="form-input" id="dlg-svc-startup"><option>Automatic</option><option>Manual</option><option>Disabled</option></select>
    <div class="modal-actions">
      <button class="btn-ghost" onclick="hideModal()">Cancel</button>
      <button class="btn-glow" onclick="installService()"><i data-lucide="download"></i> Install</button>
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
  if (r.success) { showToast(i18n.t('toast.serviceInstalled'), 'success'); refreshServices(); refreshDashboard(); }
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

document.getElementById('cfg-start-windows').addEventListener('change', async (e) => {
  if (window.api.setStartWithWindows) {
    await window.api.setStartWithWindows(e.target.checked);
  } else {
    await window.api.setSetting('StartWithWindows', e.target.checked);
  }
  showToast(e.target.checked ? i18n.t('settings.willStartWithWindows') : i18n.t('settings.removedFromStartup'), 'info');
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

// ─── Kyrion Scheduler Service ───
async function refreshKyrionService() {
  try {
    const status = await window.api.getKyrionServiceStatus();
    const statusEl = document.getElementById('kyrion-svc-status');
    const installBtn = document.getElementById('btn-install-kyrion-svc');
    const uninstallBtn = document.getElementById('btn-uninstall-kyrion-svc');
    const restartBtn = document.getElementById('btn-restart-kyrion-svc');

    if (!status.nssmAvailable) {
      statusEl.innerHTML = '<span class="badge" style="background:var(--glass3);color:var(--text3)">NSSM not installed - Service mode requires NSSM</span>';
      installBtn.style.display = 'none';
      uninstallBtn.style.display = 'none';
      restartBtn.style.display = 'none';
      return;
    }

    if (status.installed) {
      const isRunning = status.status === 'Running';
      statusEl.innerHTML = `<span class="badge ${isRunning ? 'badge-active' : 'badge-error'}" style="font-size:12px">Service: ${status.serviceName} - ${status.status}</span>`;
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
  showToast('Installing Kyrion Scheduler as Windows service...', 'info');
  const result = await window.api.installKyrionService();
  if (result.success) {
    showToast(result.message, 'success');
  } else {
    showToast(result.message, 'error');
  }
  refreshKyrionService();
});

document.getElementById('btn-uninstall-kyrion-svc').addEventListener('click', async () => {
  showToast('Uninstalling Kyrion Scheduler service...', 'info');
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
  showToast(lang === 'pt-BR' ? 'Idioma alterado para Português' : 'Language changed to English', 'info');
});

// Initialize i18n on load
initI18n();
