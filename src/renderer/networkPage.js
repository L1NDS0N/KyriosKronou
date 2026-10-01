// networkPage.js - Rede de sincronismo: daemon, dispositivos e pastas.
//
// Três abas porque são três perguntas diferentes: o estado da rede (dashboard),
// quem pode falar com esta máquina (dispositivos) e o que está sendo
// compartilhado (pastas). A autorização por GitHub é a única porta de entrada
// - um dispositivo que não passou por ela aparece, mas não pode receber pasta
// nenhuma, e o botão de compartilhar diz exatamente o que está faltando.
'use strict';

const FOLDER_TABS = [
  { id: 'general', labelKey: 'network.folderTabGeneral' },
  { id: 'advanced', labelKey: 'network.folderTabAdvanced' },
  { id: 'versioning', labelKey: 'network.folderTabVersioning' },
  { id: 'ignores', labelKey: 'network.folderTabIgnores' },
  { id: 'compression', labelKey: 'network.compression' },
];

const FOLDER_TYPES = [
  { value: 'sendreceive', labelKey: 'network.folderTypeSendReceive' },
  { value: 'sendonly', labelKey: 'network.folderTypeSendOnly' },
  { value: 'receiveonly', labelKey: 'network.folderTypeReceiveOnly' },
  { value: 'receiveencrypted', labelKey: 'network.folderTypeReceiveEncrypted' },
];

const VERSIONING_TYPES = [
  { value: 'off', labelKey: 'network.versioningOff' },
  { value: 'trashcan', labelKey: 'network.versioningTrashcan' },
  { value: 'simple', labelKey: 'network.versioningSimple' },
  { value: 'staggered', labelKey: 'network.versioningStaggered' },
];

function netBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) { value /= 1000; i++; }
  return `${value.toFixed(value >= 100 ? 0 : 2).replace(/\.00$/, '')} ${units[i]}`;
}

function netRate(bytesPerSecond) {
  return `${netBytes(bytesPerSecond)}/s`;
}

function netUptime(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

// Syncthing gera ids curtos em base32 minúsculo; um id inventado com formato
// errado é aceito pela config e nunca conecta com nada.
function netFolderId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i === 8) out += '-';
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

class NetworkPage {
  constructor() {
    this.status = null;
    this.identity = { loggedIn: false, user: null };
    this.overview = null;
    this.folders = [];
    this.devices = [];
    this.instances = [];
    this.tab = 'dashboard';
    this.folderTab = 'general';
    this.draft = null;
    this.ignores = [];
    this.tasks = [];
    this.busy = null;
  }

  // As tarefas pós-sincronismo são tarefas já registradas no Agendador. O
  // sincronismo não cria nem edita tarefas: ele só referencia uma pelo id.
  async loadTasks() {
    try { this.tasks = (await window.api.getTasks()) || []; }
    catch (e) { this.tasks = []; }
  }

  async load() {
    try { this.status = await window.api.getSyncNetworkStatus(); } catch (e) { this.status = { installed: false, running: false }; }
    try { this.identity = await window.api.getSyncNetworkIdentity(); } catch (e) { this.identity = { loggedIn: false, user: null }; }
    await this.loadTasks();
    try {
      const result = await window.api.getSyncNetworkInstances();
      this.instances = (result && result.instances) || [];
    } catch (e) { this.instances = []; }

    if (this.status && this.status.running) {
      const [overview, folders, devices] = await Promise.all([
        window.api.getSyncNetworkOverview().catch(() => null),
        window.api.getSyncNetworkFolders().catch(() => null),
        window.api.getSyncNetworkDevices().catch(() => null),
      ]);
      this.overview = overview && overview.ok ? overview : null;
      this.folders = folders && folders.ok ? folders.folders : [];
      this.devices = devices && devices.ok ? devices.devices : [];
    } else {
      this.overview = null;
      this.folders = [];
      this.devices = [];
    }
    this.render();
  }

  setTab(tab) {
    this.tab = tab;
    this.render();
  }

  render() {
    this.renderSetup();
    for (const name of ['dashboard', 'devices', 'folders']) {
      const panel = document.getElementById(`net-panel-${name}`);
      if (panel) panel.style.display = name === this.tab ? 'block' : 'none';
    }
    for (const btn of document.querySelectorAll('.net-tab')) {
      const active = btn.dataset.netTab === this.tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    }
    if (this.tab === 'dashboard') this.renderDashboard();
    if (this.tab === 'devices') this.renderDevices();
    if (this.tab === 'folders') this.renderFolders();
  }

