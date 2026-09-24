// syncPage.js - Folder Sync UI: profiles, wizard, retention preview.
//
// The wizard's centerpiece is the retention step: point it at a destination
// and it shows what WOULD be deleted before anything is deleted. The folder
// analysis runs on the main process (analyze-sync-folder) so the same code
// the service will execute is what made the suggestion.
'use strict';

function syncEsc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

class SyncPage {
  constructor() {
    this.profiles = [];
    this.engines = [];
    this.tasks = [];            // for the task-trigger dropdown
    this.editingId = null;
    this.currentStep = 0;
    this.draft = {};
    this.analysis = null;       // folder pattern analysis for the wizard
    this.retentionPreview = null; // what would be deleted, live
    this.simulation = null;     // whole-sync dry run (planner + retention)
    this.simTab = 'copy';
  }

  async load() {
    try {
      const result = await window.api.getSyncProfiles();
      this.profiles = Array.isArray(result) ? result : [];
    } catch (e) {
      console.error('Failed to load sync profiles:', e);
      this.profiles = [];
    }
    try {
      this.engines = (await window.api.getSyncEngines()) || [];
    } catch (e) {
      this.engines = [{ id: 'local', label: 'Local / mapped drive', defaultPort: null, credentials: false }];
    }
    try {
      this.tasks = (await window.api.getTasks()) || [];
    } catch (e) {
      this.tasks = [];
    }
    this.render();
  }

