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

  /**
   * Busca tolerante: devolve null em vez de estourar quando a rota não existe
   * (404) ou quando esta pessoa não tem o escopo (403).
   *
   * O dashboard e a tela de histórico juntam rotas de telas diferentes, e uma
   * delas negada não pode virar toast de erro nem derrubar as outras. O 401
   * continua passando pelo api() de propósito: sessão expirada leva para o login.
   */
  async function apiQuiet(path) {
    try { return await api(path); } catch (err) { return null; }
  }

  // ─── Permissões ───
  //
  // Quem decide o acesso é a rota, no servidor (webPermissions.js). O painel
  // esconde o que a pessoa não pode usar para ela não descobrir botões que
  // sempre vão falhar - esconder botão não é controle de acesso, é honestidade.
  // Sem o campo `permissions` no /api/me (servidor antigo), nada é escondido.
  let perms = null;

  // "dashboard" não existe no catálogo de escopos: ele é a soma das telas de
  // onde ele tira número. A lista é exatamente o que loadDashboard pede - por
  // isso 'monitor' e 'logs' não entram: o dashboard não mostra métrica de
  // recurso nem linha de log, e quem só pode ler log não precisa dele.
  const DASHBOARD_SCREENS = ['tasks', 'backups', 'calendar', 'history', 'services', 'runs'];

  function can(screen, action) {
    const acao = action || 'view';
    if (!perms) return true;
    if (perms.wildcard) return true;
    const lista = perms.screens && perms.screens[screen];
    if (Array.isArray(lista)) return lista.indexOf(acao) !== -1;
    // Resumo que só trouxe a lista plana de escopos.
    if (Array.isArray(perms.scopes)) return perms.scopes.indexOf(screen + ':' + acao) !== -1;
    return false;
  }

  function pageAllowed(page) {
    if (page === 'dashboard') return DASHBOARD_SCREENS.some((s) => can(s));
    return can(page);
  }

  /** Esconde do menu as telas que este login não pode ver. */
  function applyPermissions() {
    document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
      const ok = pageAllowed(item.getAttribute('data-page'));
      item.hidden = !ok;
      if (!ok) item.classList.remove('active');
    });

    // Escrever é outro escopo que ler: quem só lê não vê botão de criar nem a
    // área de arrastar script, e não descobre a recusa tentando.
    $('btn-new-task').hidden = !can('tasks', 'write');
    $('btn-new-backup').hidden = !can('backups', 'write');
    $('btn-new-sync').hidden = !can('sync', 'write');
    $('btn-new-retention').hidden = !can('retention', 'write');
    const zone = $('drop-zone');
    if (zone) zone.hidden = !can('scripts', 'write');

    // Ninguém pode ficar numa tela que o menu acabou de esconder.
    const atual = document.querySelector('.page.active');
    const nome = atual ? atual.id.replace('page-', '') : '';
    if (nome && !pageAllowed(nome)) {
      const primeira = document.querySelector('.nav-item[data-page]:not([hidden])');
      if (primeira) goTo(primeira.getAttribute('data-page'));
    }
  }

  // ─── Formatação das telas novas ───
  const dayKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const hhmm = (ts) => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const statusBadge = (status) => {
    const s = status || '';
    const cls = /success/i.test(s) ? 'badge-active' : /partial/i.test(s) ? 'badge-warn' : s ? 'badge-error' : 'badge-info';
    return '<span class="badge ' + cls + '">' + esc(s || '—') + '</span>';
  };

  const KIND_CLASS = { task: 'k-task', backup: 'k-backup', service: 'k-service' };

  /** Linha de tabela para "não tem nada" e para "não tem permissão". */
  function linhaDeAviso(host, colspan, texto) {
    host.innerHTML = '<tr><td colspan="' + colspan + '" class="tbl-empty">' + esc(texto) + '</td></tr>';
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

  // ─── Dashboard ───
  //
  // Quatro números, quem detém o agendador e o que rodou por último - todos com
  // rotas que já existiam. Cada bloco só é buscado quando a pessoa pode vê-lo, e
  // uma recusa não impede os outros: o painel abre para um login que só enxerga,
  // por exemplo, o calendário.
  async function loadDashboard() {
    const [tarefas, perfis, agenda, histTarefas, histBackups, servicos, execucoes] = await Promise.all([
      can('tasks') ? apiQuiet('/api/tasks') : null,
      can('backups') ? apiQuiet('/api/backups') : null,
      can('calendar') ? apiQuiet(calendarRange(new Date(), 7)) : null,
      can('history') ? apiQuiet('/api/history?limit=200') : null,
      can('backups') ? apiQuiet('/api/backups/history?limit=200') : null,
      can('services') ? apiQuiet('/api/services') : null,
      can('runs') ? apiQuiet('/api/runs') : null,
    ]);

    $('dash-sub').textContent = 'atualizado às ' + new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    // 1 — tarefas
    const lista = (tarefas && tarefas.data) || null;
    if (lista) {
      $('stat-tasks').textContent = lista.filter((t) => t.Enabled !== false).length;
      $('stat-tasks-sub').textContent = lista.length + ' cadastrada(s)';
    } else semPermissaoNum('stat-tasks', 'stat-tasks-sub');

    // 2 — perfis de backup
    const cadastrados = (perfis && perfis.data) || null;
    if (cadastrados) {
      $('stat-backups').textContent = cadastrados.filter((p) => p.Enabled).length;
      $('stat-backups-sub').textContent = cadastrados.length + ' cadastrado(s)';
    } else semPermissaoNum('stat-backups', 'stat-backups-sub');

    // 3 — próxima execução: a primeira ocorrência que o /api/calendar já projetou
    const agendadas = occurrences(agenda, 'scheduled');
    if (agendadas.length) {
      $('stat-next').textContent = when(agendadas[0].at);
      $('stat-next-sub').textContent = agendadas[0].name;
    } else {
      $('stat-next').textContent = '—';
      $('stat-next-sub').textContent = agenda ? 'nada agendado nos próximos 7 dias' : 'sem acesso ao calendário';
    }

    // 4 — falhas nas últimas 24h, tarefa e backup juntos: é a pergunta que faz
    // alguém abrir o painel de manhã.
    const desde = Date.now() - 24 * 3600 * 1000;
    const falhas = falhasDesde(histTarefas, desde) + falhasDesde(histBackups, desde);
    const total24 = ((histTarefas && histTarefas.data) || []).filter(nasUltimas24h).length
      + ((histBackups && histBackups.data) || []).filter(nasUltimas24h).length;
    if (falhas || total24) {
      $('stat-failures').textContent = falhas;
      $('stat-failures-sub').textContent = total24 + ' execução(ões) em 24h';
    } else semPermissaoNum('stat-failures', 'stat-failures-sub');

    renderOwnership(servicos, execucoes);

    // Próximas execuções, da mesma resposta do calendário.
    const host = $('dash-upcoming');
    if (!agendadas.length) {
      host.innerHTML = '<div class="tbl-empty">' + (agenda ? 'Nada agendado nos próximos 7 dias' : 'Sem acesso ao calendário') + '</div>';
    } else {
      host.innerHTML = agendadas.slice(0, 6).map((o) => '<div class="upcoming-row" data-goto="' + esc(paginaDe(o)) + '"'
        + (o.id ? ' data-id="' + esc(o.id) + '"' : '') + ' role="button" tabindex="0">'
        + '<span class="cal-dot ' + (KIND_CLASS[o.kind] || '') + '"></span>'
        + '<span class="mono">' + esc(hhmm(o.at)) + '</span>'
        + '<span class="upcoming-name">' + esc(o.name) + '</span>'
        + '<span class="muted mono">' + esc(when(o.at)) + '</span></div>').join('');
    }

    // Atividade recente: as duas fontes de histórico juntas, mais recente primeiro
    const body = $('dash-activity');
    const atividade = (((histTarefas && histTarefas.data) || []).map((h) => ({ kind: 'task', h }))
      .concat(((histBackups && histBackups.data) || []).map((h) => ({ kind: 'backup', h }))))
      .filter((x) => x.h && x.h.Timestamp)
      .sort((a, b) => new Date(b.h.Timestamp) - new Date(a.h.Timestamp))
      .slice(0, 12);
    recentActivity = atividade;

    if (!histTarefas && !histBackups) linhaDeAviso(body, 6, 'Sem permissão para o histórico');
    else if (!atividade.length) linhaDeAviso(body, 6, 'Nada executado ainda');
    else body.innerHTML = atividade.map((x, i) => '<tr>'
      + '<td class="mono">' + when(x.h.Timestamp) + '</td>'
      + '<td>' + esc(x.kind === 'backup' ? x.h.ProfileName : x.h.TaskName) + '</td>'
      + '<td><span class="cal-dot ' + (KIND_CLASS[x.kind] || '') + '"></span> ' + (x.kind === 'backup' ? 'backup' : 'tarefa') + '</td>'
      + '<td>' + statusBadge(x.h.Status) + '</td>'
      + '<td class="mono">' + esc(x.h.Duration || '—') + '</td>'
      + '<td><div class="cell-actions"><button class="btn-secondary-sm" data-activity="' + i + '">Detalhe</button></div></td>'
      + '</tr>').join('');
  }

  let recentActivity = [];

  /** Ocorrências do /api/calendar em ordem de tempo, opcionalmente por estado. */
  function occurrences(res, state) {
    if (!res || !res.data || !res.data.days) return [];
    const todas = [];
    for (const lista of Object.values(res.data.days)) for (const o of lista) if (o) todas.push(o);
    return todas.filter((o) => !state || o.state === state)
      .sort((a, b) => new Date(a.at) - new Date(b.at));
  }

  const nasUltimas24h = (h) => !!h && !!h.Timestamp && new Date(h.Timestamp).getTime() >= Date.now() - 24 * 3600 * 1000;

  function falhasDesde(res, desde) {
    return ((res && res.data) || [])
      .filter((h) => h && h.Timestamp && new Date(h.Timestamp).getTime() >= desde && !/success/i.test(h.Status || ''))
      .length;
  }

  function semPermissaoNum(valorId, subId) {
    $(valorId).textContent = '—';
    // "Não veio" tem duas causas - recusa (403) ou rota fora do ar - e o painel
    // não sabe qual das duas foi. Dizer qual seria inventar.
    $(subId).textContent = 'sem permissão ou indisponível';
  }

  /**
   * Quem está executando.
   *
   * O lease com heartbeat é um arquivo em %ProgramData% e não tem rota HTTP: o
   * que dá para dizer pela rede é quem está de pé. O serviço gerenciado aparece
   * em /api/services e /api/runs diz o que está rodando agora - havendo
   * execução, quem a produz é quem detém o lease. A linha "fonte" diz de onde veio
   * a inferência, para ninguém confundir palpite com fato.
   */
  function renderOwnership(servicos, execucoes) {
    const ativos = ((execucoes && execucoes.data) || []).slice();
    const recentes = (execucoes && execucoes.recent) || [];
    const svc = ((servicos && servicos.data) || []).find((s) => /kyrios/i.test(s.Name || ''));
    const svcRodando = !!svc && /running/i.test(svc.Status || '');

    const badge = $('own-role');
    if (ativos.length) {
      badge.textContent = 'executando';
      badge.className = 'badge badge-active';
      $('own-detail').textContent = ativos.length + ' execução(ões) em andamento · '
        + (svcRodando ? 'serviço do Windows ativo' : 'serviço do Windows parado ou ausente');
    } else if (svcRodando) {
      badge.textContent = 'serviço do Windows';
      badge.className = 'badge badge-active';
      $('own-detail').textContent = 'O serviço "' + svc.Name + '" está rodando e nada está executando neste momento.';
    } else {
      badge.textContent = 'sem dono visível';
      badge.className = 'badge badge-warn';
      $('own-detail').textContent = 'Nenhuma execução em andamento e nenhum serviço gerenciado ativo. Se o aplicativo estiver aberto, é ele que executa.';
    }
    $('own-source').textContent = 'Fonte: ' + (execucoes ? '/api/runs' : '')
      + (servicos ? ' + /api/services' : '') + '. O heartbeat do lease não tem rota HTTP.';

    const host = $('own-runs');
    if (ativos.length) {
      host.innerHTML = ativos.map((r) => '<button class="run-chip" data-watch="' + esc(r.runId) + '">'
        + '<span class="run-dot"></span>' + esc(r.name)
        + '<span class="run-pct">' + Math.round(r.percent || 0) + '%</span></button>').join('');
    } else if (recentes.length) {
      const ultimo = recentes[0];
      host.innerHTML = '<div class="muted">Última execução: ' + esc(ultimo.name || '—')
        + ' · ' + (ultimo.status === 'running' ? 'em andamento' : when(ultimo.endedAt || ultimo.startedAt)) + '</div>';
    } else host.innerHTML = '';
  }

  /** calendarData responde "backup" no page; a tela do painel se chama "backups". */
  function paginaDe(o) {
    return o.page === 'backup' ? 'backups' : o.page;
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
      body.innerHTML = tasks.map((t) => '<tr data-row-id="' + esc(t.Id) + '">'
        + '<td>' + esc(t.Name) + '</td>'
        + '<td class="mono">' + esc(t.CronExpression) + '</td>'
        + '<td class="mono">' + esc(t.ScriptPath || '—') + '</td>'
        + '<td><span class="badge ' + (t.Enabled !== false ? 'badge-active">ativa' : 'badge-disabled">desativada') + '</span></td>'
        + '<td><div class="cell-actions">'
        // Escrever, executar e apagar são escopos diferentes: quem só tem
        // "tasks:view" não vê botão nenhum aqui.
        + (can('tasks', 'write') ? '<button class="btn-secondary-sm" data-edit-task="' + esc(t.Id) + '">Editar</button>' : '')
        + (can('tasks', 'run') ? '<button class="btn-secondary-sm" data-run="' + esc(t.Id) + '">Executar</button>' : '')
        + (can('tasks', 'write') ? '<button class="btn-secondary-sm" data-toggle="' + esc(t.Id) + '">' + (t.Enabled !== false ? 'Desativar' : 'Ativar') + '</button>' : '')
        + (can('tasks', 'delete') ? '<button class="btn-danger" data-del="' + esc(t.Id) + '" data-name="' + esc(t.Name) + '">Excluir</button>' : '')
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
        return '<tr data-row-id="' + esc(p.Id) + '">'
          + '<td>' + esc(p.Name) + '</td>'
          + '<td class="mono">' + esc(p.User) + '@' + esc(p.Host) + ':' + esc(p.Port) + '</td>'
          + '<td class="mono">' + esc((p.Databases || []).join(', ') || 'todos') + '</td>'
          + '<td class="mono">' + esc(p.CronExpression || '—') + '</td>'
          + '<td><span class="badge ' + status + '">' + esc(p.LastStatus || 'nunca') + '</span>'
          + '<div class="page-sub">' + when(p.LastRun) + '</div></td>'
          + '<td><div class="cell-actions">'
          + (can('backups', 'write') ? '<button class="btn-secondary-sm" data-edit-backup="' + esc(p.Id) + '">Editar</button>' : '')
          + (can('backups', 'run') ? '<button class="btn-secondary-sm" data-runbk="' + esc(p.Id) + '">Executar</button>' : '')
          + (can('backups', 'delete') ? '<button class="btn-danger" data-delbk="' + esc(p.Id) + '" data-name="' + esc(p.Name) + '">Excluir</button>' : '')
          + '</div></td></tr>';
      }).join('');
    } catch (err) {
      body.innerHTML = '<tr><td colspan="6" class="tbl-empty">Erro: ' + esc(err.message) + '</td></tr>';
    }
  }

  // ─── Sincronismo e retenção ───
  //
  // As duas telas listam perfis e abrem o editor em modal. A divisão de peso é a
  // mesma do servidor: analisar, prever, simular e testar conexão só LEEM o disco
  // (sync:view), e só "Executar" e "Excluir" pedem :run e :delete. O painel
  // esconde o que falta de escopo - e o que falta não é chamado.
  const POLITICA_PADRAO = () => ({
    Enabled: false, DateSource: 'metadata', FileExtensions: ['.7z', '.zip'],
    ByAge: true, KeepDays: 30, ByCount: false, KeepCount: 10, BySize: false, FreeGb: 10,
    ByWeekly: false, WeeklyKeepWeeks: 8, ByBiweekly: false, BiweeklyKeepPeriods: 12,
    ByMonthly: false, MonthlyKeepMonths: 12, MinKeep: 3,
  });

  // O motor aceita as duas grafias e devolve as duas; a tela escolhe uma e não
  // inventa um terceiro formato de lista.
  const formatosDe = (r) => {
    if (r && Array.isArray(r.FileExtensions)) return r.FileExtensions;
    if (r && Array.isArray(r.Extensions)) return r.Extensions;
    return ['.7z', '.zip'];
  };

  /**
   * A política em uma frase: cabe na coluna da tabela e no resumo do modal.
   * Os formatos entram só quando a política os traz - a sugestão da análise não
   * filtra formato nenhum, e dizer ".7z .zip" ali seria inventar filtro.
   */
  function politicaResumo(r, comFormatos) {
    if (!r || !r.Enabled) return 'desligada';
    const partes = [
      r.ByAge ? r.KeepDays + ' dias' : null,
      r.ByCount ? r.KeepCount + ' cópias' : null,
      r.BySize ? r.FreeGb + ' GB livres' : null,
      r.ByWeekly ? '1/semana × ' + r.WeeklyKeepWeeks : null,
      r.ByBiweekly ? '1/quinze dias × ' + r.BiweeklyKeepPeriods : null,
      r.ByMonthly ? '1/mês × ' + r.MonthlyKeepMonths : null,
    ].filter(Boolean);
    const texturas = formatosDe(r);
    return (partes.join(' · ') || 'sem critério')
      + ' · mín. ' + (r.MinKeep == null ? 0 : r.MinKeep)
      + (comFormatos === false ? ''
        : ' · ' + (texturas.length ? texturas.join(' ') : 'todos os formatos'));
  }

  /**
   * 503 é o servidor sem o módulo de sync ou retenção injetado: a tela fica
   * travada e não é erro de quem clicou. "Não veio" por recusa (403) ou por
   * rota fora do ar tem a mesma cara daqui - e dizer qual seria inventar.
   */
  const falhaDeTela = (erro) => (/unavailable/i.test((erro && erro.message) || '')
    ? 'o servidor não carregou este módulo'
    : 'erro: ' + ((erro && erro.message) || 'desconhecido'));

  function destinoDe(p) {
    if (!p) return '—';
    return p.Engine && p.Engine !== 'local'
      ? (p.Host || '?') + ':' + (p.Port || '') + ' ' + (p.DestPath || '')
      : (p.DestPath || '—');
  }

  async function loadSync() {
    const body = $('sync-body');
    if (!can('sync')) { linhaDeAviso(body, 6, 'Sem permissão para ver o sincronismo'); $('sync-sub').textContent = '—'; return; }
    body.innerHTML = '<tr><td colspan="6" class="tbl-loading">carregando</td></tr>';

    let res;
    try {
      res = await api('/api/sync');
    } catch (err) {
      linhaDeAviso(body, 6, 'Não foi possível ler os perfis: ' + falhaDeTela(err));
      $('sync-sub').textContent = falhaDeTela(err);
      return;
    }

    const list = res.data || [];
    const ativos = list.filter((p) => p.Enabled !== false);
    const comRetencao = list.filter((p) => p.Retention && p.Retention.Enabled);
    const comCron = list.filter((p) => p.CronExpression);
    const falhos = list.filter((p) => p.LastStatus && !/success/i.test(p.LastStatus));

    $('sync-sub').textContent = list.length + ' perfil(is) · ' + ativos.length + ' ativo(s)';
    $('stat-sync-total').textContent = list.length;
    $('stat-sync-total-sub').textContent = list.length + ' cadastrado(s)';
    $('stat-sync-active').textContent = ativos.length;
    $('stat-sync-active-sub').textContent = comCron.length + ' com expressão cron';
    $('stat-sync-retention').textContent = comRetencao.length;
    $('stat-sync-retention-sub').textContent = list.length
      ? Math.round((comRetencao.length * 100) / list.length) + '% dos perfis' : '—';
    $('stat-sync-fail').textContent = falhos.length;
    $('stat-sync-fail-sub').textContent = falhos.length ? 'última execução com erro' : 'nenhuma falha registrada';

    if (!list.length) { linhaDeAviso(body, 6, 'Nenhum perfil de sincronismo cadastrado'); return; }

    body.innerHTML = list.map((p) => '<tr data-row-id="' + esc(p.Id) + '">'
      + '<td>' + esc(p.Name) + '<div class="page-sub">' + esc(p.Engine || 'local') + ' · ' + esc(p.Mode || 'incremental') + '</div></td>'
      + '<td class="mono">' + esc(p.SourcePath || '—') + '<div class="page-sub">→ ' + esc(destinoDe(p)) + '</div></td>'
      + '<td>' + esc(politicaResumo(p.Retention)) + '</td>'
      + '<td class="mono">' + esc(p.CronExpression || '—') + '</td>'
      + '<td>' + statusBadge(p.LastStatus) + '<div class="page-sub">' + when(p.LastRun) + '</div></td>'
      + '<td><div class="cell-actions">'
      + (can('sync', 'write') ? '<button class="btn-secondary-sm" data-edit-sync="' + esc(p.Id) + '">Editar</button>' : '')
      + (can('sync', 'run') ? '<button class="btn-secondary-sm" data-runsync="' + esc(p.Id) + '" data-name="' + esc(p.Name) + '">Executar</button>' : '')
      + (can('sync', 'delete') ? '<button class="btn-danger" data-delsync="' + esc(p.Id) + '" data-name="' + esc(p.Name) + '">Excluir</button>' : '')
      + '</div></td></tr>').join('');
  }

  async function loadRetention() {
    const body = $('retention-body');
    if (!can('retention')) { linhaDeAviso(body, 6, 'Sem permissão para ver as agendas de retenção'); $('retention-sub').textContent = '—'; return; }
    body.innerHTML = '<tr><td colspan="6" class="tbl-loading">carregando</td></tr>';

    let res;
    try {
      res = await api('/api/retention');
    } catch (err) {
      linhaDeAviso(body, 6, 'Não foi possível ler as agendas: ' + falhaDeTela(err));
      $('retention-sub').textContent = falhaDeTela(err);
      return;
    }

    const list = res.data || [];
    const ativas = list.filter((p) => p.Enabled !== false);
    // "Pronta para rodar" é o que o serviço de fato agenda: enabled, com
    // política ligada e com expressão cron válida.
    const prontas = list.filter((p) => p.Enabled !== false && p.Retention && p.Retention.Enabled && p.CronExpression);
    const falhos = list.filter((p) => p.LastStatus && !/success/i.test(p.LastStatus));

    $('retention-sub').textContent = list.length + ' agenda(s) · ' + ativas.length + ' ativa(s)';
    $('stat-ret-total').textContent = list.length;
    $('stat-ret-total-sub').textContent = list.length + ' cadastrada(s)';
    $('stat-ret-active').textContent = ativas.length;
    $('stat-ret-active-sub').textContent = ativas.length === list.length ? 'todas ligadas' : (list.length - ativas.length) + ' desligada(s)';
    $('stat-ret-age').textContent = prontas.length;
    $('stat-ret-age-sub').textContent = 'com política e cron';
    $('stat-ret-fail').textContent = falhos.length;
    $('stat-ret-fail-sub').textContent = falhos.length ? 'última execução com erro' : 'nenhuma falha registrada';

    if (!list.length) { linhaDeAviso(body, 6, 'Nenhuma agenda de retenção cadastrada'); return; }

    body.innerHTML = list.map((p) => '<tr data-row-id="' + esc(p.Id) + '">'
      + '<td>' + esc(p.Name) + (p.Description ? '<div class="page-sub">' + esc(p.Description) + '</div>' : '') + '</td>'
      + '<td class="mono">' + esc(p.FolderPath || '—') + '</td>'
      + '<td>' + esc(politicaResumo(p.Retention)) + '</td>'
      + '<td class="mono">' + esc(p.CronExpression || '—') + '</td>'
      + '<td>' + statusBadge(p.LastStatus) + '<div class="page-sub">' + when(p.LastRun) + '</div></td>'
      + '<td><div class="cell-actions">'
      + (can('retention', 'write') ? '<button class="btn-secondary-sm" data-edit-ret="' + esc(p.Id) + '">Editar</button>' : '')
      + (can('retention', 'run') ? '<button class="btn-secondary-sm" data-runret="' + esc(p.Id) + '" data-name="' + esc(p.Name) + '">Executar</button>' : '')
      + (can('retention', 'delete') ? '<button class="btn-danger" data-delret="' + esc(p.Id) + '" data-name="' + esc(p.Name) + '">Excluir</button>' : '')
      + '</div></td></tr>').join('');
  }

  // ─── Histórico ───
  //
  // Tarefas e backups têm históricos diferentes, guardados em rotas diferentes:
  // as duas abas respondem a mesma pergunta - "o que rodou" - com as duas fontes.
  // O detalhe sai da linha já carregada: o servidor não tem rota de histórico por
  // item, e inventar uma seria chamar rota que não existe.
  let historyTab = 'tasks';
  let historyRows = [];

  const HIST_SOURCES = {
    tasks: { path: '/api/history?limit=100', screen: 'history', nome: (h) => h.TaskName, alvo: 'tasks' },
    backups: { path: '/api/backups/history?limit=100', screen: 'backups', nome: (h) => h.ProfileName, alvo: 'backups' },
  };

  async function loadHistory() {
    const fonte = HIST_SOURCES[historyTab];
    const body = $('history-body');
    if (!can(fonte.screen)) {
      linhaDeAviso(body, 6, 'Sem permissão para ver o histórico desta aba');
      $('history-sub').textContent = '—';
      return;
    }

    body.innerHTML = '<tr><td colspan="6" class="tbl-loading">carregando</td></tr>';
    const res = await apiQuiet(fonte.path);
    if (!res) { linhaDeAviso(body, 6, 'Não foi possível ler o histórico'); return; }
    const rows = res.data || [];
    historyRows = rows;
    $('history-col-name').textContent = historyTab === 'tasks' ? 'Tarefa' : 'Perfil';
    // Duas abas, dois históricos: o subtítulo diz de qual fonte veio a linha, senão
    // "3 execuções" não diz se são tarefas ou backups.
    $('history-sub').textContent = rows.length + ' execução(ões) de '
      + (historyTab === 'tasks' ? 'tarefa' : 'backup') + ' registrada(s)';

    if (!rows.length) { linhaDeAviso(body, 6, historyTab === 'tasks' ? 'Nada executado ainda' : 'Nenhum backup executado ainda'); return; }

    body.innerHTML = rows.map((h, i) => '<tr>'
      + '<td class="mono">' + when(h.Timestamp) + '</td>'
      + '<td>' + esc(fonte.nome(h) || '—') + '</td>'
      + '<td>' + statusBadge(h.Status) + '</td>'
      + '<td class="mono">' + esc(h.Duration || '—') + '</td>'
      + '<td class="mono" title="' + esc(h.Message || '') + '">' + esc((h.Message || '—').slice(0, 90)) + '</td>'
      + '<td><div class="cell-actions">'
      + '<button class="btn-secondary-sm" data-hdetail="' + i + '">Detalhe</button>'
      // Ir para a tela do item: uma linha do histórico só serve para isso se
      // levar ao cadastro que a produziu.
      + (h.TaskId || h.ProfileId ? '<button class="btn-secondary-sm" data-goto="' + fonte.alvo + '"'
          + ' data-id="' + esc(h.TaskId || h.ProfileId) + '">Abrir</button>' : '')
      + '</div></td></tr>').join('');
  }

  /** Modal de detalhe de uma linha de histórico (task ou backup). */
  function openDetail(h, kind) {
    const linhas = [
      ['Quando', when(h.Timestamp)],
      ['Origem', kind === 'backup' ? 'Backup' : 'Tarefa'],
      ['Nome', kind === 'backup' ? h.ProfileName : h.TaskName],
      ['Status', h.Status || '—'],
      ['Duração', h.Duration || '—'],
    ];
    if (h.CronExpression) linhas.push(['Cron', h.CronExpression]);
    if (h.Databases) linhas.push(['Bancos', (h.Databases || []).join(', ') || 'todos']);
    if (h.TotalSizeHuman) linhas.push(['Tamanho', h.TotalSizeHuman]);
    if (h.LogPath) linhas.push(['Log', h.LogPath]);
    if (h.ExitCode !== undefined) linhas.push(['Código de saída', String(h.ExitCode)]);

    modal(kind === 'backup' ? 'Execução de backup' : 'Execução de tarefa',
      '<div class="detail-grid">'
      + linhas.map(([k, v]) => '<div class="detail-row"><span>' + esc(k) + '</span><b class="' + (/caminho|log/i.test(k) ? 'mono' : '') + '">' + esc(v) + '</b></div>').join('')
      + '</div>'
      + '<div class="field"><span>Mensagem</span><pre class="script-view"></pre></div>',
      '<button class="btn-ghost" data-modal-close>Fechar</button>');
    // textContent: a mensagem vem do script executado, é dado, nunca markup.
    $('modal-host').querySelector('.script-view').textContent = h.Message || '(sem mensagem)';
  }

  // ─── Calendário ───
  //
  // Mês, semana e agenda, todos lendo a mesma resposta de /api/calendar: o que
  // já rodou vem do histórico, o que vem vem das expressões cron. O passado
  // projetado e o futuro executed ficam na mesma linha do tempo.
  let calView = 'month';
  let calAnchor = new Date();
  let calCache = null;
  let calSequence = 0;

  function calendarRange(base, dias) {
    const from = new Date(base);
    const to = new Date(base);
    to.setDate(to.getDate() + dias);
    return '/api/calendar?from=' + encodeURIComponent(from.toISOString())
      + '&to=' + encodeURIComponent(to.toISOString());
  }

  /** O intervalo que a visão atual precisa, não o que a tela inteira mostra. */
  function calendarWindow() {
    const from = new Date(calAnchor);
    const to = new Date(calAnchor);
    if (calView === 'month') {
      from.setDate(1);
      from.setDate(from.getDate() - from.getDay());            // encher a semana da esquerda
      to.setMonth(to.getMonth() + 1, 0);
      to.setDate(to.getDate() + (6 - to.getDay()));
    } else if (calView === 'week') {
      from.setDate(from.getDate() - from.getDay());
      to.setTime(from.getTime());
      to.setDate(to.getDate() + 6);
    } else {
      to.setDate(to.getDate() + 13);                            // agenda: a fortnight
    }
    return { from, to };
  }

  function calendarUrl() {
    const { from, to } = calendarWindow();
    return '/api/calendar?from=' + encodeURIComponent(from.toISOString())
      + '&to=' + encodeURIComponent(to.toISOString());
  }

  async function loadCalendar() {
    const body = $('cal-body');
    if (!can('calendar')) { body.innerHTML = '<div class="tbl-empty">Sem permissão para o calendário</div>'; return; }
    body.innerHTML = '<div class="tbl-loading">carregando</div>';

    const sequencia = ++calSequence;
    const res = await apiQuiet(calendarUrl());
    if (sequencia !== calSequence) return;   // resposta de uma navegação antiga
    if (!res) {
      body.innerHTML = '<div class="tbl-empty">Não foi possível ler o calendário</div>';
      $('cal-totals').innerHTML = '';
      return;
    }

    calCache = res.data || { days: {}, totals: {} };
    renderCalendar();
  }

  const chip = (o) => '<div class="cal-chip ' + (KIND_CLASS[o.kind] || '') + ' s-' + esc(o.state || 'scheduled') + '"'
    + ' data-goto="' + esc(paginaDe(o)) + '"' + (o.id ? ' data-id="' + esc(o.id) + '"' : '')
    + ' role="button" tabindex="0" title="' + esc(o.name + ' · ' + hhmm(o.at)) + '">'
    + '<span class="cal-chip-time">' + esc(hhmm(o.at)) + '</span><span class="cal-chip-name">' + esc(o.name) + '</span></div>';

  function calMonth() {
    const primeiro = new Date(calAnchor.getFullYear(), calAnchor.getMonth(), 1);
    const inicio = new Date(primeiro);
    inicio.setDate(inicio.getDate() - inicio.getDay());
    const hoje = dayKey(new Date());
    const dias = [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(2024, 0, 7 + i).toLocaleDateString('pt-BR', { weekday: 'short' }));

    let html = '<div class="cal-grid"><div class="cal-weekdays">' + dias.map((d) => '<div>' + esc(d) + '</div>').join('') + '</div><div class="cal-days">';
    const cursor = new Date(inicio);
    for (let i = 0; i < 42; i++) {
      const chave = dayKey(cursor);
      const itens = (calCache.days || {})[chave] || [];
      const fora = cursor.getMonth() !== calAnchor.getMonth();
      const classes = ['cal-day'];
      if (fora) classes.push('outside');
      if (chave === hoje) classes.push('today');
      if (itens.length) classes.push('has-items');

      html += '<div class="' + classes.join(' ') + '">'
        + '<div class="cal-day-num">' + cursor.getDate() + '</div>'
        + '<div class="cal-day-items">' + itens.slice(0, 3).map(chip).join('')
        + (itens.length > 3 ? '<div class="cal-more" data-open-day="' + esc(chave) + '" role="button" tabindex="0">+' + (itens.length - 3) + '</div>' : '')
        + '</div></div>';
      cursor.setDate(cursor.getDate() + 1);
    }
    return html + '</div></div>';
  }

  function calWeek() {
    const { from } = calendarWindow();
    const dias = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      dias.push(d);
    }

    // Só as horas que têm algo, mais um dia útil de referência: 24 linhas quase
    // vazias não dizem nada.
    const usadas = new Set();
    for (const d of dias) for (const o of (calCache.days || {})[dayKey(d)] || []) usadas.add(new Date(o.at).getHours());
    const horas = Array.from(new Set([...usadas, 0, 6, 12, 18])).sort((a, b) => a - b);
    const hoje = dayKey(new Date());

    let html = '<div class="cal-week"><div class="cal-week-head"><div class="cal-week-corner"></div>'
      + dias.map((d) => '<div class="cal-week-day' + (dayKey(d) === hoje ? ' today' : '') + '">'
        + '<div>' + esc(d.toLocaleDateString('pt-BR', { weekday: 'short' })) + '</div><strong>' + d.getDate() + '</strong></div>').join('')
      + '</div><div class="cal-week-body">';

    for (const hora of horas) {
      html += '<div class="cal-week-row"><div class="cal-week-hour">' + String(hora).padStart(2, '0') + 'h</div>';
      for (const d of dias) {
        const itens = ((calCache.days || {})[dayKey(d)] || []).filter((o) => new Date(o.at).getHours() === hora);
        html += '<div class="cal-week-cell">' + itens.map(chip).join('') + '</div>';
      }
      html += '</div>';
    }
    return html + '</div></div>';
  }

  function calAgenda() {
    const chaves = Object.keys(calCache.days || {}).sort();
    if (!chaves.length) return '<div class="tbl-empty">Nada agendado ou executado neste período</div>';

    return '<div class="cal-agenda">' + chaves.map((chave) => {
      const d = new Date(chave + 'T00:00:00');
      return '<div class="cal-agenda-day">'
        + '<div class="cal-agenda-date"><strong>' + d.getDate() + '</strong><span>'
        + esc(d.toLocaleDateString('pt-BR', { month: 'short', weekday: 'short' })) + '</span></div>'
        + '<div class="cal-agenda-items">' + (calCache.days[chave] || []).map((o) => '<div class="cal-agenda-item"'
          + ' data-goto="' + esc(paginaDe(o)) + '"' + (o.id ? ' data-id="' + esc(o.id) + '"' : '')
          + ' role="button" tabindex="0">'
          + '<span class="cal-agenda-time mono">' + esc(hhmm(o.at)) + '</span>'
          + '<span class="cal-dot ' + (KIND_CLASS[o.kind] || '') + ' s-' + esc(o.state || 'scheduled') + '"></span>'
          + '<span class="cal-agenda-name">' + esc(o.name) + '</span>'
          + '<span class="cal-agenda-kind">' + esc(o.kind === 'backup' ? 'backup' : o.kind === 'service' ? 'serviço' : 'tarefa') + '</span>'
          + (o.state !== 'scheduled' ? '<span class="badge ' + (o.state === 'success' ? 'badge-active' : 'badge-error') + '">'
              + esc(o.duration || o.state) + '</span>' : '')
          + '</div>').join('') + '</div></div>';
    }).join('') + '</div>';
  }

  function renderCalendar() {
    const body = $('cal-body');
    if (!body) return;
    body.innerHTML = calView === 'month' ? calMonth() : calView === 'week' ? calWeek() : calAgenda();

    const totais = calCache.totals || {};
    $('cal-totals').innerHTML = [
      ['agendadas', totais.scheduled || 0, ''],
      ['executadas', totais.executed || 0, 'ok'],
      ['com falha', totais.failed || 0, totais.failed ? 'bad' : ''],
      ['origens', totais.sources || 0, 'neutral'],
    ].map(([rotulo, valor, cls]) => '<div class="cal-metric ' + cls + '"><span><strong>' + valor + '</strong>'
      + esc(rotulo) + '</span></div>').join('');

    const periodo = calView === 'month'
      ? calAnchor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
      : calView === 'week'
        ? (() => { const { from, to } = calendarWindow(); return from.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
          + ' – ' + to.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }); })()
        : 'Próximos 14 dias';
    $('cal-period').textContent = periodo;
    $('calendar-sub').textContent = (totais.scheduled || 0) + ' agendada(s) · '
      + (totais.executed || 0) + ' executada(s) · ' + (totais.failed || 0) + ' com falha';
  }

  function calShift(direcao) {
    if (calView === 'month') calAnchor = new Date(calAnchor.getFullYear(), calAnchor.getMonth() + direcao, 1);
    else if (calView === 'week') calAnchor.setDate(calAnchor.getDate() + 7 * direcao);
    else calAnchor.setDate(calAnchor.getDate() + 14 * direcao);
    loadCalendar();
  }

  // ─── Logs ───
  //
  // Erros e auditoria vêm do mesmo logger que o desktop usa em disco.
  const LOG_SOURCES = [
    { id: 'app', label: 'Aplicação', path: '/api/logs?limit=250', screen: 'logs', resolve: (r) => r && r.data },
    { id: 'errors', label: 'Erros', path: '/api/logs/errors?limit=250', screen: 'logs', resolve: (r) => r && r.data },
    { id: 'audit', label: 'Auditoria', path: '/api/logs/audit?limit=250', screen: 'logs', resolve: (r) => r && r.data },
  ];

  let logsTab = 'app';
  let logsLevel = '';

  function renderLogTabs() {
    const host = $('logs-tabs');
    const ativas = LOG_SOURCES.filter((s) => s.path);
    if (!ativas.length) { host.innerHTML = ''; return; }
    host.innerHTML = ativas.map((s) => '<button class="tab' + (s.id === logsTab ? ' active' : '') + '" type="button"'
      + ' data-logtab="' + s.id + '" role="tab" aria-selected="' + (s.id === logsTab) + '">' + esc(s.label) + '</button>').join('');
  }

  async function loadLogs() {
    renderLogTabs();
    const card = $('logs-card');
    if (!can('logs')) { card.innerHTML = '<div class="tbl-empty">Sem permissão para ver os logs</div>'; return; }

    const fonte = LOG_SOURCES.find((s) => s.id === logsTab) || LOG_SOURCES[0];
    if (!fonte.path) { card.innerHTML = '<div class="tbl-empty">Sem registros</div>'; return; }

    card.innerHTML = '<div class="tbl-loading">carregando</div>';
    const res = await apiQuiet(fonte.path);
    if (!res) { card.innerHTML = '<div class="tbl-empty">Não foi possível ler os logs</div>'; return; }
    let rows = (fonte.resolve(res) || []).slice();
    if (logsLevel) rows = rows.filter((l) => String(l.level || '').toUpperCase() === logsLevel);

    const contagem = (nivel) => (fonte.resolve(res) || []).filter((l) => String(l.level || '').toUpperCase() === nivel).length;
    $('logs-sub').textContent = rows.length + ' linha(s)'
      + (logsLevel ? ' em ' + logsLevel : '')
      + ' · ' + contagem('ERROR') + ' erro(s) · ' + contagem('WARN') + ' aviso(s)';

    if (!rows.length) { card.innerHTML = '<div class="tbl-empty">Sem registros</div>'; return; }
    card.innerHTML = rows.slice().reverse().map((l) => '<div class="log-line">'
      + '<span class="ts">' + when(l.timestamp) + '</span>'
      + '<span class="lvl lvl-' + esc(l.level) + '">' + esc(l.level) + '</span>'
      + esc(l.message) + '</div>').join('');
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
    // Fechar o modal fecha o rascunho junto: se ele sobreviver, o próximo
    // "editar" nasceria com o rascunho do outro perfil.
    syncRascunho = null;
    retRascunho = null;
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

  // ─── Editores em modal: sincronismo e retenção ───
  //
  // Passos com dica no topo, como o desktop: quem nunca mexeu em sincronismo
  // precisa saber o que cada passo faz antes de salvar. Tudo que o formulário
  // toca é um rascunho em memória - o corpo da requisição sai dele, e por isso
  // "simular" mostra exatamente o que está na tela, sem gravar nada antes.
  const SYNC_PASSOS = [
    { id: 'folders', label: 'Pastas', tip: 'A origem é uma pasta do servidor. O destino é local, SMB, FTP ou SFTP — os três últimos pedem host, porta e credenciais.' },
    { id: 'retention', label: 'Retenção', tip: 'A política roda no destino depois da cópia. Analisar, prever e simular só leem o disco: nenhuma dessas três apaga arquivo.' },
    { id: 'schedule', label: 'Agenda', tip: 'Sem expressão cron o perfil só roda quando alguém apertar Executar. A expressão tem cinco campos: minuto hora dia mês dia-da-semana.' },
  ];
  const RET_PASSOS = [
    { id: 'folder', label: 'Pasta', tip: 'A agenda cuida de uma pasta do servidor, com caminho absoluto, e não depende de perfil de sincronismo.' },
    { id: 'policy', label: 'Política e agenda', tip: 'Uma política ativa precisa de pelo menos um critério — idade, quantidade, espaço ou cópias periódicas. O servidor recusa política sem critério.' },
  ];

  let syncRascunho = null;
  let retRascunho = null;

  const rascunhoAberto = () => syncRascunho || retRascunho;

  function noRascunho(dono, chave, valor) {
    const partes = chave.split('.');
    const ultima = partes.pop();
    const alvo = partes.reduce((o, k) => (o[k] = o[k] || {}), dono.data);
    alvo[ultima] = valor;
  }

  /** Campo do rascunho. A dica fica no "?" e o valor volta pela chave data-sf. */
  function sf(label, chave, valor, opts) {
    const o = opts || {};
    return '<label class="field"><span>' + esc(label)
      + (o.tip ? ' <i class="dica" role="img" aria-label="' + esc(o.tip) + '" title="' + esc(o.tip) + '">?</i>' : '')
      + '</span><input class="input' + (o.mono ? ' mono' : '') + '" type="' + (o.type || 'text') + '" data-sf="' + esc(chave) + '"'
      + ' value="' + esc(valor == null ? '' : valor) + '"'
      + (o.min != null ? ' min="' + o.min + '"' : '')
      + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') + '>'
      + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '') + '</label>';
  }

  function sfs(label, chave, valor, opcoes, opts) {
    const o = opts || {};
    return '<label class="field"><span>' + esc(label)
      + (o.tip ? ' <i class="dica" role="img" aria-label="' + esc(o.tip) + '" title="' + esc(o.tip) + '">?</i>' : '')
      + '</span><select class="input" data-sf="' + esc(chave) + '">'
      + opcoes.map(([v, t]) => '<option value="' + esc(v) + '"' + (String(v) === String(valor == null ? '' : valor) ? ' selected' : '') + '>' + esc(t) + '</option>').join('')
      + '</select>' + (o.hint ? '<small>' + esc(o.hint) + '</small>' : '') + '</label>';
  }

  /** Regra com o número do lado: "manter 30 dias", "livrar 10 GB". */
  function sfRegra(chave, marcada, texto, numero) {
    return '<label class="check-row"><input type="checkbox" data-sf="' + esc(chave) + '"' + (marcada ? ' checked' : '') + '>'
      + '<span>' + esc(texto)
      + (numero ? ' <input class="input input-num" type="number" min="' + (numero.min == null ? 0 : numero.min) + '" data-sf="' + esc(numero.chave) + '" value="' + esc(numero.valor) + '"> ' + esc(numero.unidade)
        : '') + '</span></label>';
  }

  const CHIPS_CRON = [['0 * * * *', 'a cada hora'], ['0 3 * * *', 'todo dia 3h'], ['0 2 * * 1-5', 'dias úteis 2h'], ['*/15 * * * *', 'de 15 em 15 min']];

  function cronChips() {
    return '<div class="wiz-chips">' + CHIPS_CRON.map(([expr, rotulo]) =>
      '<span class="chip" data-sf-cron="' + esc(expr) + '" role="button" tabindex="0">' + esc(rotulo) + '</span>').join('') + '</div>';
  }

  /** Casca de modal com passos: trilho, dica do passo e o corpo. */
  function modalPassos(titulo, passos, atual, prefixo, corpoHtml, acoesHtml) {
    return modal(titulo,
      '<div class="wiz-steps" role="tablist">' + passos.map((p, i) =>
        '<button class="wiz-step' + (i === atual ? ' active' : '') + (i < atual ? ' done' : '') + '" type="button" role="tab"'
        + ' aria-selected="' + (i === atual) + '" data-' + prefixo + '-step="' + i + '">' + (i + 1) + '. ' + esc(p.label) + '</button>').join('')
      + '</div><p class="wiz-tip">' + esc(passos[atual].tip) + '</p>'
      + '<div class="wiz-body">' + corpoHtml + '</div>',
      acoesHtml);
  }

  // ─── Sincronismo: abrir, passos, analisar, prever, simular ───

  async function syncDialog(id) {
    let base = {
      Name: '', Description: '', SourcePath: '', DestPath: '', Engine: 'local',
      Host: '', Port: '', User: '', Password: '', Mode: 'incremental', Mirror: true,
      Excludes: [], CronExpression: '', Enabled: true, WatchEnabled: false,
      WatchDebounceMs: 1500, TriggerTaskId: '', Retention: POLITICA_PADRAO(),
    };
    if (id) {
      try {
        base = Object.assign(base, (await api('/api/sync/' + encodeURIComponent(id))).data);
        // A senha nunca volta do servidor: campo vazio é "não mexer".
        base.Password = '';
        base.Excludes = Array.isArray(base.Excludes) ? base.Excludes : [];
        base.Retention = Object.assign(POLITICA_PADRAO(), base.Retention || {});
        // O campo de formatos é texto; sem esta linha um perfil que ninguém
        // tocasse voltaria com a lista vazia - que o motor lê como "todos".
        base.Retention.Formats = formatosDe(base.Retention).join(' ');
      } catch (err) { toast('Erro ao abrir o perfil: ' + err.message, 'error'); return; }
    }
    // O seletor de motor já nasce com o valor do perfil; a lista completa
    // entra quando /api/sync/engines responder, sem refazer o modal.
    const proprio = { id: base.Engine || 'local', label: base.Engine || 'local', credentials: (base.Engine || 'local') !== 'local' };
    syncRascunho = { id: id || null, step: 0, data: base, engines: [proprio], analysis: null, preview: null, sim: null, conn: null, ocupado: false, render: renderSyncModal };
    renderSyncModal();
    carregarEngines();
  }

  /**
   * Os motores vêm do servidor (sync:view). Sem esse escopo o seletor fica
   * com o que o próprio perfil já usa - e a linha diz por quê, em vez de
   * mostrar uma lista inventada.
   */
  async function carregarEngines() {
    if (!syncRascunho) return;
    if (!can('sync')) {
      const d = syncRascunho.data;
      syncRascunho.engines = [{ id: d.Engine || 'local', label: d.Engine || 'local', credentials: (d.Engine || 'local') !== 'local' }];
      renderSyncModal();
      return;
    }
    const res = await apiQuiet('/api/sync/engines');
    if (!syncRascunho) return;
    if (!res || !res.data) {
      syncRascunho.engines = [{ id: syncRascunho.data.Engine || 'local', label: syncRascunho.data.Engine || 'local', credentials: false }];
      renderSyncModal();
      return;
    }
    syncRascunho.engines = res.data;
    renderSyncModal();
  }

  const motorDe = (id) => syncRascunho.engines.find((e) => e.id === id) || { id, label: id, credentials: id !== 'local' };

  function syncPassoAtual() {
    const d = syncRascunho.data;
    const r = d.Retention || {};
    const motor = motorDe(d.Engine || 'local');

    if (syncRascunho.step === 0) {
      return sf('Nome', 'Name', d.Name, { required: true, tip: 'Como o perfil aparece na lista e no log de auditoria.' })
        + sf('Pasta de origem', 'SourcePath', d.SourcePath, { mono: true, placeholder: 'D:\\Dados\\Producao', tip: 'A pasta lida pelo servidor. Ela precisa existir aí, não no seu computador.', hint: 'caminho absoluto no servidor' })
        + sfs('Destino', 'Engine', d.Engine || 'local', syncRascunho.engines.map((e) => [e.id, e.label]), { tip: 'Local copia no próprio disco; SMB, FTP e SFTP abrem conexão com credenciais.' })
        + sf('Pasta de destino', 'DestPath', d.DestPath, { mono: true, placeholder: motor.id === 'local' ? 'E:\\Espelho\\Dados' : '/backups/dados', tip: 'No destino, a subpasta é criada se não existir.' })
        + (motor.credentials
          ? '<div class="field-row">'
            + sf('Host', 'Host', d.Host, { mono: true, tip: 'Servidor que hospeda o destino.' })
            + sf('Porta', 'Port', d.Port, { type: 'number', mono: true, hint: motor.defaultPort ? 'padrão do motor: ' + motor.defaultPort : '' })
            + '</div><div class="field-row">'
            + sf('Usuário', 'User', d.User, { mono: true })
            + sf('Senha', 'Password', '', { type: 'password', hint: syncRascunho.id ? 'em branco mantém a senha atual' : 'nunca é devolvida pela API' })
            + '</div>'
          : '')
        + '<div class="row-gap wiz-actions-inline"><button class="btn-secondary-sm" type="button" data-sync-conn>Testar conexão</button>'
        + '<span class="wiz-status" id="sync-conn">' + (syncRascunho.conn || '') + '</span></div>'
        + sfs('Modo de cópia', 'Mode', d.Mode || 'incremental', [['incremental', 'incremental — só o que mudou'], ['full', 'completo — tudo, sempre']], { tip: 'Incremental compara data e tamanho; completo reenvia tudo a cada execução.' })
        + '<label class="check-row"><input type="checkbox" data-sf="Mirror"' + (d.Mirror !== false ? ' checked' : '') + '>'
        + '<span>Espelhar (mirror)<span class="check-hint">Apaga do destino o que não existe mais na origem. É a diferença entre sincronizar e arquivar.</span></span></label>'
        + sf('Exclusões', 'Excludes', (d.Excludes || []).join(', '), { mono: true, hint: 'padrões separados por vírgula, por exemplo *.tmp, cache', tip: 'Arquivos cujo nome casa com um padrão não entram na cópia nem na retenção.' })
        + sf('Descrição', 'Description', d.Description);
    }

    if (syncRascunho.step === 1) {
      const podeLer = can('sync');
      const acoes = '<div class="row-gap wiz-actions-inline">'
        + (podeLer ? '<button class="btn-secondary-sm" type="button" data-sync-analyze>Analisar origem</button>'
          + '<button class="btn-secondary-sm" type="button" data-sync-preview>Prever exclusões</button>'
          + '<button class="btn-secondary-sm" type="button" data-sync-plan>Simular</button>' : '')
        + '<span class="wiz-status" id="sync-analysis-status"></span></div>'
        + (podeLer ? '' : '<p class="wiz-tip wiz-tip-warn">A análise, a previsão e a simulação são as rotas de leitura do sincronismo: quem não tem <b>sync:view</b> não as tem, e o painel não as chama.</p>');

      return '<label class="check-row"><input type="checkbox" data-sf="Retention.Enabled"' + (r.Enabled ? ' checked' : '') + '>'
        + '<span>Ligar retenção no destino<span class="check-hint">A política só roda depois que a cópia termina, e nunca apaga o que a origem ainda tem.</span></span></label>'
        + (r.Enabled ? blocoPolitica(r) + acoes
          + '<div class="wiz-result" id="sync-analysis">' + (syncRascunho.analysis || '') + '</div>'
          + '<div class="wiz-result" id="sync-preview">' + (syncRascunho.preview || '') + '</div>'
          + '<div class="wiz-result" id="sync-sim">' + (syncRascunho.sim || '') + '</div>'
          : '<p class="wiz-tip">A política está desligada: o destino só cresce. Ligue para o passo liberar a análise e a previsão.</p>');
    }

    return sf('Expressão cron', 'CronExpression', d.CronExpression, { mono: true, placeholder: '0 3 * * *', tip: 'Cinco campos. Vazio significa que o perfil não tem hora: só roda na mão.' })
      + cronChips()
      + '<label class="check-row"><input type="checkbox" data-sf="WatchEnabled"' + (d.WatchEnabled ? ' checked' : '') + '>'
      + '<span>Vigiar a pasta de origem<span class="check-hint">Dispara o sincronismo pouco depois de uma mudança local. Só funciona com o serviço ligado.</span></span></label>'
      + (d.WatchEnabled ? sf('Atraso do vigia (ms)', 'WatchDebounceMs', d.WatchDebounceMs || 1500, { type: 'number', min: 250, tip: 'Espera antes de copiar, para não rodar uma vez por arquivo salvo.' }) : '')
      + '<label class="check-row"><input type="checkbox" data-sf="Enabled"' + (d.Enabled !== false ? ' checked' : '') + '>'
      + '<span>Perfil ativo<span class="check-hint">Desligado, o agendador ignora este perfil.</span></span></label>'
      + '<div class="wiz-summary" id="sync-summary">' + resumoSync() + '</div>';
  }

  /** O mesmo bloco de política nas duas telas: o motor é um só. */
  function blocoPolitica(r) {
    const texturas = formatosDe(r);
    const criterios = [
      r.ByAge && r.KeepDays > 0, r.ByCount && r.KeepCount > 0, r.BySize && r.FreeGb > 0,
      r.ByWeekly && r.WeeklyKeepWeeks > 0, r.ByBiweekly && r.BiweeklyKeepPeriods > 0, r.ByMonthly && r.MonthlyKeepMonths > 0,
    ].filter(Boolean).length;

    return (criterios ? '' : '<p class="wiz-tip wiz-tip-warn">Nenhum critério marcado: o servidor recusa uma política ativa sem regra. Marque ao menos um.</p>')
      + sfs('Data do snapshot', 'Retention.DateSource', r.DateSource || 'metadata', [
        ['metadata', 'data de modificação do arquivo'], ['names', 'data no nome do arquivo'],
      ], { tip: 'Quando o nome tem data (2026-09-20-db.7z), ela vale; senão vale a data de modificação.' })
      + sfRegra('Retention.ByAge', r.ByAge, 'Apagar por idade', { chave: 'Retention.KeepDays', valor: r.KeepDays == null ? 30 : r.KeepDays, min: 1, unidade: 'dias' })
      + sfRegra('Retention.ByCount', r.ByCount, 'Manter no máximo', { chave: 'Retention.KeepCount', valor: r.KeepCount == null ? 10 : r.KeepCount, min: 1, unidade: 'cópias' })
      + sfRegra('Retention.BySize', r.BySize, 'Apagar até sobrar', { chave: 'Retention.FreeGb', valor: r.FreeGb == null ? 10 : r.FreeGb, min: 0, unidade: 'GB livres' })
      + sfRegra('Retention.ByWeekly', r.ByWeekly, 'Guardar histórico semanal', { chave: 'Retention.WeeklyKeepWeeks', valor: r.WeeklyKeepWeeks == null ? 8 : r.WeeklyKeepWeeks, min: 1, unidade: 'semanas' })
      + sfRegra('Retention.ByBiweekly', r.ByBiweekly, 'Guardar histórico quinzenal', { chave: 'Retention.BiweeklyKeepPeriods', valor: r.BiweeklyKeepPeriods == null ? 12 : r.BiweeklyKeepPeriods, min: 1, unidade: 'quinzenos' })
      + sfRegra('Retention.ByMonthly', r.ByMonthly, 'Guardar histórico mensal', { chave: 'Retention.MonthlyKeepMonths', valor: r.MonthlyKeepMonths == null ? 12 : r.MonthlyKeepMonths, min: 1, unidade: 'meses' })
      + sf('Mínimo preservado', 'Retention.MinKeep', r.MinKeep == null ? 3 : r.MinKeep, { type: 'number', min: 0, tip: 'Nenhuma regra apaga abaixo deste número de cópias.', hint: 'rede de segurança contra política demais agressiva' })
      + sf('Formatos', 'Retention.Formats', texturas.join(' '), { mono: true, placeholder: '.7z .zip', hint: 'em branco = todos os formatos · padrão do motor: .7z .zip', tip: 'A retenção só gerencia estes formatos. Lista vazia significa todos.' });
  }

  function resumoSync() {
    const d = syncRascunho.data;
    const linhas = [
      ['Nome', d.Name || '—'],
      ['Origem', d.SourcePath || '—'],
      ['Destino', destinoDe(d)],
      ['Retenção', politicaResumo(d.Retention)],
      ['Cron', d.CronExpression || '— (só na mão)'],
      ['Estado', d.Enabled !== false ? 'ativo' : 'desligado'],
    ];
    return linhas.map(([k, v]) => '<div class="detail-row"><span>' + esc(k) + '</span><b class="mono">' + esc(v) + '</b></div>').join('');
  }

  function renderSyncModal() {
    if (!syncRascunho) return;
    const s = syncRascunho;
    const acoes = '<button class="btn-ghost" data-modal-close>Cancelar</button>'
      + (s.step < SYNC_PASSOS.length - 1
        ? '<button class="btn-ghost" type="button" data-sync-step-next>Próximo passo</button>'
        : '<button class="btn-primary" type="button" data-save-sync="' + esc(s.id || '') + '">Salvar perfil</button>')
      + (s.step > 0 ? '<button class="btn-ghost" type="button" data-sync-step-prev>Voltar</button>' : '');
    modalPassos(s.id ? 'Editar perfil de sincronismo' : 'Novo perfil de sincronismo',
      SYNC_PASSOS, s.step, 'sync', syncPassoAtual(), acoes);
  }

  // ─── As três leituras: analisar, prever, simular ───
  //
  // As três devolvem 200 com o resultado em data, mesmo quando deu errado
  // (pasta vazia, política sem regra): quem tem que ler o erro é a tela, e
  // não o status HTTP.

  async function syncAguarda(botao, hostId, fn) {
    const s = syncRascunho;
    if (!s || s.ocupado) return;
    s.ocupado = true;
    botao.disabled = true;
    const status = $('sync-analysis-status');
    if (status) status.textContent = 'lendo o disco…';
    try {
      await fn();
    } catch (err) {
      const alvo = $(hostId);
      if (alvo) alvo.innerHTML = '<div class="alert alert-error">' + esc(falhaDeTela(err)) + '</div>';
    } finally {
      s.ocupado = false;
      botao.disabled = false;
      const st = $('sync-analysis-status');
      if (st) st.textContent = '';
    }
  }

  function syncAnalyze(botao) {
    const dir = (syncRascunho.data.SourcePath || '').trim();
    if (!dir) { toast('Informe a pasta de origem para analisar', 'error'); return; }
    const r = syncRascunho.data.Retention || {};
    syncAguarda(botao, 'sync-analysis', async () => {
      const res = await api('/api/sync/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dir,
          useNames: (r.DateSource || 'metadata') === 'names',
          useMetadata: (r.DateSource || 'metadata') !== 'names',
          extensions: formatosDe(r),
        }),
      });
      const alvo = $('sync-analysis');
      if (alvo) alvo.innerHTML = renderAnalise(res.data || {});
    });
  }

  function renderAnalise(d) {
    if (!d.ok) return '<div class="alert alert-warn">Análise não concluída: ' + esc(d.error || 'sem detalhe') + '</div>';
    const pastas = d.folders || [];
    const padrao = { 'dated-folders': 'pastas com data no nome', 'dated-files': 'data no nome do arquivo', mixed: 'pastas e arquivos com data', flat: 'sem padrão de data', empty: 'pasta vazia' };
    const numeros = [
      ['arquivos', d.totalFiles],
      ['tamanho', bytes(d.totalBytes)],
      ['com data', Math.round((d.dateIsh || 0) * 100) + '%'],
      ['intervalo mediano', d.medianGapDays ? d.medianGapDays + ' dias' : '—'],
    ];
    return '<div class="wiz-box"><div class="wiz-numbers">' + numeros.map(([k, v]) =>
      '<div><b>' + esc(v) + '</b><span>' + esc(k) + '</span></div>').join('') + '</div>'
      + '<p class="wiz-tip">' + esc(padrao[d.folderPattern] || d.folderPattern || '—')
      + (d.grouping === 'folders' ? ' · ' + pastas.length + ' arquivo(s) separado(s) por subpasta' : '') + '</p>'
      + (pastas.length ? '<div class="wiz-lista">' + pastas.map((f, i) => {
        const sug = f.suggested || {};
        return '<div class="wiz-item"><div class="wiz-item-main"><b class="mono">' + esc(f.rel || '(raiz da pasta)') + '</b>'
          + '<span>' + f.totalFiles + ' arquivo(s) · ' + bytes(f.totalBytes) + ' · ' + esc(padrao[f.folderPattern] || f.folderPattern || '—') + '</span></div>'
          + (sug.Enabled ? '<button class="btn-secondary-sm" type="button" data-sync-suggest="' + i + '">Usar sugestão</button>' : '')
          + '</div>';
      }).join('') + '</div>' : '')
      + '<p class="wiz-tip">Sugestão do conjunto: ' + esc(politicaResumo(d.suggested || {}, false)) + '</p></div>';
  }

  function syncPreview(botao) {
    const dir = (syncRascunho.data.DestPath || '').trim();
    if (!dir) { toast('Informe a pasta de destino para prever as exclusões', 'error'); return; }
    const r = syncRascunho.data.Retention || {};
    syncAguarda(botao, 'sync-preview', async () => {
      const res = await api('/api/sync/retention/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, Retention: r }),
      });
      const alvo = $('sync-preview');
      if (alvo) alvo.innerHTML = renderPreview(res.data || {});
    });
  }

  function renderPreview(d) {
    if (!d.ok) return '<div class="alert alert-warn">Previsão não concluída: ' + esc(d.error || 'sem detalhe') + '</div>';
    const apagar = d.delete || [];
    const mantidos = d.kept || [];
    const numeros = [
      ['no destino', d.totalFiles],
      ['a apagar', apagar.length + ' · ' + bytes(d.deleteBytes)],
      ['preservados', mantidos.length],
      ['cópias', d.totalSnapshots],
    ];
    const regras = (d.rules || []).map((r) => r.type + (r.kind === 'keep' ? ' (guardar)' : ' (apagar)')
      + (r.days ? ' ' + r.days + 'd' : r.keep ? ' ' + r.keep : r.freeBytes ? ' ' + gb(r.freeBytes) : r.periods ? ' ' + r.periods : ''));
    // A lista de formatos só aparece quando a resposta traz uma: dizer
    // ".7z .zip" para uma previsão que não filtrou nada seria inventar filtro.
    const texturas = Array.isArray(d.extensions) ? (d.extensions.length ? d.extensions.join(' ') : 'todos os formatos') : '—';
    return '<div class="wiz-box"><div class="wiz-numbers">' + numeros.map(([k, v]) =>
      '<div><b>' + esc(v) + '</b><span>' + esc(k) + '</span></div>').join('') + '</div>'
      + '<p class="wiz-tip">regras: ' + esc(regras.join(' · ') || 'nenhuma') + ' · mínimo ' + (d.minKeep || 0)
      + ' · datas por ' + (d.dateSource === 'names' ? 'nome' : 'modificação')
      + ' · formatos: ' + esc(texturas) + '</p>'
      + ((d.folders || []).length ? '<div class="wiz-lista">' + d.folders.map((f) =>
        '<div class="wiz-item"><div class="wiz-item-main"><b class="mono">' + esc(f.rel || '(raiz da pasta)') + '</b>'
        + '<span>' + f.totalSnapshots + ' cópia(s) · ' + f.delete + ' a apagar · ' + f.kept + ' preservado(s)</span></div></div>').join('') + '</div>' : '')
      + (apagar.length ? '<details class="wiz-details"><summary>ver os ' + apagar.length + ' arquivo(s) que sairiam</summary><div class="wiz-lista">'
        + apagar.slice(0, 60).map((x) => '<div class="wiz-item"><div class="wiz-item-main"><b class="mono">' + esc(x.rel)
          + '</b><span>' + esc(x.reason || '') + (x.detail ? ' · ' + esc(x.detail) : '') + '</span></div></div>').join('')
        + '</div>' + (apagar.length > 60 ? '<p class="wiz-tip">e mais ' + (apagar.length - 60) + '</p>' : '') + '</details>' : '')
      + '<p class="wiz-tip">Previsão: nada foi apagado. Quem apaga é a execução do perfil.</p></div>';
  }

  function syncSimular(botao) {
    const d = syncRascunho.data;
    if (!(d.SourcePath || '').trim() || !(d.DestPath || '').trim()) {
      toast('Simulação precisa de origem e destino preenchidos', 'error');
      return;
    }
    syncAguarda(botao, 'sync-sim', async () => {
      const res = await api('/api/sync/plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // O rascunho vai inteiro, inclusive a senha digitada: a rota simula
        // pelas mesmas regras que vão valer na execução - e não devolve nada
        // disso na resposta.
        body: JSON.stringify({ draft: rascunhoDeEnvio(d) }),
      });
      const alvo = $('sync-sim');
      if (alvo) alvo.innerHTML = renderSim(res.data || {});
    });
  }

  function renderSim(d) {
    if (!d.ok) return '<div class="alert alert-warn">Simulação não concluída: ' + esc(d.error || 'sem detalhe') + '</div>';
    const copia = d.copy || [];
    const apaga = d.delete || [];
    const pula = d.skipped || [];
    const ret = d.retention || [];
    const numeros = [
      ['na origem', d.totalSource + ' · ' + bytes(d.totalBytes)],
      ['a copiar', copia.length],
      ['a apagar no destino', apaga.length],
      ['inalterados', pula.length],
      ['retensão apaga', ret.length + ' · ' + bytes(d.retentionDeletedBytes)],
    ];
    const grupos = [
      ['seriam copiados', copia], ['seriam apagados', apaga], ['ficariam como estão', pula], ['a retenção tiraria', ret],
    ];
    return '<div class="wiz-box"><div class="wiz-numbers">' + numeros.map(([k, v]) =>
      '<div><b>' + esc(v) + '</b><span>' + esc(k) + '</span></div>').join('') + '</div>'
      + grupos.filter(([, itens]) => itens.length).map(([rotulo, itens]) =>
        '<details class="wiz-details"><summary>' + esc(rotulo) + ' (' + itens.length + ')</summary><div class="wiz-lista">'
        + itens.slice(0, 60).map((x) => '<div class="wiz-item"><div class="wiz-item-main"><b class="mono">' + esc(x.rel)
          + '</b><span>' + esc(x.reason || '') + ' · ' + bytes(x.size) + '</span></div></div>').join('')
        + '</div>' + (itens.length > 60 ? '<p class="wiz-tip">e mais ' + (itens.length - 60) + '</p>' : '') + '</details>').join('')
      + '<p class="wiz-tip">Simulação: a origem e o destino não foram tocados.</p></div>';
  }

  async function syncTestarConexao(botao) {
    const d = syncRascunho.data;
    if (!can('sync')) return;
    botao.disabled = true;
    const status = $('sync-conn');
    if (status) status.textContent = 'conectando…';
    const corpo = rascunhoDeEnvio(d);
    // A senha em branco no PUT significa "não mexer"; para o teste com um perfil
    // salvo, o corpo manda só o que mudou e o servidor completa com a senha.
    if (!corpo.Password) delete corpo.Password;
    try {
      const res = await api('/api/sync/test-connection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, syncRascunho.id ? { profileId: syncRascunho.id } : {}, corpo)),
      });
      const r = res.data || {};
      const txt = r.success ? 'conexão ok' : ('falhou: ' + (r.message || 'sem detalhe'));
      syncRascunho.conn = '<span class="' + (r.success ? 'ok' : 'bad') + '">' + esc(txt) + '</span>';
    } catch (err) {
      syncRascunho.conn = '<span class="bad">' + esc(falhaDeTela(err)) + '</span>';
    }
    if (syncRascunho) renderSyncModal();
  }

  /** O rascunho no formato que a API espera: policy no corpo, formatos como lista. */
  function rascunhoDeEnvio(d) {
    const r = Object.assign({}, d.Retention || {});
    const formatos = String(r.Formats || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    delete r.Formats;
    r.FileExtensions = formatos;
    r.Extensions = formatos;
    const out = Object.assign({}, d, { Retention: r });
    delete out.Password;
    return out;
  }

  async function saveSync(id, botao) {
    const d = syncRascunho.data;
    if (!String(d.Name || '').trim()) { toast('Nome é obrigatório', 'error'); return; }
    if (!(d.SourcePath || '').trim() || !(d.DestPath || '').trim()) { toast('Origem e destino são obrigatórios', 'error'); return; }
    const corpo = rascunhoDeEnvio(d);
    if (d.Password) corpo.Password = d.Password;      // vazio = não mexer, no servidor
    if (d.Port !== '' && d.Port != null) corpo.Port = Number(d.Port) || null;

    botao.disabled = true;
    try {
      const res = await api(id ? '/api/sync/' + encodeURIComponent(id) : '/api/sync', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      syncRascunho = null;
      closeModal();
      toast(res.success ? (id ? 'Perfil de sincronismo atualizado' : 'Perfil de sincronismo criado') : 'O servidor recusou a gravação', res.success ? 'success' : 'error');
      loadSync();
    } catch (err) {
      toast('Erro: ' + err.message, 'error');
      botao.disabled = false;
    }
  }

  // ─── Retenção: abrir, passos, salvar ───

  async function retentionDialog(id) {
    let base = { Name: '', Description: '', FolderPath: '', CronExpression: '0 4 * * *', Enabled: true, Retention: POLITICA_PADRAO() };
    if (id) {
      try {
        base = Object.assign(base, (await api('/api/retention/' + encodeURIComponent(id))).data);
        base.Retention = Object.assign(POLITICA_PADRAO(), base.Retention || {});
        base.Retention.Formats = formatosDe(base.Retention).join(' ');
      } catch (err) { toast('Erro ao abrir a agenda: ' + err.message, 'error'); return; }
    }
    retRascunho = { id: id || null, step: 0, data: base, analysis: null, preview: null, ocupado: false, render: renderRetentionModal };
    renderRetentionModal();
  }

  function resumoRet() {
    const d = retRascunho.data;
    return [
      ['Nome', d.Name || '—'], ['Pasta', d.FolderPath || '—'],
      ['Política', politicaResumo(d.Retention)], ['Cron', d.CronExpression || '—'],
    ].map(([k, v]) => '<div class="detail-row"><span>' + esc(k) + '</span><b class="mono">' + esc(v) + '</b></div>').join('');
  }

  function retentionPassoAtual() {
    const d = retRascunho.data;
    const r = d.Retention || {};
    // A análise e a previsão moram nas rotas do sincronismo (sync:view). Sem
    // esse escopo o painel não as chama - e diz qual escopo falta.
    const podeLer = can('sync');

    if (retRascunho.step === 0) {
      return sf('Nome', 'Name', d.Name, { required: true, tip: 'Como a agenda aparece na lista e no log de auditoria.' })
        + sf('Pasta', 'FolderPath', d.FolderPath, { mono: true, placeholder: 'D:\\Backups\\Producao', tip: 'Caminho absoluto, no servidor. A pasta precisa existir: o servidor recusa o cadastro se não encontrar.', hint: 'exatamente a pasta cujas cópias velhas serão apagadas' })
        + sf('Descrição', 'Description', d.Description)
        + '<div class="wiz-summary" id="ret-summary">' + resumoRet() + '</div>';
    }

    return '<label class="check-row"><input type="checkbox" data-sf="Retention.Enabled"' + (r.Enabled ? ' checked' : '') + '>'
      + '<span>Política ligada<span class="check-hint">Desligada, a agenda é um registro sem efeito: nada é apagado.</span></span></label>'
      + (r.Enabled ? blocoPolitica(r) : '<p class="wiz-tip">A política está desligada: o passo de análise e de previsão fica escondido.</p>')
      + sf('Expressão cron', 'CronExpression', d.CronExpression, { mono: true, placeholder: '0 4 * * *', tip: 'Cinco campos. Vazio deixa a agenda parada, sem hora marcada.' })
      + cronChips()
      + '<label class="check-row"><input type="checkbox" data-sf="Enabled"' + (d.Enabled !== false ? ' checked' : '') + '>'
      + '<span>Agenda ativa<span class="check-hint">Desligada, o agendador pula esta pasta.</span></span></label>'
      + (r.Enabled
        ? '<div class="row-gap wiz-actions-inline">'
          + (podeLer
            ? '<button class="btn-secondary-sm" type="button" data-ret-analyze>Analisar pasta</button>'
              + '<button class="btn-secondary-sm" type="button" data-ret-preview>Prever exclusões</button>'
            : '')
          + '<span class="wiz-status" id="ret-analysis-status"></span></div>'
          + (podeLer ? '' : '<p class="wiz-tip wiz-tip-warn">A análise e a previsão são as rotas de leitura do sincronismo: quem não tem <b>sync:view</b> não as tem, e o painel não as chama.</p>')
          + '<div class="wiz-result" id="ret-analysis">' + (retRascunho.analysis || '') + '</div>'
          + '<div class="wiz-result" id="ret-preview">' + (retRascunho.preview || '') + '</div>'
        : '');
  }

  function renderRetentionModal() {
    if (!retRascunho) return;
    const r = retRascunho;
    const acoes = '<button class="btn-ghost" data-modal-close>Cancelar</button>'
      + (r.step < RET_PASSOS.length - 1
        ? '<button class="btn-ghost" type="button" data-ret-step-next>Próximo passo</button>'
        : '<button class="btn-primary" type="button" data-save-ret="' + esc(r.id || '') + '">Salvar agenda</button>')
      + (r.step > 0 ? '<button class="btn-ghost" type="button" data-ret-step-prev>Voltar</button>' : '');
    modalPassos(r.id ? 'Editar agenda de retenção' : 'Nova agenda de retenção',
      RET_PASSOS, r.step, 'ret', retentionPassoAtual(), acoes);
  }

  async function retAguarda(botao, hostId, fn) {
    const r = retRascunho;
    if (!r || r.ocupado) return;
    r.ocupado = true;
    botao.disabled = true;
    const status = $('ret-analysis-status');
    if (status) status.textContent = 'lendo o disco…';
    try {
      await fn();
    } catch (err) {
      const alvo = $(hostId);
      if (alvo) alvo.innerHTML = '<div class="alert alert-error">' + esc(falhaDeTela(err)) + '</div>';
    } finally {
      r.ocupado = false;
      botao.disabled = false;
      const st = $('ret-analysis-status');
      if (st) st.textContent = '';
    }
  }

  function retentionAnalyze(botao) {
    const dir = (retRascunho.data.FolderPath || '').trim();
    if (!dir) { toast('Informe a pasta para analisar', 'error'); return; }
    const r = retRascunho.data.Retention || {};
    retAguarda(botao, 'ret-analysis', async () => {
      const res = await api('/api/sync/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dir,
          useNames: (r.DateSource || 'metadata') === 'names',
          useMetadata: (r.DateSource || 'metadata') !== 'names',
          extensions: formatosDe(r),
        }),
      });
      const alvo = $('ret-analysis');
      if (alvo) alvo.innerHTML = renderAnalise(res.data || {});
    });
  }

  function retentionPreview(botao) {
    const dir = (retRascunho.data.FolderPath || '').trim();
    if (!dir) { toast('Informe a pasta para prever as exclusões', 'error'); return; }
    const r = retRascunho.data.Retention || {};
    retAguarda(botao, 'ret-preview', async () => {
      const res = await api('/api/sync/retention/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir, Retention: r }),
      });
      const alvo = $('ret-preview');
      if (alvo) alvo.innerHTML = renderPreview(res.data || {});
    });
  }

  async function saveRetention(id, botao) {
    const d = retRascunho.data;
    if (!String(d.Name || '').trim()) { toast('Nome é obrigatório', 'error'); return; }
    if (!(d.FolderPath || '').trim()) { toast('A pasta é obrigatória', 'error'); return; }
    const corpo = rascunhoDeEnvio(d);
    if (!(corpo.CronExpression || '').trim()) { toast('Informe a expressão cron da agenda', 'error'); return; }

    botao.disabled = true;
    try {
      const res = await api(id ? '/api/retention/' + encodeURIComponent(id) : '/api/retention', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      retRascunho = null;
      closeModal();
      toast(res.success ? (id ? 'Agenda atualizada' : 'Agenda criada') : 'O servidor recusou a gravação', res.success ? 'success' : 'error');
      loadRetention();
    } catch (err) {
      toast('Erro: ' + err.message, 'error');
      botao.disabled = false;
    }
  }

  // ─── Ligação do modal: campos, passos e as leituras ───
  //
  // Um listener só para o rascunho: os campos escrevem nele pelo atributo
  // data-sf e o corpo do modal é redesenhado a cada passo, então nada pode
  // ficar preso a um elemento que já saiu do DOM.
  function rascunhoDoCampo(evento) {
    const el = evento.target.closest('[data-sf]');
    if (!el) return;
    const dono = rascunhoAberto();
    if (!dono) return;
    const chave = el.getAttribute('data-sf');
    noRascunho(dono, chave, el.type === 'checkbox' ? el.checked
      : el.type === 'number' ? (el.value === '' ? null : Number(el.value))
      : el.value);

    // Só três chave mudam o desenho do passo - as outras atualizam o resumo
    // sem tirar o cursor de quem está digitando.
    if (chave === 'Engine' || chave === 'Retention.Enabled' || chave === 'WatchEnabled') dono.render();
    else atualizarResumo();
  }

  document.addEventListener('input', rascunhoDoCampo);
  document.addEventListener('change', rascunhoDoCampo);

  function atualizarResumo() {
    const s = $('sync-summary');
    if (s && syncRascunho) s.innerHTML = resumoSync();
    const r = $('ret-summary');
    if (r && retRascunho) r.innerHTML = resumoRet();
  }

  /** A sugestão da análise vira política, campo a campo. */
  function aplicarSugestao(indice) {
    const s = syncRascunho;
    if (!s || !s.analysis || !s.analysis.folders) return;
    const pasta = s.analysis.folders[indice];
    if (!pasta) return;
    const sug = pasta.suggested || {};
    const r = s.data.Retention;
    r.Enabled = sug.Enabled !== false;
    r.ByAge = !!sug.ByAge; if (sug.ByAge) r.KeepDays = sug.KeepDays;
    r.ByCount = !!sug.ByCount; if (sug.ByCount) r.KeepCount = sug.KeepCount;
    r.BySize = !!sug.BySize; if (sug.BySize) r.FreeGb = sug.FreeGb;
    r.ByMonthly = !!sug.ByMonthly;
    r.MinKeep = sug.MinKeep == null ? r.MinKeep : sug.MinKeep;
    renderSyncModal();
    toast('Sugestão de "' + (pasta.rel || 'raiz da pasta') + '" aplicada ao rascunho — ainda não salva', 'info');
  }

  document.addEventListener('click', async (ev) => {
    const chip = ev.target.closest('[data-sf-cron]');
    if (chip && rascunhoAberto()) {
      const expr = chip.getAttribute('data-sf-cron');
      noRascunho(rascunhoAberto(), 'CronExpression', expr);
      (rascunhoAberto().render)();
      return;
    }

    const passo = ev.target.closest('[data-sync-step],[data-sync-step-next],[data-sync-step-prev]');
    if (passo && syncRascunho) {
      if (passo.hasAttribute('data-sync-step-next')) syncRascunho.step = Math.min(SYNC_PASSOS.length - 1, syncRascunho.step + 1);
      else if (passo.hasAttribute('data-sync-step-prev')) syncRascunho.step = Math.max(0, syncRascunho.step - 1);
      else syncRascunho.step = Number(passo.getAttribute('data-sync-step')) || 0;
      renderSyncModal();
      return;
    }

    const passoRet = ev.target.closest('[data-ret-step],[data-ret-step-next],[data-ret-step-prev]');
    if (passoRet && retRascunho) {
      if (passoRet.hasAttribute('data-ret-step-next')) retRascunho.step = Math.min(RET_PASSOS.length - 1, retRascunho.step + 1);
      else if (passoRet.hasAttribute('data-ret-step-prev')) retRascunho.step = Math.max(0, retRascunho.step - 1);
      else retRascunho.step = Number(passoRet.getAttribute('data-ret-step')) || 0;
      renderRetentionModal();
      return;
    }

    const sugestao = ev.target.closest('[data-sync-suggest]');
    if (sugestao) { aplicarSugestao(Number(sugestao.getAttribute('data-sync-suggest'))); return; }

    if (ev.target.closest('[data-sync-analyze]')) return syncAnalyze(ev.target.closest('button'));
    if (ev.target.closest('[data-sync-preview]')) return syncPreview(ev.target.closest('button'));
    if (ev.target.closest('[data-sync-plan]')) return syncSimular(ev.target.closest('button'));
    if (ev.target.closest('[data-sync-conn]')) return syncTestarConexao(ev.target.closest('button'));
    if (ev.target.closest('[data-ret-analyze]')) return retentionAnalyze(ev.target.closest('button'));
    if (ev.target.closest('[data-ret-preview]')) return retentionPreview(ev.target.closest('button'));

    const saveSyncBtn = ev.target.closest('[data-save-sync]');
    if (saveSyncBtn) { saveSync(saveSyncBtn.getAttribute('data-save-sync') || null, saveSyncBtn); return; }
    const saveRetBtn = ev.target.closest('[data-save-ret]');
    if (saveRetBtn) { saveRetention(saveRetBtn.getAttribute('data-save-ret') || null, saveRetBtn); return; }

    if (ev.target.closest('#btn-new-sync')) return syncDialog(null);
    if (ev.target.closest('#btn-new-retention')) return retentionDialog(null);

    const editar = ev.target.closest('[data-edit-sync]');
    if (editar) return syncDialog(editar.getAttribute('data-edit-sync'));
    const editarRet = ev.target.closest('[data-edit-ret]');
    if (editarRet) return retentionDialog(editarRet.getAttribute('data-edit-ret'));
    const rodar = ev.target.closest('[data-runsync]');
    if (rodar) return runSync(rodar.getAttribute('data-runsync'), rodar);
    const rodarRet = ev.target.closest('[data-runret]');
    if (rodarRet) return runRetention(rodarRet.getAttribute('data-runret'), rodarRet);

    const daemon = ev.target.closest('[data-net-daemon]');
    if (daemon) return acaoDaemon(daemon.getAttribute('data-net-daemon'), daemon);
    const liberar = ev.target.closest('[data-net-allow]');
    if (liberar) return api('/api/network/devices/' + encodeURIComponent(liberar.getAttribute('data-net-allow')) + '/authorize', {
      method: 'POST', body: '{}',
    }).then(loadNetwork).catch(() => loadNetwork());
    const revogar = ev.target.closest('[data-net-revoke]');
    if (revogar) return api('/api/network/devices/' + encodeURIComponent(revogar.getAttribute('data-net-revoke')) + '/authorize', {
      method: 'DELETE',
    }).then(loadNetwork).catch(() => loadNetwork());
    const apagar = ev.target.closest('[data-delsync]');
    if (apagar) {
      const nome = apagar.getAttribute('data-name') || '';
      if (!confirm('Excluir o perfil de sincronismo "' + nome + '"?')) return;
      try {
        const res = await api('/api/sync/' + encodeURIComponent(apagar.getAttribute('data-delsync')), { method: 'DELETE' });
        toast(res.success ? 'Perfil excluído' : 'O servidor recusou a exclusão', res.success ? 'success' : 'error');
        loadSync();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
      return;
    }
    const apagarRet = ev.target.closest('[data-delret]');
    if (apagarRet) {
      const nome = apagarRet.getAttribute('data-name') || '';
      if (!confirm('Excluir a agenda de retenção "' + nome + '"?')) return;
      try {
        const res = await api('/api/retention/' + encodeURIComponent(apagarRet.getAttribute('data-delret')), { method: 'DELETE' });
        toast(res.success ? 'Agenda excluída' : 'O servidor recusou a exclusão', res.success ? 'success' : 'error');
        loadRetention();
      } catch (err) { toast('Erro: ' + err.message, 'error'); }
    }
  });

  /**
   * Executar devolve 200 mesmo quando o motor falha: quem tem que ler o erro é
   * a tela, olhando data.success / data.ok - não o status HTTP.
   */
  async function runSync(id, botao) {
    botao.disabled = true;
    toast('Sincronismo iniciado…', 'info');
    try {
      const res = await api('/api/sync/' + encodeURIComponent(id) + '/run', { method: 'POST' });
      const d = res.data || {};
      const resultados = d.results || [];
      const copiados = resultados.filter((r) => r.op === 'copy' && r.success).length;
      const removidos = resultados.filter((r) => r.op === 'delete' && r.success).length;
      const falhas = resultados.filter((r) => !r.success).length;
      const ret = d.retention || {};
      const linhas = [
        ['Resultado', d.success ? 'sucesso' : 'falhou'],
        ['Planejados', d.planned == null ? '—' : d.planned],
        ['Copiados', copiados],
        ['Removidos no destino', removidos],
        ['Falhas', falhas],
        ['Retenção', ret.ok === undefined ? '—' : (ret.ok ? (ret.deleted || 0) + ' arquivo(s) antigo(s)' : (ret.error || 'não rodou'))],
        ['Duração', d.duration == null ? '—' : d.duration],
        ['Mensagem', d.message || (d.success ? 'Sincronismo concluído' : '—')],
      ];
      modal(d.success ? 'Sincronismo concluído' : 'Sincronismo falhou',
        '<div class="detail-grid">' + linhas.map(([k, v]) =>
          '<div class="detail-row"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '</div>'
        + (falhas ? '<p class="wiz-tip wiz-tip-warn">' + falhas + ' operação(ões) falharam. O log de auditoria tem o detalhe de cada arquivo.</p>' : ''),
        '<button class="btn-ghost" data-modal-close>Fechar</button>');
      toast(d.success ? 'Sincronismo concluído' : 'Sincronismo falhou: ' + (d.message || ''), d.success ? 'success' : 'error');
    } catch (err) {
      toast('Erro: ' + err.message, 'error');
    } finally {
      botao.disabled = false;
    }
    loadSync();
  }

  async function runRetention(id, botao) {
    botao.disabled = true;
    toast('Retenção em andamento…', 'info');
    try {
      const res = await api('/api/retention/' + encodeURIComponent(id) + '/run', { method: 'POST' });
      const d = res.data || {};
      const linhas = [
        ['Resultado', d.ok ? 'sucesso' : 'falhou'],
        ['Planejados', d.planned == null ? '—' : d.planned],
        ['Apagados', d.deleted == null ? '—' : d.deleted],
        ['Espaço liberado', d.freed == null ? '—' : bytes(d.freed)],
        ['Falhas', (d.failed || []).length],
        ['Mensagem', d.error || (d.ok ? 'Retenção concluída' : '—')],
      ];
      modal(d.ok ? 'Retenção concluída' : 'Retenção falhou',
        '<div class="detail-grid">' + linhas.map(([k, v]) =>
          '<div class="detail-row"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '</div>'
        + ((d.folders || []).length ? '<div class="wiz-lista">' + d.folders.map((f) =>
          '<div class="wiz-item"><div class="wiz-item-main"><b class="mono">' + esc(f.rel || '(raiz da pasta)')
          + '</b><span>' + (f.deleted || 0) + ' apagado(s) de ' + (f.planned || 0) + ' planejado(s)</span></div></div>').join('') + '</div>' : '')
        + '<p class="wiz-tip">Cada arquivo apagado sai daqui com autor e IP no log de auditoria.</p>',
        '<button class="btn-ghost" data-modal-close>Fechar</button>');
      toast(d.ok ? 'Retenção concluída' : 'Retenção falhou: ' + (d.error || ''), d.ok ? 'success' : 'error');
    } catch (err) {
      toast('Erro: ' + err.message, 'error');
    } finally {
      botao.disabled = false;
    }
    loadRetention();
  }

  // ─── Serviços ───
  // ═══ REDE DE SINCRONISMO ═══
  // Mesmas rotas do desktop, com os mesmos escopos: sync:view para ler,
  // sync:write para liberar dispositivo e salvar pasta, sync:run para o daemon.
  const FOLDER_TYPES = {
    sendreceive: 'Receber e Enviar', sendonly: 'Enviar',
    receiveonly: 'Receber', receiveencrypted: 'Receber Criptografado',
  };

  async function loadNetwork() {
    const devicesBody = $('net-devices');
    const foldersBody = $('net-folders');
    if (!can('network')) {
      $('net-sub').textContent = 'Sem permissão para ver a rede';
      linhaDeAviso(devicesBody, 5, 'Sem permissão');
      linhaDeAviso(foldersBody, 5, 'Sem permissão');
      return;
    }

    const st = await apiQuiet('/api/network/status');
    if (!st.success) {
      $('net-sub').textContent = falhaDeTela(st);
      $('net-daemon').innerHTML = '<div class="wiz-tip wiz-tip-warn">O daemon não está disponível neste servidor.</div>';
      linhaDeAviso(devicesBody, 5, falhaDeTela(st));
      linhaDeAviso(foldersBody, 5, falhaDeTela(st));
      return;
    }
    const status = st.data || {};
    $('net-sub').textContent = status.running
      ? 'daemon rodando · ' + (status.version ? 'v' + status.version.text : '')
      : (status.installed ? 'daemon parado' : 'Syncthing não instalado');
    desenharBotaoDaemon(status);

    const ov = await apiQuiet('/api/network/overview');
    if (ov.success && ov.data) {
      const v = ov.data;
      $('stat-net-recv').textContent = bytes(v.receive.rate) + '/s';
      $('stat-net-recv-sub').textContent = bytes(v.receive.bytes);
      $('stat-net-send').textContent = bytes(v.send.rate) + '/s';
      $('stat-net-send-sub').textContent = bytes(v.send.bytes);
      $('stat-net-state').textContent = v.localState.files;
      $('stat-net-state-sub').textContent = v.localState.directories + ' · ~' + bytes(v.localState.bytes);
      $('stat-net-listen').textContent = v.listeners.ok + '/' + v.listeners.total;
      $('stat-net-listen-sub').textContent = v.discovery.available
        ? 'descoberta ' + v.discovery.ok + '/' + v.discovery.total
        : 'descoberta —';
    }

    const dev = await apiQuiet('/api/network/devices');
    const lista = (dev.success && dev.data) || [];
    devicesBody.innerHTML = lista.map((d) => '<tr>'
      + '<td><strong>' + esc(d.name || d.deviceID) + '</strong></td>'
      + '<td><code>' + esc(d.deviceID) + '</code></td>'
      + '<td>' + (d.connected ? '<span class="pill pill-ok">conectado</span>' : '<span class="pill">desconectado</span>') + '</td>'
      + '<td>' + (d.authorized
        ? '<span class="pill pill-ok">' + esc(d.githubLogin) + '</span>'
        : '<span class="pill pill-warn">não liberado</span>') + '</td>'
      + '<td>' + (d.authorized
        ? (can('sync', 'write') ? '<button class="btn-danger" data-net-revoke="' + esc(d.deviceID) + '">Remover</button>' : '')
        : (can('network', 'write')
          ? '<button class="btn-secondary-sm" data-net-allow="' + esc(d.deviceID) + '">Liberar</button>'
          : '')) + '</td>'
      + '</tr>').join('')
      || '<tr><td colspan="5" class="tbl-empty">nenhum dispositivo</td></tr>';

    const fol = await apiQuiet('/api/network/folders');
    const pastas = (fol.success && fol.data) || [];
    const bloqueadas = pastas.filter((f) => !f.authorized).length;
    foldersBody.innerHTML = (bloqueadas
      ? '<tr><td colspan="5"><div class="wiz-tip wiz-tip-warn">' + bloqueadas
        + ' pasta(s) compartilham com um dispositivo não liberado aqui.</div></td></tr>'
      : '')
      + pastas.map((f) => '<tr>'
        + '<td><strong>' + esc(f.label || f.id) + '</strong></td>'
        + '<td><code>' + esc(f.id) + '</code></td>'
        + '<td>' + esc(f.path) + '</td>'
        + '<td>' + esc(FOLDER_TYPES[f.type] || f.type) + '</td>'
        + '<td>' + (f.devices || []).length + '</td>'
        + '</tr>').join('')
      || (bloqueadas ? '' : '<tr><td colspan="5" class="tbl-empty">nenhuma pasta compartilhada</td></tr>');
  }

  // Instalar pelo painel é uma mudança no servidor inteiro (Chocolatey, com
  // elevação). O botão fica escondido para quem não tem sync:run e a ação entra
  // pela auditoria com autor e IP.
  function desenharBotaoDaemon(status) {
    const box = $('net-daemon');
    const pode = can('network', 'run');
    let acao = '';
    if (!status.installed && pode) {
      acao = '<button class="btn-primary" data-net-daemon="install">Instalar Syncthing</button>';
    } else if (status.installed && !status.running && pode) {
      acao = '<button class="btn-primary" data-net-daemon="start">Iniciar daemon</button>';
    } else if (status.running && pode) {
      acao = '<button class="btn-secondary-sm" data-net-daemon="stop">Parar daemon</button>';
    }
    box.innerHTML = '<div class="glass-card"><div class="row-gap" style="justify-content:space-between">'
      + '<div><div class="stat-label">Identificação</div><code>' + esc(status.deviceID || '—') + '</code></div>'
      + (acao ? '<div class="row-gap">' + acao + '</div>' : '')
      + '</div></div>';
  }

  async function acaoDaemon(acao, botao) {
    if (!can('network', 'run')) return;
    botao.disabled = true;
    try {
      await api('/api/network/daemon/' + encodeURIComponent(acao), { method: 'POST', body: '{}' });
    } catch (e) { /* falhaDeTela na proxima carga */ }
    await loadNetwork();
  }

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
          + (can('services', 'run') && rodando
            ? '<button class="btn-secondary-sm" data-svc="stop" data-name="' + esc(s.Name) + '">Parar</button>'
            : '')
          + (can('services', 'run') && !rodando
            ? '<button class="btn-secondary-sm" data-svc="start" data-name="' + esc(s.Name) + '">Iniciar</button>'
            : '')
          + (can('services', 'run')
            ? '<button class="btn-secondary-sm" data-svc="restart" data-name="' + esc(s.Name) + '">Reiniciar</button>'
              : '')
          // Só o que o sistema criou: remover um serviço alheio desconfigura a máquina.
          + (s.IsManaged && can('services', 'delete')
            ? '<button class="btn-danger" data-svc-del="' + esc(s.Name) + '">Remover</button>' : '')
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
        + (can('scripts', 'delete') ? '<button class="btn-danger" data-script-del="' + esc(f.name) + '">Excluir</button>' : '')
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
    const activity = target.getAttribute('data-activity');
    const hdetail = target.getAttribute('data-hdetail');

    try {
      if (target.id === 'btn-new-task') return taskDialog(null);
      if (target.id === 'btn-new-backup') return backupDialog(null);
      if (saveTaskId !== null) return saveTask(saveTaskId || null, target);
      if (saveBackupId !== null) return saveBackup(saveBackupId || null, target);
      if (watch) return watchRun(watch);
      // O detalhe vem da linha que já está na tela: o servidor não tem rota de
      // histórico por item, e chamar uma seria chamar rota inexistente.
      if (activity !== null && recentActivity[activity]) return openDetail(recentActivity[activity].h, recentActivity[activity].kind);
      if (hdetail !== null && historyRows[hdetail]) return openDetail(historyRows[hdetail], historyTab === 'backups' ? 'backup' : 'task');

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
    dashboard: loadDashboard, tasks: loadTasks, backups: loadBackups, history: loadHistory,
    calendar: loadCalendar, logs: loadLogs, services: loadServices, scripts: loadScripts,
    sync: loadSync, retention: loadRetention, network: loadNetwork,
  };

  /** Carrega a tela só quando este login pode vê-la: pedir e receber 403 é ruído. */
  function loadPage(page) {
    if (!pageAllowed(page)) return;
    if (loaders[page]) loaders[page]();
  }

  /** Troca de tela. O monitor só desenha depois de visível, senão o canvas mede zero. */
  function goTo(page) {
    const item = document.querySelector('.nav-item[data-page="' + page + '"]');
    const target = $('page-' + page);
    if (!item || !target || item.hidden) return false;

    document.querySelectorAll('.nav-item[data-page]').forEach((n) => n.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    item.classList.add('active');
    target.classList.add('active');
    if (page === 'monitor') Object.values(charts).forEach((c) => { c.resize(); c.draw(); });
    loadPage(page);
    return true;
  }

  /** Pisca a linha que a origem apontou, para não se perder numa tabela grande. */
  function flashRow(id) {
    if (!id) return;
    const el = document.querySelector('[data-row-id="' + id.replace(/"/g, '\\"') + '"]');
    if (!el) return;
    el.classList.add('row-flash');
    el.scrollIntoView({ block: 'center' });
    setTimeout(() => el.classList.remove('row-flash'), 2600);
  }

  document.querySelectorAll('.nav-item[data-page]').forEach((item) => {
    item.addEventListener('click', () => goTo(item.getAttribute('data-page')));
  });

  $('btn-reload-dashboard').addEventListener('click', loadDashboard);
  $('btn-reload-tasks').addEventListener('click', loadTasks);
  $('btn-reload-backups').addEventListener('click', loadBackups);
  $('btn-reload-history').addEventListener('click', loadHistory);
  $('btn-reload-logs').addEventListener('click', loadLogs);
  $('btn-reload-services').addEventListener('click', loadServices);
  $('btn-reload-scripts').addEventListener('click', loadScripts);
  $('btn-reload-sync').addEventListener('click', loadSync);
  $('btn-reload-retention').addEventListener('click', loadRetention);
  $('btn-reload-net').addEventListener('click', loadNetwork);
  $('btn-goto-calendar').addEventListener('click', () => goTo('calendar'));
  $('btn-goto-history').addEventListener('click', () => goTo('history'));

  // ─── Abas, calendário e links que saem da linha ───
  document.addEventListener('click', (ev) => {
    const hist = ev.target.closest('[data-hist]');
    if (hist) {
      historyTab = hist.getAttribute('data-hist');
      document.querySelectorAll('#history-tabs .tab').forEach((b) => {
        const ativo = b === hist;
        b.classList.toggle('active', ativo);
        b.setAttribute('aria-selected', String(ativo));
      });
      loadHistory();
      return;
    }

    const logtab = ev.target.closest('[data-logtab]');
    if (logtab) {
      logsTab = logtab.getAttribute('data-logtab');
      loadLogs();
      return;
    }

    const view = ev.target.closest('[data-view]');
    if (view) {
      calView = view.getAttribute('data-view');
      document.querySelectorAll('.cal-view-btn').forEach((b) => {
        const ativo = b === view;
        b.classList.toggle('active', ativo);
        b.setAttribute('aria-selected', String(ativo));
      });
      loadCalendar();
      return;
    }

    // Um dia lotado vira agenda daquele dia, em vez de sumir atrás do "+3".
    const mais = ev.target.closest('[data-open-day]');
    if (mais) {
      calView = 'agenda';
      calAnchor = new Date(mais.getAttribute('data-open-day') + 'T00:00:00');
      document.querySelectorAll('.cal-view-btn').forEach((b) => {
        const ativo = b.getAttribute('data-view') === 'agenda';
        b.classList.toggle('active', ativo);
        b.setAttribute('aria-selected', String(ativo));
      });
      loadCalendar();
      return;
    }

    const destino = ev.target.closest('[data-goto]');
    if (destino) {
      const page = destino.getAttribute('data-goto');
      if (goTo(page)) flashRow(destino.getAttribute('data-id'));
    }
  });

  // Chips e linhas do calendário abrem com o teclado também.
  document.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[data-goto], [data-open-day], [data-sf-cron]')) {
      ev.preventDefault();
      ev.target.click();
    }
  });

  $('logs-level').addEventListener('change', (ev) => {
    logsLevel = ev.target.value;
    loadLogs();
  });

  $('cal-prev').addEventListener('click', () => calShift(-1));
  $('cal-next').addEventListener('click', () => calShift(1));
  $('cal-today').addEventListener('click', () => { calAnchor = new Date(); loadCalendar(); });

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
      // A partir daqui o painel sabe o que esta pessoa pode usar. Sem o campo
      // (servidor antigo), `can()` libera tudo e quem recusa continua sendo a rota.
      perms = me.permissions || null;
      applyPermissions();
    } catch (e) { return; }
    primeMonitor();
    // O dashboard é a porta de entrada: carrega junto com a sessão, como o monitor.
    loadPage('dashboard');

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