  renderSetup() {
    const box = document.getElementById('network-setup');
    if (!box) return;
    const status = this.status || { installed: false, running: false };
    if (status.installed && status.running) { box.style.display = 'none'; box.innerHTML = ''; return; }

    box.style.display = 'block';
    if (!status.installed) {
      box.innerHTML = `
        <div class="net-setup">
          <div class="net-setup-body">
            <h3>${escHtml(i18n.t('network.installTitle'))}</h3>
            <p>${escHtml(i18n.t('network.installDesc'))}</p>
            ${status.reason ? `<p class="net-setup-reason">${escHtml(i18n.t(status.reason))}</p>` : ''}
          </div>
          <button class="btn-glow" ${this.busy ? 'disabled' : ''} onclick="networkPage.install()">
            <i data-lucide="download"></i><span>${escHtml(i18n.t('network.install'))}</span>
          </button>
        </div>`;
    } else {
      box.innerHTML = `
        <div class="net-setup">
          <div class="net-setup-body">
            <h3>${escHtml(i18n.t('network.startTitle'))}</h3>
            <p>${escHtml(i18n.t('network.startDesc'))}</p>
            ${status.reason ? `<p class="net-setup-reason">${escHtml(i18n.t(status.reason))}</p>` : ''}
            ${status.version ? `<p class="net-setup-reason">${escHtml(i18n.t('network.detectedVersion').replace('{v}', status.version.text))}</p>` : ''}
          </div>
          <button class="btn-glow" ${this.busy ? 'disabled' : ''} onclick="networkPage.start()">
            <i data-lucide="play"></i><span>${escHtml(i18n.t('network.start'))}</span>
          </button>
        </div>`;
    }
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  }

  async install() {
    this.busy = 'install';
    this.renderSetup();
    const result = await window.api.installSyncthing();
    this.busy = null;
    if (result && result.success) {
      showToast(i18n.t('network.installed'), 'success');
    } else {
      // O motivo vem do main e é específico: hash divergente significa que o
      // instalador do Chocolatey mudou e ninguém executou nada. Um "falhou"
      // genérico esconderia justamente o que o operador precisa fazer.
      const reason = result && result.reason;
      let texto = i18n.t(reason || 'network.installFailed');
      if (reason === 'sync.install.chocoHashMismatch') {
        texto += ` ${i18n.t('network.chocoHashMismatchHint')}`;
      }
      showToast(texto, 'error');
    }
    await this.load();
  }

  async start() {
    this.busy = 'start';
    this.renderSetup();
    const result = await window.api.startSyncthing();
    this.busy = null;
    if (result && result.success) showToast(i18n.t('network.started'), 'success');
    else showToast(i18n.t('network.startFailed'), 'error');
    await this.load();
  }

  metric(labelKey, value, extra) {
    return `<div class="net-metric">
      <span class="net-metric-label">${escHtml(i18n.t(labelKey))}</span>
      <span class="net-metric-value">${escHtml(value)}</span>
      ${extra ? `<span class="net-metric-extra">${escHtml(extra)}</span>` : ''}
    </div>`;
  }

  renderDashboard() {
    const panel = document.getElementById('net-panel-dashboard');
    if (!panel) return;
    const status = this.status || {};
    if (!this.overview) {
      panel.innerHTML = `<div class="empty-state"><i data-lucide="gauge" class="empty-icon"></i><p>${escHtml(i18n.t('network.dashboardUnavailable'))}</p></div>`;
      if (window.lucide && lucide.createIcons) lucide.createIcons();
      return;
    }

    const v = this.overview;
    const discovery = v.discovery.available ? `${v.discovery.ok}/${v.discovery.total}` : '—';

    panel.innerHTML = `
      <div class="net-metrics">
        ${this.metric('network.metricReceive', netRate(v.receive.rate), netBytes(v.receive.bytes))}
        ${this.metric('network.metricSend', netRate(v.send.rate), netBytes(v.send.bytes))}
        ${this.metric('network.metricLocalState', String(v.localState.files), `${String(v.localState.directories)} · ~${netBytes(v.localState.bytes)}`)}
        ${this.metric('network.metricListeners', `${v.listeners.ok}/${v.listeners.total}`, '')}
        ${this.metric('network.metricDiscovery', discovery, '')}
        ${this.metric('network.metricUptime', netUptime(v.uptimeMs), '')}
        ${this.metric('network.metricIdentity', v.deviceID || '—', '')}
        ${this.metric('network.metricVersion', v.version.long || '—', '')}
      </div>
      <div class="net-footer">
        <span><i data-lucide="link"></i> ${escHtml(i18n.t('network.connections'))}: ${v.connections}</span>
        <span><i data-lucide="hard-drive"></i> ${escHtml(i18n.t('network.home'))}: ${escHtml(status.home || '')}</span>
        <button class="btn-outline" onclick="networkPage.stop()"><i data-lucide="square"></i><span>${escHtml(i18n.t('network.stop'))}</span></button>
      </div>`;
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  }

  async stop() {
    const result = await window.api.stopSyncthing();
    if (result && result.success) showToast(i18n.t('network.stopped'), 'success');
    else showToast(i18n.t('network.stopFailed'), 'error');
    await this.load();
  }

