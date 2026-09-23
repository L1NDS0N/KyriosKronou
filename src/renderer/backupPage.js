// backupPage.js - Backup Profile Management UI with Step Wizard
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

class BackupPage {
  constructor() {
    this.profiles = [];
    this.editingId = null;
    this.currentStep = 0;
    this.draft = {};
    this.mysqldumpStatus = null;
    this.engines = [];
  }

  async load() {
    try {
      const result = await window.api.getBackupProfiles();
      this.profiles = Array.isArray(result) ? result : [];
    } catch (e) {
      console.error('Failed to load backup profiles:', e);
      this.profiles = [];
    }
    try {
      this.engines = await window.api.getDbEngines();
    } catch (e) {
      // Fall back to MySQL only rather than rendering an empty picker.
      this.engines = [{ id: 'mysql', label: 'MySQL / MariaDB', defaultPort: 3306, formats: null }];
    }
    try {
      this.mysqldumpStatus = await window.api.checkMysqldump();
    } catch (e) {
      this.mysqldumpStatus = null;
    }
    this.render();
    this.renderMysqldumpStatus();
  }

  renderMysqldumpStatus() {
    const el = document.getElementById('mysqldump-status');
    if (!el) return;
    const s = this.mysqldumpStatus;
    if (s && s.found) {
      el.innerHTML = `<span class="badge badge-active" style="font-size:11px"><i data-lucide="check-circle" style="width:12px;height:12px"></i> mysqldump found</span>
        <span class="mysqldump-path">${esc(s.path)}</span>`;
    } else {
      el.innerHTML = `<span class="badge badge-disabled" style="font-size:11px"><i data-lucide="alert-circle" style="width:12px;height:12px"></i> mysqldump not found</span>
        <button class="btn-outline btn-sm" onclick="backupPage.showMysqldumpSetup()"><i data-lucide="settings"></i> Configure</button>`;
    }
    lucide.createIcons();
  }

  async render() {
    const content = document.getElementById('backup-profiles-list');
    const empty = document.getElementById('backup-empty');
    if (!content) return;

    if (this.profiles.length === 0) {
      content.innerHTML = '';
      if (empty) empty.style.display = 'block';
      return;
    }
    if (empty) empty.style.display = 'none';

    // Load stats for all profiles
    const statsMap = {};
    for (const p of this.profiles) {
      try {
        const stats = await window.api.getBackupHistoryStats(p.Id);
        statsMap[p.Id] = stats.stats || {};
      } catch (e) { statsMap[p.Id] = {}; }
    }

    content.innerHTML = this.profiles.map(p => {
      const st = statsMap[p.Id] || {};
      const engine = (this.engines || []).find(e => e.id === (p.Engine || 'mysql'));
      let engineLabel = engine ? engine.label : 'MySQL / MariaDB';
      if ((p.Engine || 'mysql') === 'sqlserver') engineLabel += ' · ' + String(p.BackupFormat || 'bak').toUpperCase();
      return `
      <div class="glass-card backup-profile-card clickable ${p.Enabled ? '' : 'disabled'}"
           onclick="backupPage.editProfile('${p.Id}')" title="${esc(i18n.t('profile.clickToEdit'))}">
        <div class="backup-profile-header">
          <div class="backup-profile-info">
            <h3 class="backup-profile-name">${esc(p.Name)}</h3>
            ${window.RunMonitor ? RunMonitor.runningBadge(p.Id) : ''}
            <span class="badge badge-info">${esc(engineLabel)}</span>
            <span class="badge ${p.Enabled ? 'badge-active' : 'badge-disabled'}">${esc(i18n.t(p.Enabled ? 'profile.active' : 'profile.disabled'))}</span>
            <span class="badge badge-info">${esc(p.Databases?.length ? p.Databases.join(', ') : i18n.t('wizard.allDatabases'))}</span>
            ${p.Compression !== 'none' ? `<span class="badge badge-info" style="font-size:10px">${p.Compression.toUpperCase()} L${p.CompressionLevel}</span>` : ''}
          </div>
          <!-- stopPropagation so an action button never opens the editor too -->
          <div class="backup-profile-actions" onclick="event.stopPropagation()">
            <label class="toggle-switch" title="${esc(i18n.t('tasks.toggleEnabled'))}" style="margin-right:4px">
              <input type="checkbox" ${p.Enabled ? 'checked' : ''} onchange="backupPage.toggleEnabled('${p.Id}', this.checked)">
              <span class="toggle-slider"></span>
            </label>
            <button class="btn-glow btn-sm" onclick="backupPage.runBackup('${p.Id}')"><i data-lucide="play"></i> ${esc(i18n.t('profile.run'))}</button>
            <button class="btn-secondary-sm" onclick="backupPage.showHistory('${p.Id}')" title="${esc(i18n.t('profile.history'))}"><i data-lucide="history"></i></button>
            <button class="btn-secondary-sm" onclick="backupPage.cloneProfile('${p.Id}')" title="${esc(i18n.t('profile.clone'))}"><i data-lucide="copy"></i></button>
            <button class="btn-secondary-sm" onclick="backupPage.exportProfile('${p.Id}')" title="${esc(i18n.t('profile.export'))}"><i data-lucide="download"></i></button>
            <button class="btn-danger" onclick="backupPage.deleteProfile('${p.Id}','${esc(p.Name)}')" title="${esc(i18n.t('profile.delete'))}"><i data-lucide="trash-2"></i></button>
          </div>
        </div>
        <div class="backup-profile-details">
          <div class="backup-detail"><i data-lucide="database"></i> <span>${esc(p.Host)}:${p.Port}</span></div>
          <div class="backup-detail"><i data-lucide="folder"></i> <span>${esc(p.BackupPath)}</span></div>
          <div class="backup-detail"><i data-lucide="clock"></i> <span>${esc(p.CronExpression)}</span></div>
          ${p.UploadTargets.length > 0 ? `<div class="backup-detail"><i data-lucide="upload"></i> <span>${p.UploadTargets.map(t => t.type.toUpperCase()).join(', ')}</span></div>` : ''}
          ${p.LastRun ? `<div class="backup-detail"><i data-lucide="history"></i> <span>Last: ${new Date(p.LastRun).toLocaleString()} \u2014 ${p.LastStatus || '?'}</span></div>` : ''}
          ${st.total > 0 ? `<div class="backup-detail"><i data-lucide="bar-chart"></i> <span>${st.total} runs \u00b7 ${st.success} ok \u00b7 ${st.failed} failed</span></div>` : ''}
        </div>
      </div>
    `}).join('');
    if (window.lucide) lucide.createIcons();
  }

