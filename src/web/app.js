// app.js - Web interface for Κύριος Χρόνος.
//
// Charts are hand-drawn on canvas rather than pulled from a CDN: this runs on
// servers that often have no outbound internet, and a chart library that fails
// to load would take the monitor with it.

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ─── Formatting ───
  function bytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return v.toFixed(0) + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
    return (v / 1073741824).toFixed(2) + ' GB';
  }
  const rate = (n) => bytes(n) + '/s';
  function gb(n) { return ((Number(n) || 0) / 1073741824).toFixed(1) + ' GB'; }

  function when(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (isNaN(d)) return '—';
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function toast(msg, kind) {
    const host = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || 'info');
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  // ─── API ───
  async function api(path, options) {
    const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, options || {}));
    if (res.status === 401) { location.href = '/login?notice=expired'; throw new Error('unauthenticated'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || body.error || ('HTTP ' + res.status));
    return body;
  }

  // ─── Charts ───
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();

  function Chart(canvas, series, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = series;           // [{ key, color }]
    this.opts = opts || {};
    this.data = [];
    this.resize();
    window.addEventListener('resize', () => { this.resize(); this.draw(); });
  }

  Chart.prototype.resize = function () {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, rect.width);
    this.h = Math.max(1, rect.height);
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  Chart.prototype.setData = function (samples) { this.data = samples || []; this.draw(); };

  Chart.prototype.draw = function () {
    const ctx = this.ctx, w = this.w, h = this.h, pad = 4;
    ctx.clearRect(0, 0, w, h);
    if (!this.data.length) return;

    // Scale: fixed 0-100 for percentages, otherwise to the window maximum so
    // idle periods still show shape instead of a flat line at zero.
    let max = this.opts.max;
    if (!max) {
      max = 1;
      for (const s of this.data) {
        for (const serie of this.series) max = Math.max(max, Number(s[serie.key]) || 0);
      }
      max *= 1.15;
    }

    // Grid
    ctx.strokeStyle = 'rgba(180,180,200,.05)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = pad + ((h - pad * 2) * i) / 3;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    const n = this.data.length;
    const xAt = (i) => (n === 1 ? w : (i / (n - 1)) * w);
    const yAt = (v) => h - pad - ((Number(v) || 0) / max) * (h - pad * 2);

    for (const serie of this.series) {
      // Filled area
      ctx.beginPath();
      ctx.moveTo(xAt(0), h);
      for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), yAt(this.data[i][serie.key]));
      ctx.lineTo(xAt(n - 1), h);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, hexToRgba(serie.color, 0.22));
      grad.addColorStop(1, hexToRgba(serie.color, 0));
      ctx.fillStyle = grad;
      ctx.fill();

      // Line
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xAt(i), y = yAt(this.data[i][serie.key]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = serie.color;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  };

  function hexToRgba(color, alpha) {
    // Tokens resolve to hex; fall back to the colour itself if not.
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color.trim());
    if (!m) return color;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
  }

  const charts = {};

  function initCharts() {
    charts.cpu = new Chart($('chart-cpu'), [{ key: 'cpuPct', color: token('--primary') }], { max: 100 });
    charts.mem = new Chart($('chart-mem'), [{ key: 'memPct', color: token('--green') }], { max: 100 });
    charts.disk = new Chart($('chart-disk'), [
      { key: 'diskRead', color: token('--amber') },
      { key: 'diskWrite', color: token('--red') },
    ]);
    charts.net = new Chart($('chart-net'), [
      { key: 'netRecv', color: token('--cyan') },
      { key: 'netSent', color: token('--primary-light') },
    ]);
  }

  // ─── Monitor ───
  let samples = [];
  let hostInfo = null;

  function renderMonitor(latest) {
    if (!latest) return;
    $('s-cpu').innerHTML = latest.cpuPct.toFixed(0) + '<small>%</small>';
    if (hostInfo) $('s-cpu-sub').textContent = hostInfo.cpuCount + ' núcleos';
    $('s-mem').innerHTML = latest.memPct.toFixed(0) + '<small>%</small>';
    $('s-mem-sub').textContent = gb(latest.memUsed) + ' de ' + gb(latest.memTotal);
    $('s-disk').textContent = rate(latest.diskRead + latest.diskWrite);
    $('s-disk-sub').textContent = 'L ' + rate(latest.diskRead) + ' · E ' + rate(latest.diskWrite);
    $('s-net').textContent = rate(latest.netRecv + latest.netSent);
    $('s-net-sub').textContent = '↓ ' + rate(latest.netRecv) + ' · ↑ ' + rate(latest.netSent);

    $('c-cpu').textContent = latest.cpuPct.toFixed(0) + '%';
    $('c-mem').textContent = latest.memPct.toFixed(0) + '%';
    $('c-disk').textContent = rate(latest.diskRead + latest.diskWrite);
    $('c-net').textContent = rate(latest.netRecv + latest.netSent);

    charts.cpu.setData(samples);
    charts.mem.setData(samples);
    charts.disk.setData(samples);
    charts.net.setData(samples);

    const vols = latest.volumes || [];
    $('volumes').innerHTML = vols.length ? vols.map((v) => {
      const cls = v.pct >= 90 ? 'crit' : v.pct >= 75 ? 'warn' : '';
      return '<div class="vol-row">'
        + '<div class="vol-name">' + esc(v.drive) + '</div>'
        + '<div class="vol-bar"><div class="vol-fill ' + cls + '" style="width:' + v.pct + '%"></div></div>'
        + '<div class="vol-text">' + gb(v.used) + ' / ' + gb(v.total) + ' · ' + v.pct + '%</div>'
        + '</div>';
    }).join('') : '<div class="tbl-empty">Nenhum volume encontrado</div>';
  }

  function connectMetrics() {
    const state = $('monitor-state');
    const es = new EventSource('/api/metrics/stream');

    es.addEventListener('open', () => {
      state.textContent = 'ao vivo';
      state.className = 'badge badge-active';
    });

    es.addEventListener('sample', (ev) => {
      let sample;
      try { sample = JSON.parse(ev.data); } catch (e) { return; }
      samples.push(sample);
      if (samples.length > 300) samples = samples.slice(-300);
      renderMonitor(sample);
    });

    es.addEventListener('error', () => {
      state.textContent = 'reconectando';
      state.className = 'badge badge-warn';
      // EventSource reconnects on its own; nothing to do but say so.
    });
  }

  async function primeMonitor() {
    try {
      const info = await api('/api/metrics?limit=300');
      const host = info.host || {};
      hostInfo = host;
      $('host-line').textContent = [host.hostname, host.cpuModel, host.cpuCount + ' núcleos', gb(host.totalMemory) + ' RAM']
        .filter(Boolean).join(' · ');
      samples = info.history || [];
      if (info.sample) renderMonitor(info.sample);
      else if (samples.length) renderMonitor(samples[samples.length - 1]);
      if (info.error) {
        $('monitor-state').textContent = 'indisponível';
        $('monitor-state').className = 'badge badge-error';
        toast('Monitor de recursos: ' + info.error, 'error');
        return;
      }
      connectMetrics();
    } catch (err) {
      toast('Falha ao carregar o monitor: ' + err.message, 'error');
    }
  }

  // ─── Tasks ───
  async function loadTasks() {
    const body = $('tasks-body');
    body.innerHTML = '<tr><td colspan="5" class="tbl-loading">carregando</td></tr>';
    try {
      const res = await api('/api/tasks');
      const tasks = res.data || [];
      $('tasks-sub').textContent = tasks.length + ' tarefa(s) · ' + tasks.filter(t => t.Enabled !== false).length + ' ativa(s)';
      if (!tasks.length) { body.innerHTML = '<tr><td colspan="5" class="tbl-empty">Nenhuma tarefa cadastrada</td></tr>'; return; }
      body.innerHTML = tasks.map((t) => '<tr>'
        + '<td>' + esc(t.Name) + '</td>'
        + '<td class="mono">' + esc(t.CronExpression) + '</td>'
        + '<td class="mono">' + esc(t.ScriptPath || '—') + '</td>'
        + '<td><span class="badge ' + (t.Enabled !== false ? 'badge-active">ativa' : 'badge-disabled">desativada') + '</span></td>'
        + '<td><div class="cell-actions">'
        + '<button class="btn-secondary-sm" data-run="' + esc(t.Id) + '">Executar</button>'
        + '<button class="btn-secondary-sm" data-toggle="' + esc(t.Id) + '">' + (t.Enabled !== false ? 'Desativar' : 'Ativar') + '</button>'
        + '<button class="btn-danger" data-del="' + esc(t.Id) + '" data-name="' + esc(t.Name) + '">Excluir</button>'
        + '</div></td></tr>').join('');
    } catch (err) {
      body.innerHTML = '<tr><td colspan="5" class="tbl-empty">Erro: ' + esc(err.message) + '</td></tr>';
    }
  }

  async function loadBackups() {
    const body = $('backups-body');
    body.innerHTML = '<tr><td colspan="6" class="tbl-loading">carregando</td></tr>';
    try {
      const res = await api('/api/backups');
      const list = res.data || [];
      $('backups-sub').textContent = list.length + ' perfil(is) · ' + list.filter(p => p.Enabled).length + ' ativo(s)';
      if (!list.length) { body.innerHTML = '<tr><td colspan="6" class="tbl-empty">Nenhum perfil cadastrado</td></tr>'; return; }
      body.innerHTML = list.map((p) => {
        const status = p.LastStatus === 'Success' ? 'badge-active' : p.LastStatus ? 'badge-error' : 'badge-info';
        return '<tr>'
          + '<td>' + esc(p.Name) + '</td>'
          + '<td class="mono">' + esc(p.User) + '@' + esc(p.Host) + ':' + esc(p.Port) + '</td>'
          + '<td class="mono">' + esc((p.Databases || []).join(', ') || 'todos') + '</td>'
          + '<td class="mono">' + esc(p.CronExpression || '—') + '</td>'
          + '<td><span class="badge ' + status + '">' + esc(p.LastStatus || 'nunca') + '</span>'
          + '<div class="page-sub">' + when(p.LastRun) + '</div></td>'
          + '<td><div class="cell-actions">'
          + '<button class="btn-secondary-sm" data-runbk="' + esc(p.Id) + '">Executar</button>'
          + '</div></td></tr>';
      }).join('');
    } catch (err) {
      body.innerHTML = '<tr><td colspan="6" class="tbl-empty">Erro: ' + esc(err.message) + '</td></tr>';
    }
  }

  async function loadHistory() {
    const body = $('history-body');
    body.innerHTML = '<tr><td colspan="5" class="tbl-loading">carregando</td></tr>';
    try {
      const res = await api('/api/history?limit=100');
      const rows = res.data || [];
      if (!rows.length) { body.innerHTML = '<tr><td colspan="5" class="tbl-empty">Nada executado ainda</td></tr>'; return; }
      body.innerHTML = rows.map((h) => '<tr>'
        + '<td class="mono">' + when(h.Timestamp) + '</td>'
        + '<td>' + esc(h.TaskName) + '</td>'
        + '<td><span class="badge ' + (h.Status === 'Success' ? 'badge-active">sucesso' : 'badge-error">' + esc(h.Status)) + '</span></td>'
        + '<td class="mono">' + esc(h.Duration || '—') + '</td>'
        + '<td class="mono">' + esc((h.Message || '').slice(0, 140)) + '</td>'
        + '</tr>').join('');
    } catch (err) {
      body.innerHTML = '<tr><td colspan="5" class="tbl-empty">Erro: ' + esc(err.message) + '</td></tr>';
    }
  }

  async function loadLogs() {
    const card = $('logs-card');
    card.innerHTML = '<div class="tbl-loading">carregando</div>';
    try {
      const res = await api('/api/logs?limit=250');
      const rows = res.data || [];
      if (!rows.length) { card.innerHTML = '<div class="tbl-empty">Sem registros</div>'; return; }
      card.innerHTML = rows.slice().reverse().map((l) => '<div class="log-line">'
        + '<span class="ts">' + when(l.timestamp) + '</span>'
        + '<span class="lvl lvl-' + esc(l.level) + '">' + esc(l.level) + '</span>'
        + esc(l.message) + '</div>').join('');
    } catch (err) {
      card.innerHTML = '<div class="tbl-empty">Erro: ' + esc(err.message) + '</div>';
    }
  }

  // ─── Actions ───
  document.addEventListener('click', async (ev) => {
    const target = ev.target.closest('button');
    if (!target) return;

    const run = target.getAttribute('data-run');
    const toggle = target.getAttribute('data-toggle');
    const del = target.getAttribute('data-del');
    const runbk = target.getAttribute('data-runbk');

    try {
      if (run) {
        target.disabled = true;
        toast('Executando…', 'info');
        const res = await api('/api/tasks/' + encodeURIComponent(run) + '/run', { method: 'POST' });
        toast(res.data && res.data.Status === 'Success' ? 'Tarefa concluída' : 'Tarefa falhou: ' + ((res.data && res.data.Message) || ''), res.data && res.data.Status === 'Success' ? 'success' : 'error');
        target.disabled = false;
        loadHistory();
      } else if (toggle) {
        const res = await api('/api/tasks/' + encodeURIComponent(toggle));
        await api('/api/tasks/' + encodeURIComponent(toggle), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ Enabled: !(res.data.Enabled !== false) }),
        });
        toast('Tarefa atualizada', 'success');
        loadTasks();
      } else if (del) {
        const name = target.getAttribute('data-name') || '';
        if (!confirm('Excluir a tarefa "' + name + '"? Esta ação não pode ser desfeita.')) return;
        await api('/api/tasks/' + encodeURIComponent(del), { method: 'DELETE' });
        toast('Tarefa excluída', 'success');
        loadTasks();
      } else if (runbk) {
        target.disabled = true;
        toast('Backup iniciado…', 'info');
        const res = await api('/api/backups/' + encodeURIComponent(runbk) + '/run', { method: 'POST' });
        toast(res.data && res.data.success ? 'Backup concluído' : 'Backup falhou', res.data && res.data.success ? 'success' : 'error');
        target.disabled = false;
        loadBackups();
      }
    } catch (err) {
      toast('Erro: ' + err.message, 'error');
      target.disabled = false;
    }
  });

  // ─── Navigation ───
  const loaders = { tasks: loadTasks, backups: loadBackups, history: loadHistory, logs: loadLogs };

  document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item[data-page]').forEach((n) => n.classList.remove('active'));
      document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
      item.classList.add('active');
      const page = item.getAttribute('data-page');
      $('page-' + page).classList.add('active');
      if (loaders[page]) loaders[page]();
      if (page === 'monitor') Object.values(charts).forEach((c) => { c.resize(); c.draw(); });
    });
  });

  $('btn-reload-tasks').addEventListener('click', loadTasks);
  $('btn-reload-backups').addEventListener('click', loadBackups);
  $('btn-reload-history').addEventListener('click', loadHistory);
  $('btn-reload-logs').addEventListener('click', loadLogs);

  $('btn-logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    location.href = '/login?notice=loggedout';
  });

  // ─── Boot ───
  (async function boot() {
    initCharts();
    try {
      const me = await api('/api/me');
      $('user-name').textContent = me.name || me.login;
      $('user-login').textContent = '@' + me.login;
      if (me.avatar) $('user-avatar').src = me.avatar;
    } catch (e) { return; }
    primeMonitor();
  })();
})();
