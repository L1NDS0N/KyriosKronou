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
  //
  // O token CSRF chega no /api/me e acompanha toda escrita: o servidor recusa
  // POST/PUT/DELETE sem ele, justamente para que outro site nao consiga fazer o
  // navegador de quem esta logado disparar uma acao aqui.
  let csrf = null;

  async function api(path, options) {
    const opts = Object.assign({ credentials: 'same-origin' }, options || {});
    if (opts.method && opts.method !== 'GET' && csrf) {
      opts.headers = Object.assign({ 'X-CSRF-Token': csrf }, opts.headers || {});
    }
    const res = await fetch(path, opts);
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

  // O rodapé mostra os mesmos números dos gráficos, para que eles apareçam em
  // qualquer tela do painel - não só na de monitor.
  function renderFooterMetrics(s) {
    if (!s) return;
    const cpu = $('foot-cpu');
    if (!cpu) return;
    cpu.textContent = Math.round(s.cpuPct || 0) + '%';
    $('foot-mem').textContent = Math.round(s.memPct || 0) + '%';
    $('foot-net').textContent = rate((s.netRecv || 0) + (s.netSent || 0));
    $('foot-disk').textContent = rate((s.diskRead || 0) + (s.diskWrite || 0));
  }

  function renderMonitor(latest) {
    renderFooterMetrics(latest);
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
        + '<button class="btn-secondary-sm" data-edit-task="' + esc(t.Id) + '">Editar</button>'
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
          + '<button class="btn-secondary-sm" data-edit-backup="' + esc(p.Id) + '">Editar</button>'
          + '<button class="btn-secondary-sm" data-runbk="' + esc(p.Id) + '">Executar</button>'
          + '<button class="btn-danger" data-delbk="' + esc(p.Id) + '" data-name="' + esc(p.Name) + '">Excluir</button>'
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


  // ─── Modal ───
  //
  // Um só host de modal para o painel inteiro. O conteúdo é montado por quem
  // abre; aqui ficam só abrir, fechar e o que não pode faltar em nenhum deles:
  // Esc fecha, clique no fundo fecha, e o foco vai para o primeiro campo.
  function modal(title, bodyHtml, actionsHtml) {
    const host = $('modal-host');
    host.innerHTML = '<div class="modal-backdrop"></div>'
      + '<div class="modal" role="dialog" aria-modal="true">'
      + '<div class="modal-head"><h2>' + esc(title) + '</h2>'
      + '<button class="modal-close" data-modal-close aria-label="Fechar">&times;</button></div>'
      + '<div class="modal-body">' + bodyHtml + '</div>'
      + '<div class="modal-actions">' + (actionsHtml || '<button class="btn-ghost" data-modal-close>Fechar</button>') + '</div>'
      + '</div>';
    host.classList.add('open');

    const primeiro = host.querySelector('input, select, textarea');
    if (primeiro) primeiro.focus();
    return host;
  }

  function closeModal() {
    const host = $('modal-host');
    host.classList.remove('open');
    host.innerHTML = '';
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-modal-close]') || e.target.classList.contains('modal-backdrop')) closeModal();
  });

  const field = (label, name, value, opts) => {
    const o = opts || {};
    return '<label class="field"><span>' + esc(label) + '</span>'
      + '<input class="input' + (o.mono ? ' mono' : '') + '" name="' + name + '" type="' + (o.type || 'text') + '"'
      + ' value="' + esc(value == null ? '' : value) + '"'
      + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '')
      + (o.required ? ' required' : '') + '>'
      + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '')
      + '</label>';
  };

  const readForm = (host) => {
    const out = {};
    host.querySelectorAll('[name]').forEach((el) => {
      out[el.getAttribute('name')] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return out;
  };

  // ─── Tarefas: criar e editar ───
  async function taskDialog(id) {
    let task = { Name: '', CronExpression: '0 3 * * *', ScriptPath: '', Arguments: '', WorkingDirectory: '', Description: '', Enabled: true };
    if (id) {
      const res = await api('/api/tasks/' + encodeURIComponent(id));
      task = res.data;
    }

    modal(id ? 'Editar tarefa' : 'Nova tarefa',
      field('Nome', 'Name', task.Name, { required: true })
      + field('Expressão cron', 'CronExpression', task.CronExpression, { mono: true, hint: 'minuto hora dia mês dia-da-semana' })
      + '<div class="conflict-note" id="cron-conflicts"></div>'
      + field('Script', 'ScriptPath', task.ScriptPath, { mono: true, placeholder: 'C:\\ProgramData\\KyriosChronos\\scripts\\rotina.ps1' })
      + '<div class="field-inline"><label class="field"><span>Ou escolha um script enviado</span>'
      + '<select class="input mono" id="pick-script"><option value="">—</option></select></label></div>'
      + field('Argumentos', 'Arguments', task.Arguments, { mono: true })
      + field('Diretório de trabalho', 'WorkingDirectory', task.WorkingDirectory, { mono: true })
      + field('Descrição', 'Description', task.Description)
      + '<label class="field field-check"><input type="checkbox" name="Enabled"' + (task.Enabled !== false ? ' checked' : '') + '><span>Ativa</span></label>',
      '<button class="btn-ghost" data-modal-close>Cancelar</button>'
      + '<button class="btn-primary" data-save-task="' + esc(id || '') + '">Salvar</button>');

    // A lista de scripts enviados preenche o campo de caminho: no servidor não
    // há como abrir um seletor de arquivos do Windows.
    api('/api/scripts').then((res) => {
      const sel = $('pick-script');
      if (!sel) return;
      for (const f of res.data || []) {
        const opt = document.createElement('option');
        opt.value = f.path;
        opt.textContent = f.name;
        sel.appendChild(opt);
      }
      sel.addEventListener('change', () => {
        if (!sel.value) return;
        const campo = $('modal-host').querySelector('[name="ScriptPath"]');
        if (campo) campo.value = sel.value;
      });
    }).catch(() => {});

    // O aviso de conflito aparece enquanto se digita o horário, que é quando
    // ele ainda dá para mudar sem retrabalho.
    const host = $('modal-host');
    const cron = host.querySelector('[name="CronExpression"]');
    let debounce = null;
    const checar = async () => {
      const nota = $('cron-conflicts');
      if (!cron.value.trim()) { nota.innerHTML = ''; return; }
      try {
        const res = await api('/api/schedule/conflicts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expression: cron.value.trim(), excludeId: id || undefined }),
        });
        const conflicts = res.data.conflicts || [];
        const suggestion = res.data.suggestion;
        if (!conflicts.length) { nota.innerHTML = '<span class="ok">Nenhum outro agendamento nesse horário.</span>'; return; }
        nota.innerHTML = '<strong>' + conflicts.length + ' agendamento(s) no mesmo horário:</strong> '
          + conflicts.slice(0, 4).map((c) => esc(c.name || c.Name || '')).join(', ')
          + (suggestion ? ' <button class="btn-ghost btn-sm" type="button" data-use-slot="'
             + esc(suggestion.expression || suggestion) + '">Usar um horário livre</button>' : '');
      } catch (e) { nota.innerHTML = ''; }
    };
    cron.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(checar, 400); });
    checar();

    host.addEventListener('click', (e) => {
      const slot = e.target.closest('[data-use-slot]');
      if (slot) { cron.value = slot.getAttribute('data-use-slot'); checar(); }
    });
  }

  async function saveTask(id, botao) {
    const host = $('modal-host');
    const data = readForm(host);
    if (!data.Name || !data.CronExpression) { toast('Nome e cron são obrigatórios', 'error'); return; }

    botao.disabled = true;
    try {
      await api(id ? '/api/tasks/' + encodeURIComponent(id) : '/api/tasks', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      closeModal();
      toast(id ? 'Tarefa atualizada' : 'Tarefa criada', 'success');
      loadTasks();
    } catch (err) {
      toast('Erro: ' + err.message, 'error');
      botao.disabled = false;
    }
  }

  // ─── Backups: criar e editar ───
  async function backupDialog(id) {
    let p = { Name: '', Host: 'localhost', Port: 3306, User: 'root', Databases: [], CronExpression: '0 2 * * *', DestinationPath: '', Enabled: true };
    if (id) p = (await api('/api/backups/' + encodeURIComponent(id))).data;

    modal(id ? 'Editar perfil de backup' : 'Novo perfil de backup',
      field('Nome', 'Name', p.Name, { required: true })
      + '<div class="field-row">' + field('Servidor', 'Host', p.Host, { mono: true }) + field('Porta', 'Port', p.Port, { type: 'number' }) + '</div>'
      + '<div class="field-row">' + field('Usuário', 'User', p.User, { mono: true })
      + field('Senha', 'Password', '', { type: 'password', hint: id ? 'Em branco mantém a senha atual' : '' }) + '</div>'
      + field('Bancos (separados por vírgula)', 'Databases', (p.Databases || []).join(', '), { mono: true, placeholder: 'em branco = todos' })
      + field('Expressão cron', 'CronExpression', p.CronExpression, { mono: true })
      + field('Destino', 'DestinationPath', p.DestinationPath, { mono: true })
      + '<label class="field field-check"><input type="checkbox" name="Enabled"' + (p.Enabled !== false ? ' checked' : '') + '><span>Ativo</span></label>',
      '<button class="btn-ghost" data-modal-close>Cancelar</button>'
      + '<button class="btn-ghost" data-test-conn="' + esc(id || '') + '">Testar conexão</button>'
      + '<button class="btn-primary" data-save-backup="' + esc(id || '') + '">Salvar</button>');
  }

  async function saveBackup(id, botao) {
    const data = readForm($('modal-host'));
    if (!data.Name) { toast('Nome é obrigatório', 'error'); return; }
    data.Port = Number(data.Port) || 3306;
    data.Databases = String(data.Databases || '').split(',').map((s) => s.trim()).filter(Boolean);
    // Senha em branco significa "não mexa", e é o servidor que trata isso -
    // mandar string vazia apagaria a senha de um perfil que já funciona.
    if (!data.Password) delete data.Password;

    botao.disabled = true;
    try {
      await api(id ? '/api/backups/' + encodeURIComponent(id) : '/api/backups', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      closeModal();
      toast(id ? 'Perfil atualizado' : 'Perfil criado', 'success');
      loadBackups();
    } catch (err) {
      toast('Erro: ' + err.message, 'error');
      botao.disabled = false;
    }
  }

  // ─── Serviços ───
  async function loadServices() {
    const body = $('services-body');
    body.innerHTML = '<tr><td colspan="5" class="tbl-loading">carregando</td></tr>';
    try {
      const res = await api('/api/services');
      const list = res.data || [];
      $('services-sub').textContent = list.length + ' serviço(s) · ' + list.filter((s) => /running/i.test(s.Status)).length + ' em execução';
      if (!list.length) { body.innerHTML = '<tr><td colspan="5" class="tbl-empty">Nenhum serviço</td></tr>'; return; }

      body.innerHTML = list.map((s) => {
        const rodando = /running/i.test(s.Status);
        return '<tr>'
          + '<td>' + esc(s.Name) + (s.IsManaged ? ' <span class="badge badge-info">gerenciado</span>' : '') + '</td>'
          + '<td><span class="badge ' + (rodando ? 'badge-active' : 'badge-disabled') + '">' + esc(s.Status) + '</span></td>'
          + '<td class="mono">' + esc(s.Application || '—') + '</td>'
          + '<td>' + esc(s.StartupType || '—') + '</td>'
          + '<td><div class="cell-actions">'
          + (rodando
            ? '<button class="btn-secondary-sm" data-svc="stop" data-name="' + esc(s.Name) + '">Parar</button>'
            : '<button class="btn-secondary-sm" data-svc="start" data-name="' + esc(s.Name) + '">Iniciar</button>')
          + '<button class="btn-secondary-sm" data-svc="restart" data-name="' + esc(s.Name) + '">Reiniciar</button>'
          // Só o que o sistema criou: remover um serviço alheio desconfigura a máquina.
          + (s.IsManaged ? '<button class="btn-danger" data-svc-del="' + esc(s.Name) + '">Remover</button>' : '')
          + '</div></td></tr>';
      }).join('');
    } catch (err) {
      body.innerHTML = '<tr><td colspan="5" class="tbl-empty">Erro: ' + esc(err.message) + '</td></tr>';
    }
  }

  // ─── Scripts ───
  async function loadScripts() {
    const body = $('scripts-body');
    body.innerHTML = '<tr><td colspan="4" class="tbl-loading">carregando</td></tr>';
    try {
      const res = await api('/api/scripts');
      const list = res.data || [];
      $('scripts-sub').textContent = list.length + ' arquivo(s) em ' + res.dir;
      if (!list.length) { body.innerHTML = '<tr><td colspan="4" class="tbl-empty">Nenhum script enviado</td></tr>'; return; }
      body.innerHTML = list.map((f) => '<tr>'
        + '<td class="mono">' + esc(f.name) + '</td>'
        + '<td>' + bytes(f.size) + '</td>'
        + '<td class="mono">' + when(f.modified) + '</td>'
        + '<td><div class="cell-actions">'
        + '<button class="btn-secondary-sm" data-script-view="' + esc(f.name) + '">Ver</button>'
        + '<button class="btn-danger" data-script-del="' + esc(f.name) + '">Excluir</button>'
        + '</div></td></tr>').join('');
    } catch (err) {
      body.innerHTML = '<tr><td colspan="4" class="tbl-empty">Erro: ' + esc(err.message) + '</td></tr>';
    }
  }

  /**
   * Envia um arquivo escolhido pelo usuário.
   *
   * O conteúdo vai em base64 num JSON em vez de multipart: uma dependência a
   * menos no servidor, e o limite de tamanho fica explícito na rota.
   */
  async function uploadScript(file, overwrite) {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('não foi possível ler o arquivo'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });

    try {
      await api('/api/scripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, contentBase64: base64, overwrite: !!overwrite }),
      });
      toast('Script enviado: ' + file.name, 'success');
      loadScripts();
    } catch (err) {
      if (/already exists/i.test(err.message) && !overwrite) {
        if (confirm('Já existe um script chamado "' + file.name + '". Substituir?')) return uploadScript(file, true);
        return;
      }
      toast('Erro no envio: ' + err.message, 'error');
    }
  }

  // ─── Execuções em andamento ───
  //
  // O rodapé fica sempre visível, com o monitor de um lado e o que está
  // rodando do outro: num servidor, essa é a informação pela qual se abre o
  // painel.
  let runTimer = null;
  let watching = null;

  function renderFooterRuns(runs) {
    const host = $('footer-runs');
    if (!runs.length) {
      host.innerHTML = '<span class="idle">nada em execução</span>';
      return;
    }
    host.innerHTML = runs.slice(0, 3).map((r) => '<button class="run-chip" data-watch="' + esc(r.runId) + '">'
      + '<span class="run-dot"></span>' + esc(r.name)
      + '<span class="run-pct">' + Math.round(r.percent || 0) + '%</span></button>').join('')
      + (runs.length > 3 ? '<span class="run-more">+' + (runs.length - 3) + '</span>' : '');
  }

  async function pollRuns() {
    try {
      const res = await api('/api/runs');
      renderFooterRuns(res.data || []);
      if (watching) refreshWatcher();
    } catch (e) { /* o rodapé não pode derrubar a página */ }
  }

  async function watchRun(runId) {
    watching = { runId, since: 0 };
    modal('Execução',
      '<div class="run-watch"><div class="run-steps" id="run-steps"></div>'
      + '<pre class="run-output" id="run-output"></pre></div>',
      '<button class="btn-ghost" data-modal-close>Fechar</button>');
    // Fechar o modal tem que parar o acompanhamento, senão ele segue pedindo
    // linhas de uma execução que ninguém está olhando.
    $('modal-host').addEventListener('click', (e) => {
      if (e.target.closest('[data-modal-close]') || e.target.classList.contains('modal-backdrop')) watching = null;
    });
    refreshWatcher();
  }

  async function refreshWatcher() {
    if (!watching) return;
    try {
      const res = await api('/api/runs/' + encodeURIComponent(watching.runId) + '?since=' + watching.since);
      const d = res.data;
      const passos = $('run-steps');
      const saida = $('run-output');
      if (!passos || !saida) { watching = null; return; }

      passos.innerHTML = '<div class="run-progress"><div class="run-progress-bar" style="width:' + Math.round(d.percent || 0) + '%"></div></div>'
        + '<div class="run-title">' + esc(d.name) + ' · ' + esc(d.status) + ' · ' + Math.round(d.percent || 0) + '%</div>'
        + (d.steps || []).map((s) => '<div class="run-step run-step-' + esc(s.state) + '">'
          + '<span class="run-step-mark"></span>' + esc(s.label)
          + (s.detail ? '<small>' + esc(s.detail) + '</small>' : '') + '</div>').join('');

      for (const linha of d.lines || []) {
        saida.appendChild(document.createTextNode(linha.text + '\n'));
      }
      if (d.lines && d.lines.length) saida.scrollTop = saida.scrollHeight;
      watching.since = d.lastSeq;
      if (d.status !== 'running') watching = null;
    } catch (e) { watching = null; }
  }

  // ─── Actions ───
  document.addEventListener('click', async (ev) => {
    const target = ev.target.closest('button');
    if (!target) return;

    const run = target.getAttribute('data-run');
    const toggle = target.getAttribute('data-toggle');
    const del = target.getAttribute('data-del');
    const runbk = target.getAttribute('data-runbk');
    const delbk = target.getAttribute('data-delbk');

    // Acoes que abrem dialogo ou nao seguem o padrao de linha da tabela.
    const saveTaskId = target.getAttribute('data-save-task');
    const saveBackupId = target.getAttribute('data-save-backup');
    const svc = target.getAttribute('data-svc');
    const svcDel = target.getAttribute('data-svc-del');
    const scriptDel = target.getAttribute('data-script-del');
    const scriptView = target.getAttribute('data-script-view');
    const watch = target.getAttribute('data-watch');

    try {
      if (target.id === 'btn-new-task') return taskDialog(null);
      if (target.id === 'btn-new-backup') return backupDialog(null);
      if (saveTaskId !== null) return saveTask(saveTaskId || null, target);
      if (saveBackupId !== null) return saveBackup(saveBackupId || null, target);
      if (watch) return watchRun(watch);

      if (target.getAttribute('data-edit-task')) return taskDialog(target.getAttribute('data-edit-task'));
      if (target.getAttribute('data-edit-backup')) return backupDialog(target.getAttribute('data-edit-backup'));

      if (svc) {
        const nome = target.getAttribute('data-name');
        target.disabled = true;
        await api('/api/services/' + encodeURIComponent(nome) + '/' + svc, { method: 'POST' });
        toast('Serviço ' + nome + ': ' + svc, 'success');
        loadServices();
        return;
      }
      if (svcDel) {
        if (!confirm('Remover o serviço "' + svcDel + '"?')) return;
        await api('/api/services/' + encodeURIComponent(svcDel), { method: 'DELETE' });
        toast('Serviço removido', 'success');
        loadServices();
        return;
      }
      if (scriptView) {
        const res = await api('/api/scripts/' + encodeURIComponent(scriptView));
        modal(scriptView, '<pre class="script-view"></pre>');
        // textContent, nao innerHTML: o conteudo do arquivo e dado, nunca markup.
        $('modal-host').querySelector('.script-view').textContent = res.data.content;
        return;
      }
      if (delbk) {
        if (!confirm('Excluir o perfil "' + (target.getAttribute('data-name') || '') + '"?')) return;
        await api('/api/backups/' + encodeURIComponent(delbk), { method: 'DELETE' });
        toast('Perfil excluído', 'success');
        loadBackups();
        return;
      }
      if (scriptDel) {
        if (!confirm('Excluir o script "' + scriptDel + '"?')) return;
        try {
          await api('/api/scripts/' + encodeURIComponent(scriptDel), { method: 'DELETE' });
        } catch (err) {
          if (!/in use/i.test(err.message)) throw err;
          if (!confirm('Esse script está em uso por alguma tarefa. Excluir mesmo assim?')) return;
          await api('/api/scripts/' + encodeURIComponent(scriptDel) + '?force=true', { method: 'DELETE' });
        }
        toast('Script excluído', 'success');
        loadScripts();
        return;
      }

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
  const loaders = {
    tasks: loadTasks, backups: loadBackups, history: loadHistory, logs: loadLogs,
    services: loadServices, scripts: loadScripts,
  };

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
  $('btn-reload-services').addEventListener('click', loadServices);
  $('btn-reload-scripts').addEventListener('click', loadScripts);

  $('btn-logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    location.href = '/login?notice=loggedout';
  });

  // ─── Boot ───
  (async function boot() {
    initCharts();
    try {
      const me = await api('/api/me');
      csrf = me.csrfToken || null;
      $('user-name').textContent = me.name || me.login;
      $('user-login').textContent = '@' + me.login;
      if (me.avatar) $('user-avatar').src = me.avatar;
    } catch (e) { return; }
    primeMonitor();

    // O rodapé fica sempre ativo, em qualquer tela: num servidor é por isso que
    // se abre o painel.
    pollRuns();
    runTimer = setInterval(pollRuns, 2500);

    const upload = $('script-file');
    if (upload) {
      upload.addEventListener('change', async () => {
        for (const file of upload.files) await uploadScript(file, false);
        upload.value = '';
      });
    }
    const zone = $('drop-zone');
    if (zone) {
      // Arrastar e soltar é o gesto natural para "anexar um arquivo de script".
      ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
        e.preventDefault(); zone.classList.add('over');
      }));
      ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('over')));
      zone.addEventListener('drop', async (e) => {
        e.preventDefault();
        for (const file of e.dataTransfer.files) await uploadScript(file, false);
      });
      zone.addEventListener('click', () => upload && upload.click());
    }
  })();
})();