  renderIdentity() {
    const user = this.identity && this.identity.user;
    if (this.identity && this.identity.loggedIn && user) {
      return `<div class="net-identity">
        <img class="net-identity-avatar" src="${escAttr(user.avatar || '')}" alt="">
        <div><strong>${escHtml(user.login)}</strong><span>#${escHtml(String(user.id))}</span></div>
        <button class="btn-outline" onclick="networkPage.logout()"><i data-lucide="log-out"></i></button>
      </div>`;
    }
    return `<div class="net-identity">
      <i data-lucide="shield-alert"></i>
      <div><strong>${escHtml(i18n.t('network.loginRequiredTitle'))}</strong><span>${escHtml(i18n.t('network.loginRequiredDesc'))}</span></div>
      <button class="btn-glow" onclick="networkPage.login()"><i data-lucide="log-in"></i><span>${escHtml(i18n.t('network.loginGitHub'))}</span></button>
    </div>`;
  }

  renderDevices() {
    const panel = document.getElementById('net-panel-devices');
    if (!panel) return;
    const identityBlock = this.renderIdentity();

    const rows = this.devices.map((d) => `
      <tr class="${d.authorized ? 'net-row-ok' : 'net-row-warn'}">
        <td><strong>${escHtml(d.name || d.deviceID)}</strong></td>
        <td><code>${escHtml(d.deviceID)}</code></td>
        <td>${d.connected
          ? `<span class="net-pill net-pill-ok">${escHtml(i18n.t('network.connected'))}</span>`
          : `<span class="net-pill">${escHtml(i18n.t('network.disconnected'))}</span>`}</td>
        <td>${d.authorized
          ? `<span class="net-pill net-pill-ok" title="${escAttr(d.githubLogin)}">${escHtml(d.githubLogin)}</span>`
          : `<span class="net-pill net-pill-warn">${escHtml(i18n.t('network.notAuthorized'))}</span>`}</td>
        <td class="net-actions">
          ${d.authorized
            ? `<button class="btn-outline btn-danger" onclick="networkPage.revoke('${escHandler(d.deviceID)}')">${escHtml(i18n.t('network.revoke'))}</button>`
            : `<button class="btn-outline" ${this.identity.loggedIn ? '' : 'disabled'} onclick="networkPage.authorize('${escHandler(d.deviceID)}')">${escHtml(i18n.t('network.authorize'))}</button>`}
        </td>
      </tr>`).join('');

    panel.innerHTML = `
      ${identityBlock}
      <div class="net-help"><i data-lucide="hard-drive"></i><span>${escHtml(i18n.t('network.localCopyHelp'))}</span></div>
      ${this.renderInstances()}
      <table class="net-table">
        <thead><tr>
          <th>${escHtml(i18n.t('network.colName'))}</th>
          <th>${escHtml(i18n.t('network.colDeviceId'))}</th>
          <th>${escHtml(i18n.t('network.colState'))}</th>
          <th>${escHtml(i18n.t('network.colGitHub'))}</th>
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="5" class="net-empty">${escHtml(i18n.t('network.noDevices'))}</td></tr>`}</tbody>
      </table>`;
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  }

  // Cada instancia extra e um destino local. A pasta compartilhada entre a
  // instancia principal e ela passa pelo mesmo protocolo e pelo mesmo
  // pareamento por GitHub das maquinas remotas.
  renderInstances() {
    const extra = this.instances.filter((i) => i.Id !== 'default');
    const rows = extra.map((i) => `
      <tr>
        <td><strong>${escHtml(i.Name)}</strong></td>
        <td><code>${escHtml(i.deviceID || i18n.t('network.instanceNoDevice'))}</code></td>
        <td class="net-path">${escHtml(i.Home)}</td>
        <td class="net-actions">
          <button class="btn-outline" onclick="networkPage.startInstance('${escHandler(i.Id)}')"><i data-lucide="play"></i></button>
          <button class="btn-outline" onclick="networkPage.stopInstance('${escHandler(i.Id)}')"><i data-lucide="square"></i></button>
          <button class="btn-outline btn-danger" onclick="networkPage.removeInstance('${escHandler(i.Id)}')"><i data-lucide="trash-2"></i></button>
        </td>
      </tr>`).join('');

    return `
      <div class="net-toolbar">
        <button class="btn-outline" onclick="networkPage.createInstance()"><i data-lucide="plus"></i><span>${escHtml(i18n.t('network.newInstance'))}</span></button>
      </div>
      ${extra.length ? `<table class="net-table">
        <thead><tr>
          <th>${escHtml(i18n.t('network.colName'))}</th>
          <th>${escHtml(i18n.t('network.colDeviceId'))}</th>
          <th>${escHtml(i18n.t('network.colPath'))}</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : ''}`;
  }

