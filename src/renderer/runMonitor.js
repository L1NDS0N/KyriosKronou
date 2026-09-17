// runMonitor.js - The fixed status bar and the live run viewer.
//
// Before this, a task or backup fired and the operator saw nothing until it
// finished. The status bar says how many jobs are in flight; clicking it picks
// one to watch, and the viewer shows its steps, progress and output as they
// arrive.
//
// Only ONE run is watched at a time, on purpose: tailing several at once turns
// into noise nobody reads, and each watcher polls the main process.

(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const T = (k, p) => (typeof i18n !== 'undefined' && i18n.t ? i18n.t(k, p) : k);

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function duration(ms) {
    const secs = Math.max(0, Math.round(ms / 1000));
    if (secs < 60) return secs + 's';
    const mins = Math.floor(secs / 60);
    return mins + 'm ' + String(secs % 60).padStart(2, '0') + 's';
  }

  // ─── State ───
  let activeRuns = [];
  let watching = null;      // { runId, lastSeq, timer }

  // ═══════════════════════════════════════════════════════
  // Status bar
  // ═══════════════════════════════════════════════════════
  function renderRunCount() {
    const label = $('sb-runs-label');
    const dot = $('sb-runs-dot');
    const button = $('sb-runs');
    if (!label) return;

    const n = activeRuns.length;
    label.textContent = n === 0
      ? T('runs.none')
      : (n === 1 ? T('runs.oneRunning') : T('runs.nRunning', { n }));

    dot.className = 'sb-runs-dot' + (n ? ' active' : '');
    button.classList.toggle('has-runs', n > 0);
    button.disabled = n === 0;
  }

  /** Numbers for the status bar, so the dashboard is readable from anywhere. */
  async function refreshSummary() {
    try {
      const [tasks, profiles] = await Promise.all([
        window.api.getTasks(),
        window.api.getBackupProfiles().catch(() => []),
      ]);

      const activeTasks = (tasks || []).filter(t => t.Enabled !== false).length;
      $('sb-tasks-value').textContent = activeTasks + '/' + (tasks || []).length;
      $('sb-tasks').title = T('dash.activeTasks');

      const activeProfiles = (profiles || []).filter(p => p.Enabled).length;
      $('sb-backups-value').textContent = activeProfiles + '/' + (profiles || []).length;
      $('sb-backups').title = T('dash.backupProfiles');

      // Failures in the last 24h, across tasks and backups.
      const since = Date.now() - 86400000;
      const history = await window.api.getHistory().catch(() => []);
      let fails = (history || []).filter(h => h.Status === 'Error' && new Date(h.Timestamp).getTime() > since).length;
      try {
        const bh = await window.api.getBackupHistory(null);
        fails += (bh.history || []).filter(h => h.Status !== 'Success' && new Date(h.Timestamp).getTime() > since).length;
      } catch (e) {}
      $('sb-fails-value').textContent = String(fails);
      $('sb-fails').title = T('dash.failures24h');
      $('sb-fails').classList.toggle('bad', fails > 0);

      // Soonest upcoming run.
      let soonest = null;
      const consider = async (name, cron) => {
        if (!cron) return;
        try {
          const next = await window.api.getNextRun(cron);
          if (next && (!soonest || new Date(next) < soonest.at)) soonest = { at: new Date(next), name };
        } catch (e) {}
      };
      for (const t of tasks || []) if (t.Enabled !== false) await consider(t.Name, t.CronExpression);
      for (const p of profiles || []) if (p.Enabled) await consider(p.Name, p.CronExpression);

      if (soonest) {
        const mins = Math.max(0, Math.round((soonest.at - Date.now()) / 60000));
        $('sb-next-value').textContent = mins < 1 ? T('dash.now')
          : mins < 60 ? T('dash.inMinutes', { n: mins })
          : T('dash.inHours', { n: Math.round(mins / 60) });
        $('sb-next').title = soonest.name;
      } else {
        $('sb-next-value').textContent = '—';
        $('sb-next').title = T('dash.nothingScheduled');
      }

      // Scheduler health.
      const status = await window.api.getKyrionServiceStatus().catch(() => ({}));
      const dot = $('sb-sched-dot');
      const label = $('sb-sched-label');
      if (status.installed && status.running && status.schedulerAlive) {
        dot.className = 'sb-sched-dot ok'; label.textContent = T('dash.schedActive');
      } else if (status.installed && status.running) {
        dot.className = 'sb-sched-dot warn'; label.textContent = T('dash.schedUnresponsive');
      } else if (status.installed) {
        dot.className = 'sb-sched-dot bad'; label.textContent = T('dash.schedStopped');
      } else {
        dot.className = 'sb-sched-dot warn'; label.textContent = T('dash.schedRunningApp');
      }
    } catch (e) { /* the bar is informational; never break the app for it */ }
  }

  // ═══════════════════════════════════════════════════════
  // Picker: which single run to watch
  // ═══════════════════════════════════════════════════════
  function openPicker() {
    if (!activeRuns.length) return;

    // One running job goes straight to the viewer - no pointless menu.
    if (activeRuns.length === 1) return watchRun(activeRuns[0].runId);

    showModal(`
      <h2><i data-lucide="activity"></i> ${esc(T('runs.pickTitle'))}</h2>
      <div class="form-hint" style="padding:0 26px">${esc(T('runs.pickHint'))}</div>
      <div class="run-picker">
        ${activeRuns.map(r => `
          <button type="button" class="run-pick" data-run="${esc(r.runId)}">
            <span class="run-pick-kind ${r.kind === 'backup' ? 'backup' : 'task'}">${esc(T(r.kind === 'backup' ? 'dash.kindBackup' : 'dash.kindTask'))}</span>
            <span class="run-pick-name">${esc(r.name)}</span>
            <span class="run-pick-step">${esc(r.currentStepLabel || '')}</span>
            <span class="run-pick-pct">${r.percent}%</span>
          </button>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn-ghost" onclick="hideModal()">${esc(T('taskModal.cancel'))}</button>
      </div>
    `);

    document.querySelectorAll('.run-pick').forEach(btn => {
      btn.addEventListener('click', () => watchRun(btn.getAttribute('data-run')));
    });
    if (window.lucide) lucide.createIcons();
  }

  // ═══════════════════════════════════════════════════════
  // Viewer: one run, live
  // ═══════════════════════════════════════════════════════
  function watchRun(runId) {
    stopWatching();

    showModal(`
      <h2><i data-lucide="activity"></i> <span id="rv-title">${esc(T('runs.watching'))}</span></h2>

      <div class="run-view">
        <div class="run-head">
          <div>
            <div class="run-name" id="rv-name">—</div>
            <div class="run-meta" id="rv-meta">—</div>
          </div>
          <span class="badge" id="rv-status">—</span>
        </div>

        <div class="run-progress">
          <div class="run-progress-bar"><div class="run-progress-fill" id="rv-fill" style="width:0%"></div></div>
          <div class="run-progress-pct" id="rv-pct">0%</div>
        </div>

        <div class="run-steps" id="rv-steps"></div>

        <div class="run-log-head">
          <span>${esc(T('runs.output'))}</span>
          <label class="run-follow"><input type="checkbox" id="rv-follow" checked> ${esc(T('runs.follow'))}</label>
        </div>
        <div class="run-log" id="rv-log"><div class="run-log-empty">${esc(T('runs.waitingOutput'))}</div></div>
      </div>

      <div class="modal-actions">
        <button class="btn-ghost" onclick="hideModal()">${esc(T('runs.close'))}</button>
      </div>
    `, true);

    watching = { runId, lastSeq: 0, timer: null, firstLine: true };
    if (window.lucide) lucide.createIcons();

    pollRun();
    watching.timer = setInterval(pollRun, 700);

    // Stop polling when the modal closes, however it closes.
    const overlay = $('modal-overlay');
    const observer = new MutationObserver(() => {
      if (overlay.classList.contains('hidden')) { stopWatching(); observer.disconnect(); }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  }

  function stopWatching() {
    if (watching && watching.timer) clearInterval(watching.timer);
    watching = null;
  }

  async function pollRun() {
    if (!watching) return;
    let detail;
    try { detail = await window.api.getRunDetail(watching.runId, watching.lastSeq); }
    catch (e) { return; }

    if (!detail) {
      // The run aged out of the registry.
      const status = $('rv-status');
      if (status) { status.textContent = T('runs.gone'); status.className = 'badge badge-info'; }
      stopWatching();
      return;
    }

    $('rv-name').textContent = detail.name;
    $('rv-meta').textContent = [
      T(detail.kind === 'backup' ? 'dash.kindBackup' : 'dash.kindTask'),
      duration(detail.elapsedMs),
      detail.currentStepLabel,
    ].filter(Boolean).join(' · ');

    const status = $('rv-status');
    if (detail.status === 'running') { status.textContent = T('runs.running'); status.className = 'badge badge-warn'; }
    else if (detail.status === 'success') { status.textContent = T('runs.done'); status.className = 'badge badge-active'; }
    else { status.textContent = T('runs.failed'); status.className = 'badge badge-error'; }

    $('rv-fill').style.width = detail.percent + '%';
    $('rv-fill').className = 'run-progress-fill' + (detail.status === 'failed' ? ' failed' : detail.status === 'success' ? ' done' : '');
    $('rv-pct').textContent = detail.percent + '%';

    $('rv-steps').innerHTML = (detail.steps || []).map(s => `
      <div class="run-step ${s.state}">
        <span class="run-step-mark"></span>
        <span class="run-step-label">${esc(s.label)}</span>
        ${s.detail ? `<span class="run-step-detail">${esc(s.detail)}</span>` : ''}
        ${s.startedAt && s.endedAt ? `<span class="run-step-time">${duration(s.endedAt - s.startedAt)}</span>` : ''}
      </div>`).join('');

    // Append only what is new, so the log does not flicker or lose scroll.
    if (detail.lines && detail.lines.length) {
      const log = $('rv-log');
      if (watching.firstLine) { log.innerHTML = ''; watching.firstLine = false; }
      for (const line of detail.lines) {
        const el = document.createElement('div');
        el.className = 'run-log-line ' + (line.stream === 'stderr' ? 'err' : '');
        el.textContent = line.text;
        log.appendChild(el);
      }
      watching.lastSeq = detail.lastSeq;
      if ($('rv-follow').checked) log.scrollTop = log.scrollHeight;
    }

    if (detail.status !== 'running') stopWatching();
  }

  // ═══════════════════════════════════════════════════════
  // Badges on list rows
  // ═══════════════════════════════════════════════════════
  /** Markup for a "running" badge, or '' when the target is idle. */
  function runningBadge(targetId) {
    const run = activeRuns.find(r => r.targetId === targetId);
    if (!run) return '';
    return `<span class="badge badge-running" data-watch-run="${esc(run.runId)}" title="${esc(T('runs.clickToWatch'))}">`
      + `<span class="badge-running-spin"></span>${esc(T('runs.running'))} ${run.percent}%</span>`;
  }

  // A badge can be rendered by any screen, so the handler is delegated.
  document.addEventListener('click', (e) => {
    const badge = e.target.closest('[data-watch-run]');
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    watchRun(badge.getAttribute('data-watch-run'));
  });

  // ═══════════════════════════════════════════════════════
  // Boot
  // ═══════════════════════════════════════════════════════
  function applyRuns(runs) {
    activeRuns = runs || [];
    renderRunCount();
    // Let the open screen repaint its badges.
    document.dispatchEvent(new CustomEvent('kyrios-runs-changed', { detail: activeRuns }));
  }

  function init() {
    const button = $('sb-runs');
    if (!button) return;
    button.addEventListener('click', openPicker);

    if (window.api.onRunsChanged) window.api.onRunsChanged(applyRuns);
    window.api.getActiveRuns().then(applyRuns).catch(() => {});

    refreshSummary();
    // The bar is a summary, not a live feed; a slow cadence is plenty.
    setInterval(refreshSummary, 20000);
  }

  global.RunMonitor = { init, runningBadge, watchRun, openPicker, refreshSummary, get activeRuns() { return activeRuns; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