  async render() {
    const list = document.getElementById('sync-profiles-list');
    const empty = document.getElementById('sync-empty');
    if (!list) return;

    if (!this.profiles.length) {
      list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    const statsMap = {};
    for (const p of this.profiles) {
      try {
        const r = await window.api.getSyncHistory(p.Id);
        statsMap[p.Id] = (r && r.stats) || {};
      } catch (e) { statsMap[p.Id] = {}; }
    }

    list.innerHTML = this.profiles.map(p => {
      const st = statsMap[p.Id] || {};
      const engine = (this.engines || []).find(e => e.id === (p.Engine || 'local'));
      const engineLabel = engine ? engine.label : (p.Engine || 'local');
      const ret = p.Retention || {};
      const retLabel = ret.Enabled
        ? [ret.ByAge ? `${ret.KeepDays}d` : null, ret.ByCount ? `${ret.KeepCount}x` : null, ret.BySize ? `${ret.FreeGb}GB` : null]
            .filter(Boolean).join(' · ')
        : null;
      return `
      <div class="glass-card sync-profile-card ${p.Enabled ? '' : 'disabled'}" onclick="syncPage.editProfile('${p.Id}')">
        <div class="sync-profile-header">
          <div class="sync-profile-info">
            <h3 class="sync-profile-name">${syncEsc(p.Name)}</h3>
            ${window.RunMonitor ? RunMonitor.runningBadge(p.Id) : ''}
            <span class="badge badge-info">${syncEsc(engineLabel)}</span>
            <span class="badge ${p.Enabled ? 'badge-active' : 'badge-disabled'}">${syncEsc(i18n.t(p.Enabled ? 'profile.active' : 'profile.disabled'))}</span>
            <span class="badge badge-info">${syncEsc(p.Mode || 'incremental')}${p.Mirror !== false ? ' · mirror' : ''}</span>
            ${retLabel ? `<span class="badge badge-active" style="font-size:10px"><i data-lucide="scissors" style="width:10px;height:10px"></i> ${syncEsc(retLabel)}</span>` : ''}
          </div>
          <div class="sync-profile-actions" onclick="event.stopPropagation()">
            <label class="toggle-switch" style="margin-right:4px">
              <input type="checkbox" ${p.Enabled ? 'checked' : ''} onchange="syncPage.toggleEnabled('${p.Id}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <button class="btn-glow btn-sm" onclick="syncPage.runProfile('${p.Id}')"><i data-lucide="play"></i> ${syncEsc(i18n.t('profile.run'))}</button>
            <button class="btn-secondary-sm" onclick="syncPage.showHistory('${p.Id}')" title="${syncEsc(i18n.t('profile.history'))}"><i data-lucide="history"></i></button>
            <button class="btn-danger" onclick="syncPage.deleteProfile('${p.Id}','${syncEsc(p.Name)}')" title="${syncEsc(i18n.t('profile.delete'))}"><i data-lucide="trash-2"></i></button>
          </div>
        </div>
        <div class="sync-profile-details">
          <div class="backup-detail"><i data-lucide="folder-open"></i> <span>${syncEsc(p.SourcePath)}</span></div>
          <div class="backup-detail"><i data-lucide="hard-drive"></i> <span>${syncEsc(this._destLabel(p))}</span></div>
          ${p.CronExpression ? `<div class="backup-detail"><i data-lucide="clock"></i> <span>${syncEsc(p.CronExpression)}</span></div>` : ''}
          ${p.LastRun ? `<div class="backup-detail"><i data-lucide="history"></i> <span>${syncEsc(i18n.t('sync.lastRun'))}: ${new Date(p.LastRun).toLocaleString()} — ${syncEsc(p.LastStatus || '?')}</span></div>` : ''}
          ${st.total > 0 ? `<div class="backup-detail"><i data-lucide="bar-chart"></i> <span>${st.total} ${syncEsc(i18n.t('sync.runsCount'))} · ${st.success} ok · ${st.failed} ✗</span></div>` : ''}
        </div>
      </div>`;
    }).join('');
    if (window.lucide) lucide.createIcons();
  }

  _destLabel(p) {
    if (!p.DestPath) return '—';
    if (p.Engine === 'local') return p.DestPath;
    return `${p.Host || ''}${p.Port ? ':' + p.Port : ''} ${p.DestPath}`.trim();
  }

  // ─── List actions ───
  async toggleEnabled(id, enabled) {
    const r = await window.api.updateSyncProfile({ Id: id, Enabled: enabled });
    if (r === null || (r && r.success === false)) {
      showToast((r && r.message) || 'Error', 'error');
      return;
    }
    const p = this.profiles.find(x => x.Id === id);
    if (p) p.Enabled = enabled;
    showToast(i18n.t(enabled ? 'profile.enabledToast' : 'profile.disabledToast', { name: (p && p.Name) || '' }), 'info');
    this.render();
  }

  async runProfile(id) {
    const p = this.profiles.find(x => x.Id === id);
    showToast(i18n.t('sync.running', { name: (p && p.Name) || '' }), 'info');
    const r = await window.api.runSync(id);
    if (r && r.success) {
      showToast(`${i18n.t('sync.runOk')}: ${r.duration || ''}`, 'success');
    } else {
      showToast(`${i18n.t('sync.runFailed')}: ${(r && r.message) || '?'}`, 'error');
    }
    await this.load();
  }

  async deleteProfile(id, name) {
    if (!confirm(i18n.t('sync.confirmDelete', { name }))) return;
    await window.api.deleteSyncProfile(id);
    showToast(i18n.t('sync.deleted', { name }), 'success');
    await this.load();
  }

  async showHistory(id) {
    let r;
    try { r = await window.api.getSyncHistory(id); } catch (e) { return; }
    const entries = (r && r.history) || [];
    const rows = entries.length ? entries.map(e => `
      <div class="th-entry" onclick="this.classList.toggle('th-expanded')">
        <div class="th-row">
          <span class="th-icon">${e.Status === 'Success' ? '✅' : '❌'}</span>
          <span class="th-time">${new Date(e.Timestamp).toLocaleString()}</span>
          <span class="th-duration">${syncEsc(e.Duration || '-')}</span>
          <span class="th-status badge badge-${e.Status === 'Success' ? 'active' : 'badge-disabled'}">${syncEsc(e.Status)}</span>
          <i data-lucide="chevron-down" class="th-chevron"></i>
        </div>
        <div class="th-output">
          <div class="th-output-label">${syncEsc(i18n.t('sync.historyDetail'))}</div>
          <pre class="th-output-text">${syncEsc(e.Message || '')}${e.RetentionDeleted ? `\n${i18n.t('sync.retentionDeleted', { n: e.RetentionDeleted })}` : ''}</pre>
        </div>
      </div>`).join('')
      : `<div style="text-align:center;padding:24px;color:var(--text3)"><p>${syncEsc(i18n.t('sync.noHistory'))}</p></div>`;

    showModal(`
      <h2><i data-lucide="history"></i> ${syncEsc(i18n.t('sync.historyTitle'))}</h2>
      <div style="max-height:400px;overflow-y:auto">${rows}</div>
      <div class="modal-actions"><button class="btn-ghost" onclick="hideModal()">${syncEsc(i18n.t('backup.close'))}</button></div>
    `, true);
    if (window.lucide) lucide.createIcons();
  }

  // ─── Wizard ───
  showCreateModal() {
    this.editingId = null;
    this.currentStep = 0;
    this.analysis = null;
    this.retentionPreview = null;
    this.simulation = null;
    this.simTab = 'copy';
    this.draft = {
      Name: i18n.t('sync.newProfileName') + ' ' + (this.profiles.length + 1),
      SourcePath: '', Engine: 'local', DestPath: '',
      Host: '', Port: null, User: '', Password: '',
      Mode: 'incremental', Mirror: false, Excludes: [],
      Retention: { Enabled: false, ByAge: false, KeepDays: 30, ByCount: false, KeepCount: 10, BySize: false, FreeGb: 0, MinKeep: 3 },
      CronExpression: '0 3 * * *', Enabled: true,
      TriggerTaskId: '', TriggerOnFailure: false,
    };
    this._renderWizard();
  }

  editProfile(id) {
    const p = this.profiles.find(x => x.Id === id);
    if (!p) return;
    this.editingId = id;
    this.currentStep = 0;
    this.analysis = null;
    this.retentionPreview = null;
    this.simulation = null;
    this.simTab = 'copy';
    this.draft = JSON.parse(JSON.stringify(p));
    if (!this.draft.Retention) {
      this.draft.Retention = { Enabled: false, ByAge: false, KeepDays: 30, ByCount: false, KeepCount: 10, BySize: false, FreeGb: 0, MinKeep: 3 };
    }
    this._renderWizard();
  }

  goStep(i) { this.currentStep = i; this._renderWizard(); }
  // Three steps total; the summary lives in the side panel, not a ghost step.
  nextStep() { if (this.currentStep < 2) { this.currentStep++; this._renderWizard(); } }
  prevStep() { if (this.currentStep > 0) { this.currentStep--; this._renderWizard(); } }

  _renderWizard() {
    const isEdit = !!this.editingId;
    const steps = [i18n.t('sync.stepFolders'), i18n.t('sync.stepRetention'), i18n.t('sync.stepSchedule')];
    const stepTips = [i18n.t('sync.tipFolders'), i18n.t('sync.tipRetention'), i18n.t('sync.tipSchedule')];
    const stepIcons = ['folder-sync', 'scissors', 'clock'];

    showModal(`
      <div class="wizard-layout">
        <div class="wizard-main">
          <h2><i data-lucide="${isEdit ? 'pencil' : 'folder-sync'}"></i> ${syncEsc(i18n.t(isEdit ? 'sync.editTitle' : 'sync.newTitle'))}</h2>

          <div class="wizard-tabs">
            ${steps.map((s, i) => `
              <div class="wizard-tab ${i === this.currentStep ? 'active' : ''} ${i < this.currentStep ? 'completed' : ''}" data-tip="${syncEsc(stepTips[i])}" onclick="syncPage.goStep(${i})">
                <div class="wizard-tab-num">${i < this.currentStep ? '<i data-lucide=\\"check\\" style=\\"width:12px;height:12px\\"></i>' : (i + 1)}</div>
                <span class="wizard-tab-label">${syncEsc(s)}</span>
              </div>`).join('')}
          </div>

          <div class="wizard-content" id="sync-wizard-content">${this._renderStep()}</div>

          <div class="wizard-nav">
            <div>
              ${this.currentStep > 0 ? `<button class="btn-outline" onclick="syncPage.prevStep()"><i data-lucide=\\"arrow-left\\"></i> ${syncEsc(i18n.t('wizard.back'))}</button>` : ''}
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn-ghost" onclick="hideModal()">${syncEsc(i18n.t('taskModal.cancel'))}</button>
              ${this.currentStep < steps.length - 1
                ? `<button class="btn-outline" onclick="syncPage.nextStep()">${syncEsc(i18n.t('wizard.next'))} <i data-lucide=\\"arrow-right\\"></i></button>`
                : `<button class="btn-glow" onclick="syncPage.saveProfile()"><i data-lucide=\\"save\\"></i> ${syncEsc(i18n.t(isEdit ? 'backup.saveChanges' : 'sync.createProfile'))}</button>`}
            </div>
          </div>
        </div>
        <div class="wizard-summary" id="sync-wizard-summary">${this._renderSummary()}</div>
      </div>
    `, true);
    if (window.PathInput) PathInput.attachAll(document.getElementById('modal-body'));
    if (window.lucide) lucide.createIcons();
  }

  _renderSummary() {
    const d = this.draft;
    const r = d.Retention || {};
    const retTxt = r.Enabled
      ? [r.ByAge ? `${r.KeepDays}d` : null, r.ByCount ? `${r.KeepCount}x` : null, r.BySize ? `${r.FreeGb}GB` : null].filter(Boolean).join(' · ')
      : i18n.t('sync.retentionOff');
    const dest = d.Engine === 'local' ? (d.DestPath || '—') : `${d.Host || '?'}:${d.Port || ''} ${d.DestPath || ''}`;
    return `
      <div class="ws-header"><i data-lucide="file-text" style="width:14px;height:14px"></i><span>${syncEsc(i18n.t('summary.title'))}</span></div>
      <div class="ws-section"><div class="ws-label">${syncEsc(i18n.t('summary.name'))}</div><div class="ws-value">${syncEsc(d.Name)}</div></div>
      <div class="ws-section"><div class="ws-label">${syncEsc(i18n.t('sync.origin'))}</div><div class="ws-value ws-mono" style="word-break:break-all">${syncEsc(d.SourcePath) || '—'}</div></div>
      <div class="ws-section"><div class="ws-label">${syncEsc(i18n.t('sync.destination'))}</div><div class="ws-value ws-mono" style="word-break:break-all">${syncEsc(dest)}</div></div>
      <div class="ws-section"><div class="ws-label">${syncEsc(i18n.t('sync.retentionTitle'))}</div><div class="ws-value">${syncEsc(retTxt)}</div></div>
      <div class="ws-section"><div class="ws-label">${syncEsc(i18n.t('summary.schedule'))}</div><div class="ws-value ws-mono">${syncEsc(d.CronExpression) || '—'}</div></div>
      <div class="ws-section"><div class="ws-label">${syncEsc(i18n.t('summary.status'))}</div><div class="ws-value">${d.Enabled !== false ? `<span style="color:var(--green)">&#9679; ${syncEsc(i18n.t('summary.enabled'))}</span>` : `<span style="color:var(--red)">&#9679; ${syncEsc(i18n.t('summary.disabled'))}</span>`}</div></div>
    `;
  }

  _updateSummary() {
    const el = document.getElementById('sync-wizard-summary');
    if (!el) return;
    el.innerHTML = this._renderSummary();
    if (window.lucide) lucide.createIcons();
  }

  _renderStep() {
    const d = this.draft;
    switch (this.currentStep) {

      case 0: return `
        <div class="form-hint" style="margin-bottom:12px">${syncEsc(i18n.t('sync.stepDescFolders'))}</div>
        <label class="form-label">${syncEsc(i18n.t('wizard.profileName'))} *</label>
        <input type="text" class="form-input" id="sync-name" value="${syncEsc(d.Name)}" oninput="syncPage.draft.Name=this.value; syncPage._updateSummary()">

        <label class="form-label" style="margin-top:12px">${syncEsc(i18n.t('sync.origin'))} *</label>
        <div class="input-row">
          <input type="text" class="form-input" id="sync-source" data-path-input data-path-kind="directory" value="${syncEsc(d.SourcePath)}" placeholder="C:\\Dados\\Producao" oninput="syncPage.draft.SourcePath=this.value; syncPage._updateSummary()">
          <button class="btn-outline btn-sm" onclick="syncPage.browse('sync-source')" title="${syncEsc(i18n.t('taskModal.browse'))}"><i data-lucide="folder-open"></i></button>
        </div>

        <label class="form-label" style="margin-top:12px">${syncEsc(i18n.t('sync.destination'))} *</label>
        <select class="form-input" id="sync-engine" onchange="syncPage.changeEngine(this.value)">
          ${(this.engines || []).map(e => `<option value="${e.id}" ${e.id === (d.Engine || 'local') ? 'selected' : ''}>${syncEsc(e.label)}</option>`).join('')}
        </select>
        <div class="input-row" style="margin-top:6px">
          <input type="text" class="form-input" id="sync-dest" value="${syncEsc(d.DestPath)}" placeholder="${d.Engine === 'local' ? 'D:\\Espelho\\Dados' : '/backups/dados'}" oninput="syncPage.draft.DestPath=this.value; syncPage._updateSummary()">
          ${d.Engine === 'local' ? `<button class="btn-outline btn-sm" onclick="syncPage.browse('sync-dest')"><i data-lucide="folder-open"></i></button>` : ''}
        </div>

        ${d.Engine !== 'local' ? `
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-top:10px">
          <div><label class="form-label">${syncEsc(i18n.t('wizard.host'))}</label><input type="text" class="form-input" id="sync-host" value="${syncEsc(d.Host)}" oninput="syncPage.draft.Host=this.value"></div>
          <div><label class="form-label">${syncEsc(i18n.t('wizard.port'))}</label><input type="number" class="form-input" id="sync-port" value="${d.Port || ''}" oninput="syncPage.draft.Port=parseInt(this.value)||null"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
          <div><label class="form-label">${syncEsc(i18n.t('wizard.user'))}</label><input type="text" class="form-input" id="sync-user" value="${syncEsc(d.User)}" oninput="syncPage.draft.User=this.value"></div>
          <div><label class="form-label">${syncEsc(i18n.t('wizard.password'))}</label><input type="password" class="form-input" id="sync-pass" value="${syncEsc(d.Password)}" oninput="syncPage.draft.Password=this.value"></div>
        </div>` : ''}

        <div style="display:flex;gap:8px;margin-top:14px;align-items:center">
          <button class="btn-outline btn-sm" onclick="syncPage.testConn()"><i data-lucide="wifi"></i> ${syncEsc(i18n.t('wizard.testConnection'))}</button>
          <span id="sync-conn-status" style="font-size:12px"></span>
        </div>

        <div class="form-section" style="margin-top:16px">
          <div class="form-section-title"><i data-lucide="copy"></i> ${syncEsc(i18n.t('sync.copyMode'))}</div>
          <label class="check-row"><input type="checkbox" id="sync-mirror" ${d.Mirror ? 'checked' : ''} onchange="syncPage.draft.Mirror=this.checked">
            <span>${syncEsc(i18n.t('sync.mirrorLabel'))}<span class="check-hint">${syncEsc(i18n.t('sync.mirrorHint'))}</span></span></label>
        </div>
      `;

      case 1: {
        const r = d.Retention || {};
        return `
        <div class="form-hint" style="margin-bottom:12px">${syncEsc(i18n.t('sync.stepDescRetention'))}</div>

        <div class="form-section">
          <div class="form-section-title"><i data-lucide="search"></i> ${syncEsc(i18n.t('sync.analyzeTitle'))}</div>
          <div class="form-hint" style="margin:0 0 10px">${syncEsc(i18n.t('sync.analyzeHint'))}</div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn-glow btn-sm" onclick="syncPage.runAnalysis()"><i data-lucide="wand-2"></i> ${syncEsc(i18n.t('sync.analyzeBtn'))}</button>
            <span id="sync-analysis-status" style="font-size:12px"></span>
          </div>
          <div id="sync-analysis-result" style="margin-top:12px">${this._renderAnalysis()}</div>
        </div>

        <div class="form-section">
          <div class="form-section-title"><i data-lucide="scissors"></i> ${syncEsc(i18n.t('sync.retentionTitle'))}</div>
          <label class="check-row" for="sync-ret-enabled">
            <input type="checkbox" id="sync-ret-enabled" ${r.Enabled ? 'checked' : ''} onchange="syncPage._syncRetention()">
            <span>${syncEsc(i18n.t('sync.retentionEnable'))}<span class="check-hint">${syncEsc(i18n.t('sync.retentionEnableHint'))}</span></span>
          </label>

          <div id="sync-ret-rules" style="${r.Enabled ? '' : 'opacity:.4;pointer-events:none;'}margin-top:12px">
            <label class="check-row"><input type="checkbox" id="sync-ret-age" ${r.ByAge ? 'checked' : ''} onchange="syncPage._syncRetention()">
              <span>${syncEsc(i18n.t('sync.retByAge'))} <input type="number" class="form-input" id="sync-ret-days" value="${r.KeepDays || 30}" min="1" max="3650" style="width:80px;display:inline-block;padding:2px 6px" onchange="syncPage._syncRetention()"> ${syncEsc(i18n.t('sync.days'))}</span></label>
            <label class="check-row"><input type="checkbox" id="sync-ret-count" ${r.ByCount ? 'checked' : ''} onchange="syncPage._syncRetention()">
              <span>${syncEsc(i18n.t('sync.retByCount'))} <input type="number" class="form-input" id="sync-ret-count-n" value="${r.KeepCount || 10}" min="1" max="10000" style="width:80px;display:inline-block;padding:2px 6px" onchange="syncPage._syncRetention()"> ${syncEsc(i18n.t('sync.snapshots'))}</span></label>
            <label class="check-row"><input type="checkbox" id="sync-ret-size" ${r.BySize ? 'checked' : ''} onchange="syncPage._syncRetention()">
              <span>${syncEsc(i18n.t('sync.retBySize'))} <input type="number" class="form-input" id="sync-ret-gb" value="${r.FreeGb || 10}" min="1" max="100000" style="width:80px;display:inline-block;padding:2px 6px" onchange="syncPage._syncRetention()"> GB</span></label>

            <div style="margin-top:10px">
              <label class="form-label">${syncEsc(i18n.t('sync.minKeep'))}</label>
              <input type="number" class="form-input" id="sync-ret-minkeep" value="${r.MinKeep != null ? r.MinKeep : 3}" min="0" max="1000" style="width:100px" onchange="syncPage._syncRetention()">
              <div class="form-hint">${syncEsc(i18n.t('sync.minKeepHint'))}</div>
            </div>

            <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
              <button class="btn-outline btn-sm" onclick="syncPage.refreshPreview()"><i data-lucide="eye"></i> ${syncEsc(i18n.t('sync.previewBtn'))}</button>
              <span id="sync-preview-status" style="font-size:12px"></span>
            </div>
            <div id="sync-retention-preview" style="margin-top:10px">${this._renderPreview()}</div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title"><i data-lucide="flask-conical"></i> ${syncEsc(i18n.t('sync.simTitle'))}</div>
          <div class="form-hint" style="margin:0 0 10px">${syncEsc(i18n.t('sync.simHint'))}</div>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn-glow btn-sm" onclick="syncPage.runSimulation()"><i data-lucide="play"></i> ${syncEsc(i18n.t('sync.simBtn'))}</button>
            <span id="sync-sim-status" style="font-size:12px"></span>
          </div>
          <div id="sync-sim-result" style="margin-top:12px">${this._renderSimulation()}</div>
        </div>
      `; }

      case 2: return `
        <div class="form-hint" style="margin-bottom:12px">${syncEsc(i18n.t('sync.stepDescSchedule'))}</div>
        <div class="form-section">
          <div class="form-section-title"><i data-lucide="clock"></i> ${syncEsc(i18n.t('wizard.stepSchedule'))}</div>
          <label class="form-label">${syncEsc(i18n.t('wizard.cronExpression'))}</label>
          <input type="text" class="form-input mono" id="sync-cron" value="${syncEsc(d.CronExpression)}" placeholder="0 3 * * *" style="margin-bottom:6px" oninput="syncPage.draft.CronExpression=this.value; syncPage._updateSummary()">
          <div class="wiz-chips" style="margin-bottom:14px">
            <span class="bp-db-chip" onclick="syncPage._setCron('0 * * * *')">${syncEsc(i18n.t('cron.everyHour'))}</span>
            <span class="bp-db-chip" onclick="syncPage._setCron('0 3 * * *')">${syncEsc(i18n.t('cron.daily2'))}</span>
            <span class="bp-db-chip" onclick="syncPage._setCron('0 2 * * 1-5')">${syncEsc(i18n.t('cron.weekdays'))}</span>
            <span class="bp-db-chip" onclick="syncPage._setCron('*/15 * * * *')">${syncEsc(i18n.t('cron.every15'))}</span>
          </div>
          <div class="form-hint" style="margin-bottom:12px">${syncEsc(i18n.t('sync.triggerHint'))}</div>
          <label class="form-label">${syncEsc(i18n.t('sync.triggerTaskLabel'))}</label>
          <select class="form-input" id="sync-trigger-task" onchange="syncPage.draft.TriggerTaskId=this.value; syncPage._updateSummary()">
            <option value="" ${!d.TriggerTaskId ? 'selected' : ''}>${syncEsc(i18n.t('sync.triggerNone'))}</option>
            ${this.tasks.map(t => `<option value="${syncEsc(t.Id)}" ${d.TriggerTaskId === t.Id ? 'selected' : ''}>${syncEsc(t.Name)}</option>`).join('')}
          </select>
        </div>
        <label class="check-row" for="sync-enabled">
          <input type="checkbox" id="sync-enabled" ${d.Enabled !== false ? 'checked' : ''} onchange="syncPage.draft.Enabled=this.checked">
          <span>${syncEsc(i18n.t('wizard.enableProfile'))}</span>
        </label>
      `;
    }
    return '';
  }

  _renderAnalysis() {
    if (!this.analysis) return '';
    if (this.analysis.ok === false) {
      return `<div class="form-hint" style="color:var(--red)">${syncEsc(this.analysis.error)}</div>`;
    }
    const a = this.analysis;
    const patternLabels = {
      'dated-folders': i18n.t('sync.patternDatedFolders'),
      'dated-files': i18n.t('sync.patternDatedFiles'),
      'mixed': i18n.t('sync.patternMixed'),
      'flat': i18n.t('sync.patternFlat'),
      'empty': i18n.t('sync.patternEmpty'),
    };
    const fmtBytes = (b) => b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
    const s = a.suggested || {};
    return `
      <div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:8px;padding:12px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
          <span class="badge badge-active"><i data-lucide="fingerprint" style="width:11px;height:11px"></i> ${syncEsc(patternLabels[a.folderPattern] || a.folderPattern)}</span>
          <span class="badge badge-info">${a.totalFiles} ${syncEsc(i18n.t('sync.filesCount'))}</span>
          <span class="badge badge-info">${fmtBytes(a.totalBytes || 0)}</span>
          ${a.medianGapDays ? `<span class="badge badge-info">~${a.medianGapDays}d ${syncEsc(i18n.t('sync.medianGap'))}</span>` : ''}
        </div>
        ${a.withDates ? `<div class="form-hint" style="margin:0">${a.withDates}/${a.totalFiles} ${syncEsc(i18n.t('sync.datedFilesFound'))}</div>` : ''}
        ${s.Enabled ? `<div style="margin-top:8px;font-size:12px;color:var(--primary)">
          <i data-lucide="sparkles" style="width:12px;height:12px"></i> ${syncEsc(i18n.t('sync.suggestion'))}:
          ${s.ByAge ? `${syncEsc(i18n.t('sync.retByAge'))} ${s.KeepDays} ${syncEsc(i18n.t('sync.days'))}` : ''}
          ${s.ByCount ? `· ${syncEsc(i18n.t('sync.keepLast'))} ${s.KeepCount}` : ''}
          ${s.BySize ? `· ≤ ${s.FreeGb} GB` : ''}
          <button class="btn-outline btn-sm" style="margin-left:8px" onclick="syncPage.applySuggestion()">✓ ${syncEsc(i18n.t('sync.applySuggestion'))}</button>
        </div>` : ''}
      </div>
    `;
  }

  _renderPreview() {
    if (!this.retentionPreview) return '';
    const p = this.retentionPreview;
    if (p.ok === false) {
      return `<div class="form-hint" style="color:var(--red)">${syncEsc(p.error)}</div>`;
    }
    if (!p.delete || !p.delete.length) {
      return `<div class="form-hint" style="color:var(--green)">✓ ${syncEsc(i18n.t('sync.previewNothing'))}</div>`;
    }
    const rows = p.delete.slice(0, 50).map(x => `
      <div style="display:flex;gap:8px;font-size:11px;padding:2px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--amber)" class="mono">${syncEsc(x.reason)}</span>
        <span class="mono" style="flex:1;word-break:break-all">${syncEsc(x.rel)}</span>
        <span style="color:var(--text3)">${syncEsc(x.detail || '')}</span>
      </div>`).join('');
    return `
      <div style="background:rgba(255,80,80,.05);border:1px solid rgba(255,80,80,.25);border-radius:8px;padding:10px">
        <div style="font-size:12px;color:var(--red);margin-bottom:6px"><i data-lucide="trash-2" style="width:12px;height:12px"></i> ${p.delete.length} ${syncEsc(i18n.t('sync.previewWouldDelete'))}</div>
        <div style="max-height:160px;overflow-y:auto">${rows}</div>
        ${p.delete.length > 50 ? `<div class="form-hint" style="margin-top:4px">+${p.delete.length - 50}…</div>` : ''}
      </div>
    `;
  }

  // ─── Wizard actions ───
  async browse(inputId) {
    const r = await window.api.browseFolder(i18n.t('taskModal.browse'));
    if (r && r.path) {
      const input = document.getElementById(inputId);
      if (input) { input.value = r.path; input.dispatchEvent(new Event('input')); }
    }
  }

  changeEngine(engineId) {
    const prev = (this.engines || []).find(e => e.id === this.draft.Engine);
    const next = (this.engines || []).find(e => e.id === engineId);
    this.draft.Engine = engineId;
    if (next && next.credentials && !this.draft.Port && next.defaultPort) this.draft.Port = next.defaultPort;
    if (prev && prev.credentials && next && !next.credentials) { this.draft.Host = ''; this.draft.Port = null; this.draft.User = ''; this.draft.Password = ''; }
    this._renderWizard();
  }

  async testConn() {
    const el = document.getElementById('sync-conn-status');
    if (el) { el.textContent = '…'; el.style.color = 'var(--amber)'; }
    try {
      const r = await window.api.testSyncConnection(this.draft.Engine, {
        path: this.draft.DestPath, host: this.draft.Host, port: this.draft.Port,
        user: this.draft.User, password: this.draft.Password,
      });
      if (el) {
        el.textContent = r && r.success ? '✓ ' + i18n.t('sync.connOk') : '✗ ' + ((r && r.message) || '?');
        el.style.color = r && r.success ? 'var(--green)' : 'var(--red)';
      }
    } catch (e) {
      if (el) { el.textContent = '✗ ' + e.message; el.style.color = 'var(--red)'; }
    }
  }

  /** The analysis reads the SOURCE: its pattern predicts the destination's. */
  async runAnalysis() {
    const status = document.getElementById('sync-analysis-status');
    if (status) { status.textContent = '…'; status.style.color = 'var(--amber)'; }
    try {
      this.analysis = await window.api.analyzeSyncFolder(this.draft.SourcePath || '');
    } catch (e) {
      this.analysis = { ok: false, error: e.message };
    }
    if (status) status.textContent = '';
    const box = document.getElementById('sync-analysis-result');
    if (box) { box.innerHTML = this._renderAnalysis(); if (window.lucide) lucide.createIcons(); }
  }

  applySuggestion() {
    const s = this.analysis && this.analysis.suggested;
    if (!s) return;
    this.draft.Retention = {
      Enabled: true,
      ByAge: !!s.ByAge, KeepDays: s.KeepDays || 30,
      ByCount: !!s.ByCount, KeepCount: s.KeepCount || 10,
      BySize: !!s.BySize, FreeGb: s.FreeGb || 0,
      MinKeep: s.MinKeep != null ? s.MinKeep : 3,
    };
    this._renderWizard();
    showToast(i18n.t('sync.suggestionApplied'), 'success');
  }

  _syncRetention() {
    const r = this.draft.Retention;
    r.Enabled = document.getElementById('sync-ret-enabled').checked;
    r.ByAge = document.getElementById('sync-ret-age').checked;
    r.KeepDays = parseInt(document.getElementById('sync-ret-days').value, 10) || 30;
    r.ByCount = document.getElementById('sync-ret-count').checked;
    r.KeepCount = parseInt(document.getElementById('sync-ret-count-n').value, 10) || 10;
    r.BySize = document.getElementById('sync-ret-size').checked;
    r.FreeGb = parseFloat(document.getElementById('sync-ret-gb').value) || 0;
    r.MinKeep = parseInt(document.getElementById('sync-ret-minkeep').value, 10) || 0;

    const rules = document.getElementById('sync-ret-rules');
    if (rules) rules.style.cssText = r.Enabled ? '' : 'opacity:.4;pointer-events:none;';
    this._updateSummary();
  }

  /** Live preview: shows exactly what would be deleted, before confirming. */
  async refreshPreview() {
    const status = document.getElementById('sync-preview-status');
    if (status) { status.textContent = '…'; status.style.color = 'var(--amber)'; }
    try {
      this.retentionPreview = await window.api.previewSyncRetention(this.draft.DestPath || '', this.draft.Retention);
    } catch (e) {
      this.retentionPreview = { ok: false, error: e.message };
    }
    if (status) status.textContent = '';
    const box = document.getElementById('sync-retention-preview');
    if (box) { box.innerHTML = this._renderPreview(); if (window.lucide) lucide.createIcons(); }
  }

  // ─── Whole-sync simulator ───
  /** Dry-run through the real planner + retention, zero writes. */
  async runSimulation() {
    const status = document.getElementById('sync-sim-status');
    if (status) { status.textContent = '…'; status.style.color = 'var(--amber)'; }
    try {
      this.simulation = await window.api.previewSyncPlan({
        SourcePath: this.draft.SourcePath, DestPath: this.draft.DestPath,
        Engine: this.draft.Engine, Host: this.draft.Host, Port: this.draft.Port,
        User: this.draft.User, Password: this.draft.Password,
        Mode: this.draft.Mode, Mirror: this.draft.Mirror,
        Excludes: this.draft.Excludes || [], Retention: this.draft.Retention,
      });
    } catch (e) {
      this.simulation = { ok: false, error: e.message };
    }
    if (status) status.textContent = '';
    this._rerenderSim();
  }

  _fmtBytes(b) {
    if (!b) return '0 B';
    if (b > 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b > 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
  }

  _renderSimulation() {
    if (!this.simulation) return `<div class="form-hint" style="margin:0">${syncEsc(i18n.t('sync.simIdle'))}</div>`;
    const s = this.simulation;
    if (s.ok === false) {
      return `<div class="form-hint" style="color:var(--red)">${syncEsc(s.error)}</div>`;
    }
    const tabs = [
      { id: 'copy', label: i18n.t('sync.simCopy'), n: s.copy.length },
      { id: 'skip', label: i18n.t('sync.simSkipped'), n: s.skipped.length },
      { id: 'mirror', label: i18n.t('sync.simMirror'), n: s.delete.length },
      { id: 'retention', label: i18n.t('sync.simRetention'), n: (s.retention || []).length },
    ];
    const list = this.simTab === 'copy' ? s.copy
      : this.simTab === 'skip' ? s.skipped
      : this.simTab === 'mirror' ? s.delete
      : (s.retention || []);
    const rows = list.length
      ? list.slice(0, 200).map(x => `
          <div class="sim-row">
            <span class="sim-row-reason mono">${syncEsc(x.reason || '')}</span>
            <span class="mono sim-row-path">${syncEsc(x.rel)}</span>
            <span class="sim-row-meta">${syncEsc(x.size ? this._fmtBytes(x.size) : '')}</span>
          </div>`).join('')
      : `<div class="form-hint" style="margin:4px 0">${syncEsc(i18n.t('sync.simEmpty'))}</div>`;
    return `
      <div class="sim-box">
        <div class="sim-tabs">
          ${tabs.map(t => `<span class="sim-tab ${t.id === this.simTab ? 'active' : ''} sim-${t.id}" onclick="syncPage.simTab='${t.id}'; syncPage._rerenderSim()">${syncEsc(t.label)} <b>${t.n}</b></span>`).join('')}
        </div>
        <div class="sim-summary">${syncEsc(i18n.t('sync.simTotals', {
          files: s.totalSource, copied: s.copy.length, skipped: s.skipped.length,
          removed: s.delete.length + (s.retention || []).length,
          size: this._fmtBytes(s.totalBytes || 0),
        }))}</div>
        <div class="sim-list">${rows}</div>
        <div class="sim-note">${syncEsc(i18n.t('sync.simNote'))}</div>
      </div>`;
  }

  _rerenderSim() {
    const box = document.getElementById('sync-sim-result');
    if (box) { box.innerHTML = this._renderSimulation(); if (window.lucide) lucide.createIcons(); }
  }

  _setCron(expr) {
    this.draft.CronExpression = expr;
    const input = document.getElementById('sync-cron');
    if (input) input.value = expr;
    this._updateSummary();
  }

  async saveProfile() {
    const d = this.draft;
    if (!d.Name || !d.Name.trim()) { showToast(i18n.t('sync.errName'), 'error'); return; }
    if (!d.SourcePath || !d.SourcePath.trim()) { showToast(i18n.t('sync.errSource'), 'error'); return; }
    if (!d.DestPath || !d.DestPath.trim()) { showToast(i18n.t('sync.errDest'), 'error'); return; }

    const payload = { ...d, Name: d.Name.trim() };
    const saved = this.editingId
      ? await window.api.updateSyncProfile(payload)
      : await window.api.createSyncProfile(payload);

    if (!saved || saved.success === false) {
      showToast((saved && saved.message) || 'Error', 'error');
      return;
    }
    showToast(i18n.t(this.editingId ? 'sync.saved' : 'sync.created', { name: d.Name }), 'success');
    hideModal();
    await this.load();
  }
}

window.syncPage = new SyncPage();

document.getElementById('btn-refresh-sync')?.addEventListener('click', () => syncPage.load());