  // ─── mysqldump Setup Modal ───
  showMysqldumpSetup() {
    showModal(`
      <h2><i data-lucide="settings"></i> MySQL Driver Setup</h2>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px">mysqldump is required for MySQL backups. Configure it below.</p>

      <div class="mysqldump-option">
        <h4><i data-lucide="search"></i> Auto-detect</h4>
        <p style="font-size:12px;color:var(--text3)">Scan system PATH, Program Files, XAMPP, WampServer, Laragon, MariaDB, Docker, and environment variables.</p>
        <button class="btn-outline btn-sm" onclick="backupPage.detectMysqldump()"><i data-lucide="refresh-cw"></i> Scan Again</button>
        <span id="detect-result" style="font-size:12px;margin-left:8px"></span>
      </div>

      <div class="mysqldump-option">
        <h4><i data-lucide="folder-open"></i> Set Path Manually</h4>
        <p style="font-size:12px;color:var(--text3)">Point to mysqldump.exe on your system.</p>
        <div style="display:flex;gap:8px;margin-top:8px">
          <input type="text" class="form-input" id="manual-mysqldump-path" data-path-input data-path-kind="file" data-path-ext=".exe" placeholder="C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe" style="flex:1">
          <button class="btn-outline btn-sm" onclick="backupPage.browseMysqldump()"><i data-lucide="folder-open"></i></button>
          <button class="btn-glow btn-sm" onclick="backupPage.setManualPath()">Set</button>
        </div>
        <span id="manual-result" style="font-size:12px;margin-top:4px;display:block"></span>
      </div>

      <div class="mysqldump-option">
        <h4><i data-lucide="download"></i> Download MySQL Tools</h4>
        <p style="font-size:12px;color:var(--text3)">Download MySQL Server binaries (includes mysqldump) from official source.</p>
        <button class="btn-glow btn-sm" onclick="backupPage.downloadMysqldump()"><i data-lucide="download"></i> Download (~450 MB)</button>
        <span id="download-result" style="font-size:12px;margin-left:8px"></span>
      </div>

      <div class="modal-actions">
        <button class="btn-ghost" onclick="hideModal()">Close</button>
      </div>
    `);
    lucide.createIcons();
  }

  async detectMysqldump() {
    const el = document.getElementById('detect-result');
    el.textContent = 'Scanning...';
    el.style.color = 'var(--amber)';
    const result = await window.api.checkMysqldump();
    this.mysqldumpStatus = result;
    if (result.found) {
      el.textContent = `Found: ${result.path}`;
      el.style.color = 'var(--green)';
    } else {
      el.textContent = 'Not found in any common location';
      el.style.color = 'var(--red)';
    }
    this.renderMysqldumpStatus();
  }

  async setManualPath() {
    const input = document.getElementById('manual-mysqldump-path');
    const el = document.getElementById('manual-result');
    const p = input.value.trim();
    if (!p) { el.textContent = 'Enter a path'; el.style.color = 'var(--red)'; return; }
    const result = await window.api.setMysqldumpPath(p);
    if (result) {
      el.textContent = `Set: ${p}`;
      el.style.color = 'var(--green)';
      this.mysqldumpStatus = { found: true, path: p };
      this.renderMysqldumpStatus();
    } else {
      el.textContent = 'File not found at this path';
      el.style.color = 'var(--red)';
    }
  }

  async browseMysqldump() {
    // This would use electron dialog - for now just prompt
    const path = prompt('Enter mysqldump.exe path:');
    if (path) {
      document.getElementById('manual-mysqldump-path').value = path;
      this.setManualPath();
    }
  }

  async downloadMysqldump() {
    const el = document.getElementById('download-result');
    el.textContent = 'Downloading... this may take a few minutes';
    el.style.color = 'var(--amber)';
    const result = await window.api.downloadMysqldump();
    if (result.success) {
      el.textContent = `Installed: ${result.path}`;
      el.style.color = 'var(--green)';
      this.mysqldumpStatus = { found: true, path: result.path };
      this.renderMysqldumpStatus();
    } else {
      el.textContent = `Failed: ${result.message}`;
      el.style.color = 'var(--red)';
    }
  }

  // ─── Profile Wizard ───
  showCreateModal() {
    this.editingId = null;
    this.currentStep = 0;
    this.draft = {
      Name: 'MySQL Backup ' + (this.profiles.length + 1), Host: 'localhost', Port: 3306, User: 'root', Password: '',
      Databases: [], BackupPath: '', NamingPattern: '{database}_{date}_{time}',
      Compression: 'none', CompressionLevel: 5, ExtraArgs: '--single-transaction --routines --triggers --events',
      UploadTargets: [], KeepLocal: true, KeepDays: 7, CronExpression: '0 2 * * *', Enabled: true
    };
    this._renderWizard();
  }

  /** Enable or disable a profile straight from the list. */
  async toggleEnabled(id, enabled) {
    const profile = this.profiles.find(x => x.Id === id);
    if (!profile) return;
    const result = await window.api.updateBackupProfile({ Id: id, Enabled: enabled });
    if (result === null || (result && result.success === false)) {
      showToast((result && result.message) || i18n.t('profile.cloneFailed'), 'error');
      return;
    }
    profile.Enabled = enabled;
    showToast(i18n.t(enabled ? 'profile.enabledToast' : 'profile.disabledToast', { name: profile.Name }), 'info');
    this.render();
  }

  /**
   * Duplicate a profile. The copy is created disabled so a clone made to be
   * tweaked cannot start running on the original's schedule before it is ready.
   */
  async cloneProfile(id) {
    const source = this.profiles.find(x => x.Id === id);
    if (!source) return;

    const copy = { ...source };
    delete copy.Id;
    copy.Name = this._nextCopyName(source.Name);
    copy.Enabled = false;
    copy.LastRun = null;
    copy.LastStatus = null;

    const created = await window.api.createBackupProfile(copy);
    if (!created || created.success === false) {
      showToast((created && created.message) || i18n.t('profile.cloneFailed'), 'error');
      return;
    }
    showToast(i18n.t('profile.cloned', { name: copy.Name }), 'success');
    await this.loadProfiles();
    // Open the copy straight away - duplicating is almost always a prelude to editing.
    this.editProfile(created.Id);
  }