  async createInstance() {
    const name = window.prompt(i18n.t('network.instancePrompt'));
    if (!name) return;
    const result = await window.api.createSyncNetworkInstance(name);
    if (result && result.ok) showToast(i18n.t('network.instanceCreated'), 'success');
    else showToast(i18n.t((result && result.error) || 'network.instanceFailed'), 'error');
    await this.load();
  }

  async removeInstance(id) {
    await window.api.removeSyncNetworkInstance(id);
    showToast(i18n.t('network.instanceRemoved'), 'success');
    await this.load();
  }

  async startInstance(id) {
    const result = await window.api.startSyncNetworkInstance(id);
    showToast(i18n.t(result && result.success ? 'network.instanceStarted' : 'network.instanceFailed'), result && result.success ? 'success' : 'error');
  }

  async stopInstance(id) {
    const result = await window.api.stopSyncNetworkInstance(id);
    showToast(i18n.t(result && result.success ? 'network.instanceStopped' : 'network.instanceFailed'), result && result.success ? 'success' : 'error');
  }

  async login() {
    const started = await window.api.startGithubDeviceFlow();
    if (!started || !started.ok) { showToast(i18n.t('network.loginFailed'), 'error'); return; }
    await this.showDeviceCode(started);
  }

  async showDeviceCode(flow) {
    const overlay = document.getElementById('network-folder-modal-overlay');
    overlay.classList.remove('hidden');
    overlay.innerHTML = `
      <div class="modal-content net-modal">
        <div class="modal-header"><h3>${escHtml(i18n.t('network.loginGitHub'))}</h3>
          <button class="modal-close" onclick="networkPage.closeModal()">&times;</button></div>
        <div class="modal-body">
          <p>${escHtml(i18n.t('network.loginInstructions'))}</p>
          <div class="net-code">${escHtml(flow.userCode)}</div>
          <p><a href="${escAttr(flow.verificationUri)}" target="_blank" rel="noreferrer">${escHtml(flow.verificationUri)}</a></p>
          <p class="net-hint">${escHtml(i18n.t('network.loginWaiting'))}</p>
        </div>
      </div>`;

    const deadline = Date.now() + (flow.expiresIn || 900) * 1000;
    let interval = (flow.interval || 5) * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const result = await window.api.pollGithubDeviceFlow(flow.deviceCode);
      if (result && result.ok) {
        this.closeModal();
        showToast(i18n.t('network.loginSuccess'), 'success');
        this.identity = { loggedIn: true, user: result.user };
        this.render();
        return;
      }
      if (result && result.pending) { if (result.interval) interval = result.interval * 1000; continue; }
      this.closeModal();
      showToast((result && result.error) || i18n.t('network.loginFailed'), 'error');
      return;
    }
    this.closeModal();
    showToast(i18n.t('network.loginExpired'), 'error');
  }

  async logout() {
    await window.api.logoutGithubDeviceFlow();
    this.identity = { loggedIn: false, user: null };
    showToast(i18n.t('network.loggedOut'), 'success');
    this.render();
  }

  async authorize(deviceID) {
    const user = this.identity.user;
    const result = await window.api.authorizeSyncNetworkDevice({
      deviceID, githubId: user.id, githubLogin: user.login,
    });
    if (result && result.ok) showToast(i18n.t('network.authorized'), 'success');
    else showToast(i18n.t((result && result.reason) || 'network.authorizeFailed'), 'error');
    await this.load();
  }

  async revoke(deviceID) {
    await window.api.revokeSyncNetworkDevice(deviceID);
    showToast(i18n.t('network.revoked'), 'success');
    await this.load();
  }

  renderFolders() {
    const panel = document.getElementById('net-panel-folders');
    if (!panel) return;
    const unauthorized = this.folders.filter((f) => !f.authorized).length;

    const rows = this.folders.map((f) => `
      <tr>
        <td><strong>${escHtml(f.label || f.id)}</strong></td>
        <td><code>${escHtml(f.id)}</code></td>
        <td class="net-path">${escHtml(f.path)}</td>
        <td>${escHtml(i18n.t((FOLDER_TYPES.find((t) => t.value === f.type) || FOLDER_TYPES[0]).labelKey))}</td>
        <td>${(f.devices || []).length}</td>
        <td class="net-actions">
          <button class="btn-outline" onclick="networkPage.editFolder('${escHandler(f.id)}')"><i data-lucide="pencil"></i></button>
          <button class="btn-outline" onclick="networkPage.rescan('${escHandler(f.id)}')"><i data-lucide="refresh-cw"></i></button>
          <button class="btn-outline btn-danger" onclick="networkPage.deleteFolder('${escHandler(f.id)}')"><i data-lucide="trash-2"></i></button>
        </td>
      </tr>`).join('');

    panel.innerHTML = `
      ${unauthorized ? `<div class="net-help net-help-warn"><i data-lucide="shield-alert"></i><span>${escHtml(i18n.t('network.unauthorizedFolders').replace('{n}', String(unauthorized)))}</span></div>` : ''}
      <div class="net-toolbar">
        <button class="btn-glow" onclick="networkPage.createFolder()"><i data-lucide="plus"></i><span>${escHtml(i18n.t('network.newFolder'))}</span></button>
      </div>
      <table class="net-table">
        <thead><tr>
          <th>${escHtml(i18n.t('network.colLabel'))}</th>
          <th>${escHtml(i18n.t('network.colFolderId'))}</th>
          <th>${escHtml(i18n.t('network.colPath'))}</th>
          <th>${escHtml(i18n.t('network.colType'))}</th>
          <th>${escHtml(i18n.t('network.colDevices'))}</th>
          <th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="6" class="net-empty">${escHtml(i18n.t('network.noFolders'))}</td></tr>`}</tbody>
      </table>`;
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  }

  createFolder() {
    this.draft = {
      id: netFolderId(), label: '', path: '', type: 'sendreceive',
      PreSyncTaskId: '', PostSyncTaskId: '', PreSyncBlocks: false,
      devices: [], ignorePerms: false, syncOwnership: false, syncXattrs: false,
      rescanIntervalS: 3600, fsWatcherEnabled: true, fsWatcherDelayS: 10,
      versioning: { type: 'off', params: {} },
    };
    this.ignores = [];
    this.folderTab = 'general';
    this.renderFolderModal();
  }

  async editFolder(id) {
    const folder = this.folders.find((f) => f.id === id);
    if (!folder) return;
    this.draft = JSON.parse(JSON.stringify(folder));
    this.folderTab = 'general';
    const result = await window.api.getSyncNetworkIgnores(id).catch(() => null);
    this.ignores = result && result.ok ? result.ignores : [];
    this.renderFolderModal();
  }

  closeModal() {
    const overlay = document.getElementById('network-folder-modal-overlay');
    overlay.classList.add('hidden');
    overlay.innerHTML = '';
    this.draft = null;
  }

  renderFolderModal() {
    const overlay = document.getElementById('network-folder-modal-overlay');
    const d = this.draft;
    overlay.classList.remove('hidden');
    overlay.innerHTML = `
      <div class="modal-content net-modal">
        <div class="modal-header">
          <h3>${escHtml(i18n.t('network.folderEditor'))}</h3>
          <button class="modal-close" onclick="networkPage.closeModal()">&times;</button>
        </div>
        <div class="modal-body">
          <div class="modal-steps">${FOLDER_TABS.map((t) => `<div class="modal-step ${t.id === this.folderTab ? 'active' : ''}">${escHtml(i18n.t(t.labelKey))}</div>`).join('')}</div>
          ${this.renderFolderTab()}
        </div>
      </div>`;
    overlay.querySelectorAll('.net-folder-tab').forEach((el) => {
      el.onclick = () => { this.folderTab = el.dataset.tab; this.renderFolderModal(); };
    });
    const pathInput = overlay.querySelector('#net-folder-path');
    if (pathInput) pathInput.oninput = (e) => { this.draft.path = e.target.value; };
    const labelInput = overlay.querySelector('#net-folder-label');
    if (labelInput) labelInput.oninput = (e) => { this.draft.label = e.target.value; };
    if (window.lucide && lucide.createIcons) lucide.createIcons();
  }

  renderFolderTab() {
    const d = this.draft;
    const tabButtons = `<div class="net-folder-tabs">${FOLDER_TABS.map((t) => `<button class="net-folder-tab ${t.id === this.folderTab ? 'active' : ''}" data-tab="${t.id}">${escHtml(i18n.t(t.labelKey))}</button>`).join('')}</div>`;
    if (this.folderTab === 'general') {
      return `${tabButtons}
        <div class="net-form">
          <label class="net-field"><span>${escHtml(i18n.t('network.folderLabel'))}</span>
            <input id="net-folder-label" value="${escAttr(d.label)}"></label>
          <label class="net-field"><span>${escHtml(i18n.t('network.folderId'))}</span>
            <input id="net-folder-id" value="${escAttr(d.id)}" readonly></label>
          <label class="net-field"><span>${escHtml(i18n.t('network.folderPath'))}</span>
            <input id="net-folder-path" value="${escAttr(d.path)}"></label>
          <label class="net-field"><span>${escHtml(i18n.t('network.folderType'))}</span>
            <select onchange="networkPage.setType(this.value)">
              ${FOLDER_TYPES.map((t) => `<option value="${t.value}" ${d.type === t.value ? 'selected' : ''}>${escHtml(i18n.t(t.labelKey))}</option>`).join('')}
            </select></label>
          <label class="net-field"><span>${escHtml(i18n.t('network.preSyncTask'))}</span>
            <select onchange="networkPage.setPreSyncTask(this.value)">
              <option value="">${escHtml(i18n.t('network.postSyncNone'))}</option>
              ${this.tasks.map((t) => `<option value="${escAttr(t.Id)}" ${d.PreSyncTaskId === t.Id ? 'selected' : ''}>${escHtml(t.Name)}${t.Enabled === false ? ` (${escHtml(i18n.t('network.taskDisabled'))})` : ''}</option>`).join('')}
            </select></label>
          ${d.PreSyncTaskId ? `<label class="net-check"><input type="checkbox" ${d.PreSyncBlocks ? 'checked' : ''} onchange="networkPage.setFlag('PreSyncBlocks', this.checked)">
            <span>${escHtml(i18n.t('network.preSyncBlocks'))}</span></label>` : ''}
          <label class="net-field"><span>${escHtml(i18n.t('network.postSyncTask'))}</span>
            <select onchange="networkPage.setPostSyncTask(this.value)">
              <option value="">${escHtml(i18n.t('network.postSyncNone'))}</option>
              ${this.tasks.map((t) => `<option value="${escAttr(t.Id)}" ${d.PostSyncTaskId === t.Id ? 'selected' : ''}>${escHtml(t.Name)}${t.Enabled === false ? ` (${escHtml(i18n.t('network.taskDisabled'))})` : ''}</option>`).join('')}
            </select></label>
        </div>
        <div class="modal-summary">
          <div class="modal-summary-item"><span class="modal-summary-label">${escHtml(i18n.t('network.folderLabel'))}</span><span class="modal-summary-value">${escHtml(d.label || '—')}</span></div>
          <div class="modal-summary-item"><span class="modal-summary-label">${escHtml(i18n.t('network.folderId'))}</span><span class="modal-summary-value">${escHtml(d.id)}</span></div>
          <div class="modal-summary-item"><span class="modal-summary-label">${escHtml(i18n.t('network.folderPath'))}</span><span class="modal-summary-value">${escHtml(d.path || '—')}</span></div>
          <div class="modal-summary-item"><span class="modal-summary-label">${escHtml(i18n.t('network.folderType'))}</span><span class="modal-summary-value">${escHtml(i18n.t((FOLDER_TYPES.find((t) => t.value === d.type) || FOLDER_TYPES[0]).labelKey))}</span></div>
        </div>
        <div class="modal-actions">
          <button class="btn-outline" onclick="networkPage.closeModal()">${escHtml(i18n.t('common.cancel'))}</button>
          <button class="btn-glow" onclick="networkPage.saveFolder()">${escHtml(i18n.t('common.save'))}</button>
        </div>`;
    }

    if (this.folderTab === 'advanced') {
      const receiveOnly = d.type === 'receiveonly';
      return `${tabButtons}
        <div class="net-help"><i data-lucide="info"></i><span>${escHtml(i18n.t('network.advancedIntro'))}</span></div>
        <div class="net-form">
          <label class="net-check"><input type="checkbox" ${d.fsWatcherEnabled ? 'checked' : ''} onchange="networkPage.setFlag('fsWatcherEnabled', this.checked)">
            <span>${escHtml(i18n.t('network.watchChanges'))}</span></label>
          <label class="net-field"><span>${escHtml(i18n.t('network.rescanInterval'))}</span>
            <input type="number" min="0" value="${escAttr(String(d.rescanIntervalS))}" onchange="networkPage.setNumber('rescanIntervalS', this.value)"></label>
          <label class="net-check"><input type="checkbox" ${d.ignorePerms ? 'checked' : ''} onchange="networkPage.setFlag('ignorePerms', this.checked)">
            <span>${escHtml(i18n.t('network.ignorePerms'))}</span></label>
          <label class="net-check"><input type="checkbox" ${d.syncOwnership ? 'checked' : ''} onchange="networkPage.setFlag('syncOwnership', this.checked)" ${receiveOnly ? 'disabled' : ''}>
            <span>${escHtml(i18n.t('network.syncOwnership'))}</span></label>
          <label class="net-check"><input type="checkbox" ${d.syncXattrs ? 'checked' : ''} onchange="networkPage.setFlag('syncXattrs', this.checked)" ${receiveOnly ? 'disabled' : ''}>
            <span>${escHtml(i18n.t('network.syncXattrs'))}</span></label>
          ${receiveOnly ? `<div class="net-help net-help-warn"><i data-lucide="shield-alert"></i><span>${escHtml(i18n.t('network.receiveOnlyMetadata'))}</span></div>` : ''}
        </div>
        <div class="modal-actions"><button class="btn-glow" onclick="networkPage.renderFolderModal()">${escHtml(i18n.t('common.ok'))}</button></div>`;
    }

    if (this.folderTab === 'versioning') {
      return `${tabButtons}
        <div class="net-form">
          <label class="net-field"><span>${escHtml(i18n.t('network.versioning'))}</span>
            <select onchange="networkPage.setVersioningType(this.value)">
              ${VERSIONING_TYPES.map((t) => `<option value="${t.value}" ${d.versioning.type === t.value ? 'selected' : ''}>${escHtml(i18n.t(t.labelKey))}</option>`).join('')}
            </select></label>
          ${this.renderVersioningParams()}
        </div>
        <div class="modal-actions"><button class="btn-glow" onclick="networkPage.renderFolderModal()">${escHtml(i18n.t('common.ok'))}</button></div>`;
    }

    if (this.folderTab === 'compression') {
      const comp = this.draft.Compression || { mode: 'none', level: 5, extensions: [], excludes: [], minSizeBytes: 0 };
      return `${tabButtons}
        <div class="net-help net-help-warn"><i data-lucide="shield-alert"></i><span>${escHtml(i18n.t('network.compressWarning'))}</span></div>
        <div class="net-form">
          <label class="net-field"><span>${escHtml(i18n.t('network.compressionMode'))}</span>
            <select onchange="networkPage.setCompression('mode', this.value)">
              <option value="none" ${comp.mode === 'none' ? 'selected' : ''}>${escHtml(i18n.t('network.compressionOff'))}</option>
              <option value="perFile" ${comp.mode === 'perFile' ? 'selected' : ''}>${escHtml(i18n.t('network.compressionPerFile'))}</option>
              <option value="archive" ${comp.mode === 'archive' ? 'selected' : ''}>${escHtml(i18n.t('network.compressionArchive'))}</option>
            </select></label>
          ${comp.mode !== 'none' ? `
          <label class="net-field"><span>${escHtml(i18n.t('network.compressionLevel'))}</span>
            <input type="number" min="1" max="9" value="${escAttr(String(comp.level || 5))}" onchange="networkPage.setCompression('level', this.value)"></label>
          <label class="net-field"><span>${escHtml(i18n.t('network.compressionMinSize'))}</span>
            <input type="number" min="0" value="${escAttr(String(Math.round((comp.minSizeBytes || 0) / 1024)))}" onchange="networkPage.setCompression('minSizeKb', this.value)"></label>
          <label class="net-field"><span>${escHtml(i18n.t('network.compressionExtensions'))}</span>
            <textarea rows="3" onchange="networkPage.setCompressionList('extensions', this.value)">${escHtml((comp.extensions || []).join('\n'))}</textarea></label>
          <label class="net-field"><span>${escHtml(i18n.t('network.compressionExcludes'))}</span>
            <textarea rows="3" onchange="networkPage.setCompressionList('excludes', this.value)">${escHtml((comp.excludes || []).join('\n'))}</textarea></label>
          ${comp.mode === 'archive' ? `
          <label class="net-field"><span>${escHtml(i18n.t('network.compressionArchivePath'))}</span>
            <input value="${escAttr(comp.archivePath || '')}" onchange="networkPage.setCompression('archivePath', this.value)"
              placeholder="C:\\compactado\\${escHtml(this.draft.id || 'pasta')}.7z"></label>
          <div class="net-help"><i data-lucide="info"></i><span>${escHtml(i18n.t('network.archiveOutsideHint'))}</span></div>` : ''}
          ` : ''}
        </div>
        <div class="modal-actions">
          ${comp.mode !== 'none' && this.draft.id ? `<button class="btn-outline" ${this.busy ? 'disabled' : ''} onclick="networkPage.compressNow()"><i data-lucide="package"></i><span>${escHtml(i18n.t('network.compressNow'))}</span></button>` : ''}
          ${comp.mode === 'archive' && comp.archivePath ? `<button class="btn-outline" ${this.busy ? 'disabled' : ''} onclick="networkPage.restoreNow()"><i data-lucide="undo-2"></i><span>${escHtml(i18n.t('network.restoreFolder'))}</span></button>` : ''}
          <button class="btn-glow" onclick="networkPage.renderFolderModal()">${escHtml(i18n.t('common.ok'))}</button>
        </div>`;
    }

    return `${tabButtons}
      <div class="net-form">
        <label class="net-field"><span>${escHtml(i18n.t('network.ignorePatterns'))}</span>
          <textarea rows="10" onchange="networkPage.setIgnores(this.value)">${escHtml(this.ignores.join('\n'))}</textarea></label>
      </div>
      <div class="modal-actions"><button class="btn-glow" onclick="networkPage.renderFolderModal()">${escHtml(i18n.t('common.ok'))}</button></div>`;
  }

  renderVersioningParams() {
    const v = this.draft.versioning;
    if (v.type === 'off') return '';
    if (v.type === 'staggered') {
      return `
        <label class="net-field"><span>${escHtml(i18n.t('network.maxAgeHours'))}</span>
          <input type="number" min="1" value="${escAttr(String(v.params.maxAge || 365 * 24 * 60))}" onchange="networkPage.setVersioningParam('maxAge', this.value)"></label>
        <label class="net-field"><span>${escHtml(i18n.t('network.cleanIntervalDays'))}</span>
          <input type="number" min="1" value="${escAttr(String(v.params.cleanIntervalDays || 30))}" onchange="networkPage.setVersioningParam('cleanIntervalDays', this.value)"></label>`;
    }
    if (v.type === 'simple') {
      return `<label class="net-field"><span>${escHtml(i18n.t('network.keep'))}</span>
        <input type="number" min="1" value="${escAttr(String(v.params.keep || 5))}" onchange="networkPage.setVersioningParam('keep', this.value)"></label>`;
    }
    return `<label class="net-field"><span>${escHtml(i18n.t('network.cleanoutDays'))}</span>
      <input type="number" min="1" value="${escAttr(String(v.params.cleanoutDays || 30))}" onchange="networkPage.setVersioningParam('cleanoutDays', this.value)"></label>`;
  }

  setType(value) { this.draft.type = value; this.renderFolderModal(); }
  setPostSyncTask(value) { this.draft.PostSyncTaskId = value || ''; }
  setPreSyncTask(value) { this.draft.PreSyncTaskId = value || ''; this.draft.PreSyncBlocks = this.draft.PreSyncBlocks === true; this.renderFolderModal(); }
  setFlag(key, value) { this.draft[key] = value; }
  setNumber(key, value) { this.draft[key] = Number(value) || 0; }
  setVersioningType(value) { this.draft.versioning = { type: value, params: {} }; this.renderFolderModal(); }
  setVersioningParam(key, value) { this.draft.versioning.params[key] = Number(value) || 0; }
  setCompression(key, value) {
    if (!this.draft.Compression) this.draft.Compression = { mode: 'none', level: 5, extensions: [], excludes: [], minSizeBytes: 0 };
    if (key === 'minSizeKb') this.draft.Compression.minSizeBytes = Math.max(0, Math.round(Number(value) || 0) * 1024);
    else if (key === 'level') this.draft.Compression.level = Math.min(9, Math.max(1, Number(value) || 5));
    else this.draft.Compression[key] = value;
    this.renderFolderModal();
  }

  setCompressionList(key, value) {
    if (!this.draft.Compression) this.draft.Compression = { mode: 'none', level: 5, extensions: [], excludes: [], minSizeBytes: 0 };
    this.draft.Compression[key] = String(value).split('\n').map((l) => l.trim()).filter(Boolean);
  }

  async compressNow() {
    if (!this.draft.Compression || this.draft.Compression.mode === 'none') return;
    this.busy = 'compress';
    this.renderFolderModal();
    // Grava antes de comprimir: a pasta precisa existir no Syncthing para o
    // caminho ser conhecido, e o Compression precisa estar persistido para o
    // ciclo automático usar a mesma política.
    await this.saveFolder({ quiet: true });
    const result = await window.api.compressSyncNetworkFolder(this.draft.id, this.draft.Compression);
    this.busy = null;
    if (result && result.ok) {
      showToast(i18n.t('network.compressionDone').replace('{n}', String(result.added || 0)).replace('{r}', String(result.removed || 0)), 'success');
    } else {
      showToast(i18n.t('network.compressionFailed'), 'error');
    }
    this.renderFolderModal();
  }

  async restoreNow() {
    if (!this.draft.Compression) return;
    this.busy = 'restore';
    this.renderFolderModal();
    const result = await window.api.restoreSyncNetworkFolder(this.draft.id, this.draft.Compression);
    this.busy = null;
    showToast(i18n.t(result && result.ok ? 'network.restoreDone' : 'network.compressionFailed'), result && result.ok ? 'success' : 'error');
    this.renderFolderModal();
  }

  setIgnores(value) { this.ignores = String(value).split('\n').map((l) => l.trim()).filter(Boolean); }

  async saveFolder(options = {}) {
    // O Compression viaja no objeto da pasta, que é um bloco livre do Syncthing:
    // um campo a mais no JSON da config não atrapalha o daemon, e reaproveita
    // a mesma gravação em vez de criar um canal paralelo.
    const result = await window.api.saveSyncNetworkFolder(this.draft);
    if (!result || !result.ok) {
      const reason = (result && result.error) || 'network.saveFailed';
      showToast(i18n.t(reason), 'error');
      return false;
    }
    await window.api.saveSyncNetworkIgnores(this.draft.id, this.ignores);
    if (!options.quiet) {
      this.closeModal();
      showToast(i18n.t('network.folderSaved'), 'success');
    }
    await this.load();
    return true;
  }

  async deleteFolder(id) {
    await window.api.deleteSyncNetworkFolder(id);
    showToast(i18n.t('network.folderDeleted'), 'success');
    await this.load();
  }

  async rescan(id) {
    await window.api.rescanSyncNetworkFolder(id);
    showToast(i18n.t('network.rescanQueued'), 'success');
  }
}

window.networkPage = new NetworkPage();