  /** "Nightly" -> "Nightly (cópia)" -> "Nightly (cópia 2)" ... */
  _nextCopyName(baseName) {
    const suffix = i18n.t('profile.copySuffix');
    const base = String(baseName || 'Profile').replace(/\s*\([^)]*\)$/, '');
    const taken = new Set(this.profiles.map(p => p.Name));
    let candidate = `${base} (${suffix})`;
    let n = 2;
    while (taken.has(candidate)) candidate = `${base} (${suffix} ${n++})`;
    return candidate;
  }

  /** Switching engine resets the port to that engine's default, unless the
   *  user had already moved it off the previous engine's default. */
  changeEngine(engineId) {
    const list = this.engines || [];
    const previous = list.find(e => e.id === (this.draft.Engine || 'mysql'));
    const next = list.find(e => e.id === engineId);
    if (!next) return;

    if (!this.draft.Port || (previous && this.draft.Port === previous.defaultPort)) {
      this.draft.Port = next.defaultPort;
    }
    this.draft.Engine = engineId;
    if (next.formats && !this.draft.BackupFormat) this.draft.BackupFormat = next.formats[0].id;
    // Databases picked for the old engine mean nothing for the new one.
    this.draft.Databases = [];
    this._renderWizard();
  }

  changeFormat(formatId) {
    this.draft.BackupFormat = formatId;
    this._renderWizard();
  }

  editProfile(id) {
    const p = this.profiles.find(x => x.Id === id);
    if (!p) return;
    this.editingId = id;
    this.currentStep = 0;
    this.draft = { ...p };
    this._renderWizard();
  }

  _renderWizard() {
    const isEdit = !!this.editingId;
    const steps = [i18n.t('wizard.stepConnection'), i18n.t('wizard.stepDatabases'), i18n.t('wizard.stepDestination'), i18n.t('wizard.stepUpload'), i18n.t('wizard.stepSchedule')];
    const stepIcons = ['database', 'list', 'hard-drive', 'upload', 'clock'];

    showModal(`
      <div class="wizard-layout">
        <div class="wizard-main">
          <h2><i data-lucide="${isEdit ? 'pencil' : 'plus-circle'}"></i> ${esc(i18n.t(isEdit ? 'wizard.editTitle' : 'wizard.newTitle'))}</h2>

          <div class="wizard-tabs">
            ${steps.map((s, i) => `
              <div class="wizard-tab ${i === this.currentStep ? 'active' : ''} ${i < this.currentStep ? 'completed' : ''}" onclick="backupPage.goStep(${i})">
                <div class="wizard-tab-num">${i < this.currentStep ? '<i data-lucide=\"check\" style=\"width:12px;height:12px\"></i>' : (i + 1)}</div>
                <span class="wizard-tab-label">${s}</span>
              </div>
            `).join('')}
          </div>

          <div class="wizard-content" id="wizard-content">
            ${this._renderStepContent()}
          </div>

          <div class="wizard-nav">
            <div>
              ${this.currentStep > 0 ? `<button class="btn-outline" onclick="backupPage.prevStep()"><i data-lucide=\"arrow-left\"></i> ${esc(i18n.t("wizard.back"))}</button>` : ''}
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn-ghost" onclick="hideModal()">${esc(i18n.t('taskModal.cancel'))}</button>
              ${isEdit ? `<button class=\"btn-glow\" onclick=\"backupPage.saveProfile()\"><i data-lucide=\"save\"></i> Save</button>` : ''}
              ${this.currentStep < steps.length - 1
                ? `<button class=\"btn-outline\" onclick=\"backupPage.nextStep()\">${esc(i18n.t('wizard.next'))} <i data-lucide=\"arrow-right\"></i></button>`
                : `<button class=\"btn-glow\" onclick=\"backupPage.saveProfile()\"><i data-lucide=\"save\"></i> Create Profile</button>`}
            </div>
          </div>
        </div>
        <div class="wizard-summary" id="wizard-summary">
          ${this._renderFloatingSummary()}
        </div>
      </div>
    `, true);
    lucide.createIcons();
  }

  _renderFloatingSummary() {
    const d = this.draft;
    const dbs = (d.Databases || []).length > 0 ? d.Databases.join(', ') : i18n.t('wizard.allDatabases');
    const uploads = (d.UploadTargets || []).length > 0 ? d.UploadTargets.map(t => t.type.toUpperCase()).join(', ') : 'None';
    return `
      <div class="ws-header">
        <i data-lucide="file-text" style="width:14px;height:14px"></i>
        <span>${esc(i18n.t('summary.title'))}</span>
      </div>
      <div class="ws-section">
        <div class="ws-label">${esc(i18n.t('summary.name'))}</div>
        <div class="ws-value">${esc(d.Name) || `<em style="color:var(--text3)">${esc(i18n.t('summary.notSet'))}</em>`}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">${esc(i18n.t('summary.connection'))}</div>
        <div class="ws-value ws-mono">${esc(d.Host || 'localhost')}:${d.Port || 3306}</div>
        <div class="ws-sub">${esc(d.User || 'root')}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">${esc(i18n.t('summary.databases'))}</div>
        <div class="ws-value">${esc(dbs)}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">${esc(i18n.t('summary.destination'))}</div>
        <div class="ws-value ws-mono" style="word-break:break-all">${esc(d.BackupPath) || `<em style="color:var(--text3)">${esc(i18n.t('summary.notSet'))}</em>`}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">${esc(i18n.t('summary.compression'))}</div>
        <div class="ws-value">${d.Compression && d.Compression !== 'none' ? `${d.Compression.toUpperCase()} ${esc(i18n.t('summary.level'))} ${d.CompressionLevel || 5}` : esc(i18n.t('wizard.compressNone'))}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">${esc(i18n.t('summary.upload'))}</div>
        <div class="ws-value">${esc(uploads)}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">${esc(i18n.t('summary.schedule'))}</div>
        <div class="ws-value ws-mono">${esc(d.CronExpression) || '* * * * *'}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">${esc(i18n.t('summary.status'))}</div>
        <div class="ws-value">${d.Enabled !== false ? `<span style="color:var(--green)">&#9679; ${esc(i18n.t('summary.enabled'))}</span>` : `<span style="color:var(--red)">&#9679; ${esc(i18n.t('summary.disabled'))}</span>`}</div>
      </div>
    `;
  }

  _updateFloatingSummary() {
    const el = document.getElementById('wizard-summary');
    if (!el) return;
    el.innerHTML = this._renderFloatingSummary();
    lucide.createIcons();
  }


  _renderStepContent() {
    const d = this.draft;
    switch (this.currentStep) {
      case 0: {
      const engineId = d.Engine || 'mysql';
      const engineList = this.engines || [];
      const engineDef = engineList.find(e => e.id === engineId);
      const formats = (engineDef && engineDef.formats) || null;
      return `
        <label class="form-label">${esc(i18n.t('wizard.profileName'))} *</label>
        <input type="text" class="form-input" id="wiz-name" value="${esc(d.Name)}" placeholder="${esc(i18n.t('taskModal.namePlaceholder'))}" oninput="backupPage.draft.Name=this.value; backupPage._updateFloatingSummary()">

        <label class="form-label">${esc(i18n.t('wizard.engine'))}</label>
        <select class="form-input" id="wiz-engine" onchange="backupPage.changeEngine(this.value)">
          ${engineList.map(e => `<option value="${e.id}" ${e.id === engineId ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}
        </select>

        ${formats ? `
        <label class="form-label" style="margin-top:12px">${esc(i18n.t('wizard.format'))}</label>
        <select class="form-input" id="wiz-format" onchange="backupPage.changeFormat(this.value)">
          ${formats.map(f => `<option value="${f.id}" ${f.id === (d.BackupFormat || 'bak') ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}
        </select>
        <div class="form-hint" id="wiz-format-hint">${esc((formats.find(f => f.id === (d.BackupFormat || 'bak')) || formats[0]).description)}</div>
        ` : ''}

        <label class="form-label" style="margin-top:12px">${esc(i18n.t('wizard.connection'))}</label>
        <div style="display:grid;grid-template-columns:1fr 80px;gap:8px">
          <div class="form-group"><label class="form-label">${esc(i18n.t('wizard.host'))}</label><input type="text" class="form-input" id="wiz-host" value="${esc(d.Host)}" oninput="backupPage.draft.Host=this.value; backupPage._updateFloatingSummary()"></div>
          <div class="form-group"><label class="form-label">${esc(i18n.t('wizard.port'))}</label><input type="number" class="form-input" id="wiz-port" value="${d.Port}" oninput="backupPage.draft.Port=parseInt(this.value)||3306; backupPage._updateFloatingSummary()"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="form-group"><label class="form-label">${esc(i18n.t('wizard.user'))}</label><input type="text" class="form-input" id="wiz-user" value="${esc(d.User)}" oninput="backupPage.draft.User=this.value"></div>
          <div class="form-group"><label class="form-label">${esc(i18n.t('wizard.password'))}</label><input type="password" class="form-input" id="wiz-pass" value="${esc(d.Password)}" oninput="backupPage.draft.Password=this.value"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn-outline btn-sm" onclick="backupPage.testWizardConn()"><i data-lucide="wifi"></i> ${esc(i18n.t('wizard.testConnection'))}</button>
          <span id="wiz-conn-status" style="font-size:12px;display:flex;align-items:center"></span>
        </div>
      `; }

      case 1: return `
        <div class="form-section">
          <div class="form-section-title"><i data-lucide="database"></i> ${esc(i18n.t('wizard.stepDatabases'))}</div>

          <div class="wiz-db-head">
            <div class="form-hint" style="margin:0">${esc(i18n.t('wizard.databasesHint'))}</div>
            <button class="btn-outline btn-sm" onclick="backupPage.loadWizardDbs()">
              <i data-lucide="refresh-cw"></i> ${esc(i18n.t('wizard.loadDatabases'))}
            </button>
          </div>
          <div id="wiz-db-status" class="form-hint"></div>

          <div id="wiz-db-chips" class="bp-db-list">${
            (d.Databases || []).length
              ? (d.Databases).map(db => `
              <label class="bp-db-check-row">
                <input type="checkbox" class="bp-db-check" data-db="${esc(db)}" checked onchange="backupPage._syncDbs()">
                <span class="bp-db-check-name">${esc(db)}</span>
              </label>`).join('')
              : `<div class="bp-db-empty">${esc(i18n.t('wizard.noDatabasesLoaded'))}</div>`
          }</div>

          <div id="wiz-db-all-label" class="wiz-db-summary">${
            (!d.Databases || d.Databases.length === 0)
              ? '✓ ' + esc(i18n.t('wizard.allDatabasesNote'))
              : esc(i18n.t('wizard.selectedCount', { n: d.Databases.length }))
          }</div>
        </div>
      `;

      case 2: return `
        <div class="form-section">
          <div class="form-section-title"><i data-lucide="folder"></i> ${esc(i18n.t('wizard.destination'))}</div>
          <div class="input-row">
            <input type="text" class="form-input" id="wiz-path" data-path-input data-path-kind="directory" value="${esc(d.BackupPath)}" placeholder="C:\\Backups\\MySQL" oninput="backupPage.draft.BackupPath=this.value; backupPage._updateFloatingSummary()">
            <button class="btn-outline btn-sm" onclick="backupPage.browseBackupPath()" title="${esc(i18n.t('taskModal.browse'))}"><i data-lucide="folder-open"></i></button>
          </div>

          <div class="form-group" style="margin-top:14px">
            <label class="form-label">${esc(i18n.t('wizard.fileNaming'))}</label>
            <input type="text" class="form-input" id="wiz-naming" value="${esc(d.NamingPattern)}" oninput="backupPage.draft.NamingPattern=this.value">
            <div class="wiz-chips">
              ${['{database}', '{date}', '{time}', '{timestamp}'].map(token =>
                `<span class="bp-db-chip" onclick="backupPage._insertPlaceholder('${token}')">${token}</span>`).join('')}
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title"><i data-lucide="archive"></i> ${esc(i18n.t('wizard.compression'))}</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">${esc(i18n.t('wizard.compressionFormat'))}</label>
              <select class="form-input" id="wiz-compress" onchange="backupPage.draft.Compression=this.value">
                <option value="none" ${d.Compression === 'none' ? 'selected' : ''}>${esc(i18n.t('wizard.compressNone'))}</option>
                <option value="zip" ${d.Compression === 'zip' ? 'selected' : ''}>ZIP</option>
                <option value="7z" ${d.Compression === '7z' ? 'selected' : ''}>${esc(i18n.t('wizard.compress7z'))}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">${esc(i18n.t('wizard.compressionLevel'))} <span id="wiz-level-value">${d.CompressionLevel}</span></label>
              <input type="range" min="1" max="9" value="${d.CompressionLevel}"
                     oninput="backupPage.draft.CompressionLevel=parseInt(this.value); document.getElementById('wiz-level-value').textContent=this.value">
            </div>
          </div>
        </div>

        <div class="form-section">
          <div class="form-section-title"><i data-lucide="sliders-horizontal"></i> ${esc(i18n.t('wizard.mysqlOptions'))}</div>
        <div class="mysql-opts-grid">
          <label class="mysql-opt"><input type="checkbox" id="opt-st" ${d.ExtraArgs?.includes('single-transaction') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Single Transaction</span><small>${esc(i18n.t('wizard.optSingleTransaction'))}</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-routines" ${d.ExtraArgs?.includes('routines') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Routines</span><small>${esc(i18n.t('wizard.optRoutines'))}</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-triggers" ${d.ExtraArgs?.includes('triggers') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Triggers</span><small>${esc(i18n.t('wizard.optTriggers'))}</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-events" ${d.ExtraArgs?.includes('events') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Events</span><small>${esc(i18n.t('wizard.optEvents'))}</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-locktables" ${d.ExtraArgs?.includes('lock-tables') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Lock Tables</span><small>${esc(i18n.t('wizard.optLockTables'))}</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-add-drop" ${d.ExtraArgs?.includes('add-drop-table') !== false && d.ExtraArgs?.includes('no-add-drop') === false ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Add DROP TABLE</span><small>${esc(i18n.t('wizard.optAddDrop'))}</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-create-db" ${d.ExtraArgs?.includes('databases') || d.ExtraArgs?.includes('all-databases') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Create Database</span><small>${esc(i18n.t('wizard.optCreateDb'))}</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-compress" ${d.ExtraArgs?.includes('compress') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Compress Protocol</span><small>${esc(i18n.t('wizard.optCompress'))}</small></label>
        </div>
          <details class="wiz-advanced"><summary>${esc(i18n.t('wizard.advancedArgs'))}</summary>
            <input type="text" class="form-input mono" id="wiz-args" value="${esc(d.ExtraArgs)}" oninput="backupPage.draft.ExtraArgs=this.value" placeholder="--single-transaction --routines">
          </details>

        </div>

        <div class="form-section">
          <div class="form-section-title"><i data-lucide="hard-drive"></i> ${esc(i18n.t('wizard.localStorage'))}</div>
          <label class="check-row" for="wiz-keeplocal">
            <input type="checkbox" id="wiz-keeplocal" ${d.KeepLocal !== false ? 'checked' : ''} onchange="backupPage.draft.KeepLocal=this.checked">
            <span>${esc(i18n.t('wizard.keepLocal'))}
              <span class="check-hint">${esc(i18n.t('wizard.keepLocalHint'))}</span>
            </span>
          </label>
          <div class="form-group" style="margin-top:12px;max-width:220px">
            <label class="form-label">${esc(i18n.t('wizard.keepDays'))}</label>
            <input type="number" class="form-input" id="wiz-keepdays" value="${d.KeepDays || 7}" min="1" max="365" oninput="backupPage.draft.KeepDays=parseInt(this.value)||7">
          </div>
        </div>
      `;

      case 3: return `
        <div class="form-section">
          <div class="form-section-title"><i data-lucide="upload"></i> ${esc(i18n.t('wizard.uploadTargets'))}</div>
          <div class="form-hint" style="margin:0 0 12px">${esc(i18n.t('wizard.uploadHint'))}</div>
          <div id="wiz-targets">${(d.UploadTargets || []).map((t, i) => this._renderTarget(t, i)).join('')}</div>
          <div class="wiz-target-add">
            <button class="btn-outline btn-sm" onclick="backupPage.addTarget('ftp')"><i data-lucide="globe"></i> FTP</button>
            <button class="btn-outline btn-sm" onclick="backupPage.addTarget('sftp')"><i data-lucide="lock"></i> SFTP</button>
            <button class="btn-outline btn-sm" onclick="backupPage.addTarget('smb')"><i data-lucide="hard-drive"></i> SMB/NAS</button>
          </div>
        </div>
      `;

      case 4: return `
        <div class="form-section">
          <div class="form-section-title"><i data-lucide="clock"></i> ${esc(i18n.t('wizard.stepSchedule'))}</div>
        <label class="form-label">${esc(i18n.t('wizard.cronExpression'))}</label>
        <input type="text" class="form-input mono" id="wiz-cron" value="${esc(d.CronExpression)}" oninput="backupPage.draft.CronExpression=this.value; backupPage._validateCron(this.value); backupPage._updateFloatingSummary()" placeholder="0 2 * * *" style="margin-bottom:6px;font-size:14px;letter-spacing:1px">
        <div id="cron-validator" style="margin-bottom:8px;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.02);border:1px solid var(--border);font-size:11px;min-height:36px">
          ${this._renderCronBreakdown(d.CronExpression)}
        </div>
        <div class="wiz-chips" style="margin-bottom:16px">
          <span class="bp-db-chip" onclick="backupPage._setCron('0 * * * *')">${esc(i18n.t('cron.everyHour'))}</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('0 2 * * *')">${esc(i18n.t('cron.daily2'))}</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('0 2 * * 1-5')">${esc(i18n.t('cron.weekdays'))}</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('0 2 * * 0')">${esc(i18n.t('cron.weeklySunday'))}</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('0 2 1 * *')">${esc(i18n.t('cron.monthly1st'))}</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('*/15 * * * *')">${esc(i18n.t('cron.every15'))}</span>
        </div>

        <label class="check-row" for="wiz-enabled">
          <input type="checkbox" id="wiz-enabled" ${d.Enabled !== false ? 'checked' : ''} onchange="backupPage.draft.Enabled=this.checked">
          <span>${esc(i18n.t('wizard.enableProfile'))}</span>
        </label>
        </div>
      `;
    }
  }

  addTarget(type) {
    const container = document.getElementById('wiz-targets');
    if (!container) return;
    const idx = container.children.length;
    const t = { type: type || 'ftp', host: '', user: '', password: '', path: '' };
    this.draft.UploadTargets.push(t);
    container.insertAdjacentHTML('beforeend', this._renderTarget(t, idx));
    lucide.createIcons();
  }

  _renderTarget(t, i) {
    const isSmb = t.type === 'smb';
    const defaultPort = t.type === 'sftp' ? 22 : t.type === 'smb' ? 445 : 21;
    const port = t.port || defaultPort;
    return `
      <div class="bp-target-card" data-idx="${i}" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <select class="form-input" id="wiz-t-type-${i}" onchange="backupPage.toggleTargetFields(${i})" style="width:90px">
            <option value="ftp" ${t.type==='ftp'?'selected':''}>FTP</option>
            <option value="sftp" ${t.type==='sftp'?'selected':''}>SFTP</option>
            <option value="smb" ${t.type==='smb'?'selected':''}>SMB/NAS</option>
          </select>
          <span style="flex:1"></span>
          <button class="btn-outline btn-sm" onclick="backupPage.testTarget(${i})" title="Test Connection"><i data-lucide="wifi"></i> Test</button>
          <button class="btn-danger btn-sm" onclick="this.closest('.bp-target-card').remove(); backupPage._syncTargets()" title="Remove"><i data-lucide="trash-2"></i></button>
        </div>
        <div style="display:grid;grid-template-columns:1fr;gap:6px">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:6px">
            <div>
              <label class="form-label" style="margin-bottom:2px;font-size:10px">Host</label>
              <input type="text" class="form-input" id="wiz-t-host-${i}" value="${esc(t.host || t.url || '')}" placeholder="ftp.example.com" oninput="backupPage._syncTargets()">
            </div>
            <div>
              <label class="form-label" style="margin-bottom:2px;font-size:10px">Port</label>
              <input type="number" class="form-input" id="wiz-t-port-${i}" value="${port}" min="1" max="65535" oninput="backupPage._syncTargets()">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <div>
              <label class="form-label" style="margin-bottom:2px;font-size:10px">User ${isSmb ? '<span style="color:var(--text3)">(optional for local shares)</span>' : ''}</label>
              <input type="text" class="form-input" id="wiz-t-user-${i}" value="${esc(t.user || '')}" placeholder="${isSmb ? 'DOMAIN\\user or .\\user' : 'username'}" oninput="backupPage._syncTargets()">
            </div>
            <div>
              <label class="form-label" style="margin-bottom:2px;font-size:10px">Password</label>
              <input type="password" class="form-input" id="wiz-t-pass-${i}" value="${esc(t.password || '')}" placeholder="password" oninput="backupPage._syncTargets()">
            </div>
          </div>
          <div>
            <label class="form-label" style="margin-bottom:2px;font-size:10px">${isSmb ? 'Network Path' : 'Remote Path'}</label>
            <input type="text" class="form-input" id="wiz-t-path-${i}" value="${esc(t.path || '')}" placeholder="${isSmb ? '\\\\server\\share\\folder' : '/backups/'}" oninput="backupPage._syncTargets()">
          </div>
          ${isSmb ? '<p style="font-size:10px;color:var(--text3);margin-top:2px">Use <code>.\\user</code> for local or <code>DOMAIN\\user</code> for domain auth. Leave empty for anonymous.</p>' : ''}
        </div>
        <div id="wiz-t-result-${i}" style="margin-top:6px;font-size:11px;display:none"></div>
      </div>
    `;
  }

  toggleTargetFields(i) {
    const type = document.getElementById(`wiz-t-type-${i}`)?.value;
    this._syncTargets();
    // Re-render the target card with new type
    const card = document.querySelector(`.bp-target-card[data-idx='${i}']`);
    if (card) {
      const t = this.draft.UploadTargets[i] || { type, host: '', user: '', password: '', path: '' };
      t.type = type;
      this.draft.UploadTargets[i] = t;
      const tmp = document.createElement('div');
      tmp.innerHTML = this._renderTarget(t, i);
      card.replaceWith(tmp.firstElementChild);
      lucide.createIcons();
    }
  }

  async browseBackupPath() {
    const result = await window.api.browseFolder('Select Backup Destination');
    if (result && result.path) {
      this.draft.BackupPath = result.path;
      const el = document.getElementById('wiz-path');
      if (el) el.value = result.path;
    }
  }

  async testTarget(i) {
    const type = document.getElementById(`wiz-t-type-${i}`)?.value;
    const host = document.getElementById(`wiz-t-host-${i}`)?.value;
    const port = parseInt(document.getElementById(`wiz-t-port-${i}`)?.value) || (type === 'sftp' ? 22 : type === 'smb' ? 445 : 21);
    const user = document.getElementById(`wiz-t-user-${i}`)?.value;
    const pass = document.getElementById(`wiz-t-pass-${i}`)?.value;
    const path = document.getElementById(`wiz-t-path-${i}`)?.value;
    const resultEl = document.getElementById(`wiz-t-result-${i}`);
    if (!host) { if (resultEl) { resultEl.style.display='block'; resultEl.innerHTML='<span style="color:var(--red)">Host is required</span>'; } return; }
    if (resultEl) { resultEl.style.display='block'; resultEl.innerHTML='<span style="color:var(--text3)">Testing connection...</span>'; }
    try {
      if (type === 'ftp') {
        const r = await window.api.testFtpConnection({ host, port, user, password: pass, path: path || '/' });
        if (resultEl) resultEl.innerHTML = r.success
          ? `<span style="color:var(--green)">&#10003; Connected successfully</span>`
          : `<span style="color:var(--red)">&#10007; ${esc(r.message || 'Connection failed')}</span>`;
      } else if (type === 'sftp') {
        const r = await window.api.testSftpConnection({ host, port, user, password: pass, path: path || '/' });
        if (resultEl) resultEl.innerHTML = r.success
          ? `<span style="color:var(--green)">&#10003; Connected successfully</span>`
          : `<span style="color:var(--red)">&#10007; ${esc(r.message || 'Connection failed')}</span>`;
      } else {
        const r = await window.api.testSmbConnection({ host, port, user, password: pass, path: path || '' });
        if (resultEl) resultEl.innerHTML = r.success
          ? `<span style="color:var(--green)">&#10003; ${esc(r.message || 'Path accessible')}</span>`
          : `<span style="color:var(--red)">&#10007; ${esc(r.message || 'Cannot access path')}</span>`;
      }
    } catch (err) {
      if (resultEl) resultEl.innerHTML = `<span style="color:var(--red)">&#10007; ${esc(err.message)}</span>`;
    }
  }

  _syncTargets() {
    const targets = [];
    document.querySelectorAll('.bp-target-card').forEach(row => {
      const i = row.dataset.idx;
      targets.push({
        type: document.getElementById(`wiz-t-type-${i}`)?.value || 'ftp',
        host: document.getElementById(`wiz-t-host-${i}`)?.value || '',
        port: parseInt(document.getElementById(`wiz-t-port-${i}`)?.value) || 21,
        user: document.getElementById(`wiz-t-user-${i}`)?.value || '',
        password: document.getElementById(`wiz-t-pass-${i}`)?.value || '',
        path: document.getElementById(`wiz-t-path-${i}`)?.value || ''
      });
    });
    this.draft.UploadTargets = targets;
  }

  _syncDbs() {
    const dbs = [];
    document.querySelectorAll('#wiz-db-chips .bp-db-check').forEach(c => { if (c.checked) dbs.push(c.dataset.db); });
    this.draft.Databases = dbs;
    // Update 'all selected' label
    const label = document.getElementById('wiz-db-all-label');
    if (label) {
      const total = document.querySelectorAll('#wiz-db-chips .bp-db-check').length;
      label.textContent = dbs.length === 0 ? `\u2713 All databases will be backed up` : i18n.t('wizard.selectedOf', { n: dbs.length, total });
    }
  }

  _insertPlaceholder(ph) {
    const input = document.getElementById('wiz-naming');
    if (input) {
      input.value = input.value + ph;
      this.draft.NamingPattern = input.value;
    }
  }

  _syncMysqlOpts() {
    const opts = [];
    if (document.getElementById('opt-st')?.checked) opts.push('--single-transaction');
    if (document.getElementById('opt-routines')?.checked) opts.push('--routines');
    if (document.getElementById('opt-triggers')?.checked) opts.push('--triggers');
    if (document.getElementById('opt-events')?.checked) opts.push('--events');
    if (document.getElementById('opt-locktables')?.checked) opts.push('--lock-tables');
    if (document.getElementById('opt-add-drop')?.checked) opts.push('--add-drop-table');
    if (document.getElementById('opt-create-db')?.checked) opts.push('--databases');
    if (document.getElementById('opt-compress')?.checked) opts.push('--compress');
    // Append any custom args from the advanced input
    const customInput = document.getElementById('wiz-args');
    const custom = customInput?.value?.trim() || '';
    if (custom) opts.push(custom);
    this.draft.ExtraArgs = opts.join(' ');
  }

  goStep(n) {
    this._syncCurrentStep();
    this.currentStep = n;
    this._renderWizard();
    // Auto-load databases when entering step 1
    if (n === 1 && this.draft.Host && this.draft.User) {
      const chipContainer = document.getElementById('wiz-db-chips');
      if (chipContainer && chipContainer.children.length === 0) {
        this.loadWizardDbs();
      }
    }
  }

  nextStep() {
    this._syncCurrentStep();
    if (this.currentStep === 0 && !this.draft.Name) {
      showToast('Profile name is required', 'error'); return;
    }
    if (this.currentStep < 4) {
      this.currentStep++;
      this._renderWizard();
      // Auto-load databases when entering step 1
      if (this.currentStep === 1 && this.draft.Host && this.draft.User) {
        setTimeout(() => this.loadWizardDbs(), 100);
      }
    }
  }

  prevStep() {
    this._syncCurrentStep();
    if (this.currentStep > 0) {
      this.currentStep--;
      this._renderWizard();
    }
  }

  _syncCurrentStep() {
    const d = this.draft;
    // Only sync DBs if we're on step 1 (Databases) — otherwise the checkboxes don't exist in DOM
    if (this.currentStep === 1) this._syncDbs();
    // Only sync targets if we're on step 3 (Upload)
    if (this.currentStep === 3) this._syncTargets();
    // Sync all other inputs from current step
    document.querySelectorAll('[id^="wiz-"]').forEach(el => {
      const key = el.id.replace('wiz-', '');
      // Skip db/target sync elements — handled above
      if (key === 'db-chips' || key.startsWith('t-')) return;
      if (el.type === 'checkbox') d[key.charAt(0).toUpperCase() + key.slice(1)] = el.checked;
      else if (el.type === 'number' || el.type === 'range') d[key.charAt(0).toUpperCase() + key.slice(1)] = parseInt(el.value) || 0;
      else d[key.charAt(0).toUpperCase() + key.slice(1)] = el.value;
    });
    this._updateFloatingSummary();
  }

  async testWizardConn() {
    const status = document.getElementById('wiz-conn-status');
    status.innerHTML = '<span style="color:var(--amber)">Testing...</span>';
    const result = await window.api.testMysqlConnection(this.draft.Host, this.draft.Port, this.draft.User, this.draft.Password);
    status.innerHTML = result.success
      ? '<span style="color:var(--green)">✓ Connected</span>'
      : `<span style="color:var(--red)">✕ ${esc(result.message)}</span>`;
  }

  async loadWizardDbs() {
    const status = document.getElementById('wiz-db-status');
    status.textContent = 'Loading...';
    const result = await window.api.listMysqlDatabases(this.draft.Host, this.draft.Port, this.draft.User, this.draft.Password);
    const container = document.getElementById('wiz-db-chips');
    if (result.success && result.databases.length > 0) {
      const selected = this.draft.Databases || [];
      container.innerHTML = result.databases.map(d =>
        `<label class="bp-db-check-row">
          <input type="checkbox" class="bp-db-check" data-db="${esc(d)}" ${selected.includes(d) ? 'checked' : ''} onchange="backupPage._syncDbs()">
          <span class="bp-db-check-box"></span>
          <span class="bp-db-check-name">${esc(d)}</span>
        </label>`
      ).join('');
      status.textContent = `Found ${result.databases.length} databases`;
    } else {
      status.textContent = result.message || 'No databases found';
    }
    this._syncDbs();
  }

  _setCron(value) {
    this.draft.CronExpression = value;
    const el = document.getElementById('wiz-cron');
    if (el) el.value = value;
    this._validateCron(value);
  }

  _validateCron(value) {
    this.draft.CronExpression = value;
    const container = document.getElementById('cron-validator');
    if (!container) return;
    container.innerHTML = this._renderCronBreakdown(value);
  }

  _renderCronBreakdown(expr) {
    if (!expr || !expr.trim()) return '<span style="color:var(--text3)">Enter a cron expression (5 fields: min hour day month weekday)</span>';
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) return '<span style="color:var(--red)">&#10007; Invalid: must have exactly 5 fields</span>';

    const fieldNames = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'];
    const fieldRanges = ['0-59', '0-23', '1-31', '1-12', '0-7 (0=Sun)'];
    let allValid = true;
    const breakdown = parts.map((p, i) => {
      let color = 'var(--green)';
      let desc = '';
      if (p === '*') {
        desc = `every ${fieldNames[i].toLowerCase()}`;
      } else if (p.includes('/')) {
        const step = p.split('/')[1];
        desc = `every ${step} ${fieldNames[i].toLowerCase()}(s)`;
      } else if (p.includes('-')) {
        const [a, b] = p.split('-');
        desc = `${fieldNames[i]} ${a} to ${b}`;
      } else if (p.includes(',')) {
        desc = `${fieldNames[i]}: ${p}`;
      } else {
        const n = parseInt(p);
        if (isNaN(n)) { color = 'var(--red)'; allValid = false; desc = 'invalid'; }
        else desc = `${fieldNames[i]} ${n}`;
      }
      return `<span style="color:${color}"><strong>${esc(p)}</strong> <span style="color:var(--text3)">${desc}</span></span>`;
    });

    const example = this._cronHumanReadable(parts);
    return `<div style="display:flex;flex-direction:column;gap:3px">
      <div style="display:flex;gap:8px;flex-wrap:wrap">${breakdown.join('<span style="color:var(--text3)">|</span>')}</div>
      ${example ? `<div style="color:var(--primary-light);font-size:11px;margin-top:2px">&#128337; ${example}</div>` : ''}
    </div>`;
  }

  _cronHumanReadable(parts) {
    if (!parts || parts.length !== 5) return '';
    const [min, hr, dom, mon, dow] = parts;
    const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    const monNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let time = '';
    if (min === '*' && hr === '*') time = 'Every minute';
    else if (min.startsWith('*/')) time = `Every ${min.split('/')[1]} minutes`;
    else if (hr === '*') time = `At minute ${min} of every hour`;
    else if (min === '0') time = `Every hour at :00`;
    else if (min.startsWith('*/') && hr !== '*') time = `Every ${min.split('/')[1]} min, hour ${hr}`;
    else time = `At ${hr.padStart(2,'0')}:${min.padStart(2,'0')}`;

    let day = '';
    if (dom === '*' && dow === '*') day = 'every day';
    else if (dom !== '*' && dow === '*') day = `on day ${dom}`;
    else if (dom === '*' && dow !== '*') {
      if (dow.includes('-')) { const [a,b]=dow.split('-'); day = `on weekdays ${dowNames[a]||a} to ${dowNames[b]||b}`; }
      else day = `on ${dowNames[parseInt(dow)] || dow}`;
    } else day = `on day ${dom}, dow ${dow}`;

    let month = mon === '*' ? '' : ` in ${monNames[parseInt(mon)] || mon}`;
    return `${time}, ${day}${month}`;
  }

  async saveProfile() {
    this._syncCurrentStep();
    const data = { ...this.draft };
    if (!data.Name) { showToast('Profile name is required', 'error'); return; }

    if (this.editingId) {
      data.Id = this.editingId;
      await window.api.updateBackupProfile(data);
      showToast('Profile updated', 'success');
    } else {
      await window.api.createBackupProfile(data);
      showToast('Profile created', 'success');
    }
    hideModal();
    this.load();
  }

  async deleteProfile(id, name) {
    if (!confirm(`Delete backup profile "${name}"?`)) return;
    await window.api.deleteBackupProfile(id);
    showToast('Profile deleted', 'success');
    this.load();
  }

  async runBackup(id) {
    showToast('Starting backup...', 'info');
    const result = await window.api.runBackup(id);
    if (result.success) {
      showToast(`Backup completed in ${result.duration}`, 'success');
    } else {
      showToast(`Backup failed: ${result.message || 'Unknown error'}`, 'error');
    }
    this.load();
  }

  async exportProfile(id) {
    const result = await window.api.exportBackupProfile(id);
    if (result.success) showToast('Profile exported', 'success');
  }

  async importProfile() {
    try {
      const result = await window.api.importBackupProfile();
      if (result.success && result.profile) {
        showToast(`Profile "${result.profile.Name}" imported successfully`, 'success');
        await this.load();
        this.render();
      } else if (result.message !== 'Cancelled') {
        showToast(`Import failed: ${result.message}`, 'error');
      }
    } catch (e) {
      showToast(`Import error: ${e.message}`, 'error');
    }
  }

  // ─── History Modal ───
  async showHistory(profileId) {
    const profile = this.profiles.find(p => p.Id === profileId);
    if (!profile) return;
    const result = await window.api.getBackupHistory(profileId);
    const history = result.history || [];

    const statusIcon = (s) => s === 'Success' ? '<span style="color:var(--green)">&#10003;</span>' : '<span style="color:var(--red)">&#10007;</span>';
    const formatSize = (bytes) => {
      if (!bytes) return '0 B';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(1) + ' GB';
    };

    const rows = history.map((h, i) => {
      const ts = h.Timestamp ? new Date(h.Timestamp).toLocaleString() : '?';
      const dbs = (h.Databases || []).join(', ') || 'all';
      return `
        <div class="bh-entry" onclick="this.classList.toggle('expanded')">
          <div class="bh-row">
            <span class="bh-num">${history.length - i}</span>
            ${statusIcon(h.Status)}
            <span class="bh-time">${ts}</span>
            <span class="bh-dbs">${esc(dbs)}</span>
            <span class="bh-dur">${esc(h.Duration || '?')}</span>
            <span class="bh-size">${esc(h.TotalSizeHuman || formatSize(h.TotalSize))}</span>
            <span class="badge badge-${h.Status === 'Success' ? 'active' : 'disabled'}" style="font-size:10px">${h.Status}</span>
            <i data-lucide="chevron-down" class="bh-chevron"></i>
          </div>
          <div class="bh-details">
            ${(h.Results || []).map(r => `
              <div class="bh-result">
                <span>${statusIcon(r.success ? 'Success' : 'Error')}</span>
                <strong>${esc(r.database)}</strong>
                <span style="color:var(--text3)">${r.sizeHuman || '0 B'}</span>
                ${r.uploads && r.uploads.length > 0 ? r.uploads.map(u => `<span class="badge badge-${u.success ? 'active' : 'disabled'}" style="font-size:9px">${u.type.toUpperCase()} ${u.success ? 'ok' : 'fail'}</span>`).join(' ') : ''}
                ${r.message ? `<div class="bh-error">${esc(r.message)}</div>` : ''}
              </div>
            `).join('')}
          </div>
        </div>`;
    }).join('');

    showModal(`
      <h2><i data-lucide="history"></i> ${esc(profile.Name)} &mdash; History</h2>
      <p style="font-size:12px;color:var(--text3);margin-bottom:12px">Cron: ${esc(profile.CronExpression)} &middot; ${history.length} execution(s)</p>
      <div class="bh-list">
        ${history.length === 0 ? '<p style="text-align:center;color:var(--text3);padding:24px">No execution history yet.</p>' : rows}
      </div>
      <div class="modal-actions">
        <button class="btn-outline" onclick="backupPage.exportHistoryCsv('${profileId}')"><i data-lucide="download"></i> Export CSV</button>
        <button class="btn-ghost" onclick="hideModal()">Close</button>
      </div>
    `);
    lucide.createIcons();
  }

  async exportHistoryCsv(profileId) {
    const result = await window.api.getBackupHistory(profileId);
    const history = result.history || [];
    if (history.length === 0) { showToast('No history to export', 'error'); return; }
    // Error and Stderr matter most: a row saying "Error, 0.1s, 0 B" with no
    // message is undiagnosable, which is exactly what an exported failure
    // needs to explain.
    const csv = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
    const header = 'Timestamp,Status,Duration,Databases,TotalSize,SizeHuman,Error,Stderr,LogPath\n';
    const rows = history.map(h => {
      const results = h.Results || [];
      const failed = results.filter(r => !r.success);
      const message = failed.map(r => `${r.database}: ${r.message || ''}`).join(' | ');
      const stderr = failed.map(r => r.stderr || '').filter(Boolean).join(' | ');
      return [
        csv(h.Timestamp || ''),
        csv(h.Status),
        csv(h.Duration),
        csv((h.Databases || []).join(';')),
        csv(h.TotalSize || 0),
        csv(h.TotalSizeHuman || ''),
        csv(message),
        csv(stderr),
        csv(h.LogPath || ''),
      ].join(',');
    }).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backup-history-${profileId.slice(0, 8)}.csv`;
    a.click();
    showToast('CSV exported', 'success');
  }

}

const backupPage = new BackupPage();
