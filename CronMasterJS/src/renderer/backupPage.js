// backupPage.js - Backup Profile Management UI with Step Wizard
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

class BackupPage {
  constructor() {
    this.profiles = [];
    this.editingId = null;
    this.currentStep = 0;
    this.draft = {};
    this.mysqldumpStatus = null;
  }

  async load() {
    this.profiles = await window.api.getBackupProfiles();
    this.mysqldumpStatus = await window.api.checkMysqldump();
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
      const mode = p.ManagementMode || 'cronmaster';
      const isNssm = mode === 'nssm';
      return `
      <div class="glass-card backup-profile-card ${p.Enabled ? '' : 'disabled'}">
        <div class="backup-profile-header">
          <div class="backup-profile-info">
            <h3 class="backup-profile-name">${esc(p.Name)}</h3>
            <span class="badge ${p.Enabled ? 'badge-active' : 'badge-disabled'}">${p.Enabled ? 'Active' : 'Disabled'}</span>
            <span class="badge ${isNssm ? 'badge-warning' : 'badge-info'}" style="font-size:10px">${isNssm ? '&#128736; NSSM' : '&#9201; Kyrion'}</span>
            <span class="badge badge-info">${esc(p.Databases?.length ? p.Databases.join(', ') : 'All DBs')}</span>
            ${p.Compression !== 'none' ? `<span class="badge badge-info" style="font-size:10px">${p.Compression.toUpperCase()} L${p.CompressionLevel}</span>` : ''}
          </div>
          <div class="backup-profile-actions">
            ${isNssm ? `
              <button class="btn-secondary-sm" onclick="backupPage.deployBackupNssm('${p.Id}')" title="Start as NSSM service"><i data-lucide="power"></i></button>
              <button class="btn-danger" onclick="backupPage.undeployBackupNssm('${p.Id}')" title="Stop NSSM service"><i data-lucide="power-off"></i></button>
            ` : `
              <button class="btn-glow btn-sm" onclick="backupPage.runBackup('${p.Id}')"><i data-lucide="play"></i> Run</button>
            `}
            <button class="btn-secondary-sm" onclick="backupPage.showHistory('${p.Id}')" title="Execution History"><i data-lucide="history"></i></button>
            <button class="btn-secondary-sm" onclick="backupPage.editProfile('${p.Id}')"><i data-lucide="pencil"></i> Edit</button>
            <button class="btn-secondary-sm" onclick="backupPage.exportProfile('${p.Id}')"><i data-lucide="download"></i></button>
            <button class="btn-danger" onclick="backupPage.deleteProfile('${p.Id}','${esc(p.Name)}')"><i data-lucide="trash-2"></i></button>
          </div>
        </div>
        <div class="backup-profile-details">
          <div class="backup-detail"><i data-lucide="database"></i> <span>${esc(p.Host)}:${p.Port}</span></div>
          <div class="backup-detail"><i data-lucide="folder"></i> <span>${esc(p.BackupPath)}</span></div>
          <div class="backup-detail"><i data-lucide="clock"></i> <span>${esc(p.CronExpression)}</span></div>
          ${p.UploadTargets.length > 0 ? `<div class="backup-detail"><i data-lucide="upload"></i> <span>${p.UploadTargets.map(t => t.type.toUpperCase()).join(', ')}</span></div>` : ''}
          ${p.LastRun ? `<div class="backup-detail"><i data-lucide="history"></i> <span>Last: ${new Date(p.LastRun).toLocaleString()} — ${p.LastStatus || '?'}</span></div>` : ''}
          ${st.total > 0 ? `<div class="backup-detail"><i data-lucide="bar-chart"></i> <span>${st.total} runs &middot; ${st.success} ok &middot; ${st.failed} failed</span></div>` : ''}
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
          <input type="text" class="form-input" id="manual-mysqldump-path" placeholder="C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe" style="flex:1">
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
      Compression: 'zip', CompressionLevel: 5, ExtraArgs: '--single-transaction --routines --triggers --events',
      UploadTargets: [], KeepLocal: true, KeepDays: 7, CronExpression: '0 2 * * *', Enabled: true
    };
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
    const steps = ['Connection', 'Databases', 'Backup', 'Upload', 'Schedule'];
    const stepIcons = ['database', 'list', 'hard-drive', 'upload', 'clock'];

    showModal(`
      <div class="wizard-layout">
        <div class="wizard-main">
          <h2><i data-lucide="${isEdit ? 'pencil' : 'plus-circle'}"></i> ${isEdit ? 'Edit' : 'New'} Backup Profile</h2>

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
              ${this.currentStep > 0 ? `<button class="btn-outline" onclick="backupPage.prevStep()"><i data-lucide=\"arrow-left\"></i> Back</button>` : ''}
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn-ghost" onclick="hideModal()">Cancel</button>
              ${isEdit ? `<button class=\"btn-glow\" onclick=\"backupPage.saveProfile()\"><i data-lucide=\"save\"></i> Save</button>` : ''}
              ${this.currentStep < steps.length - 1
                ? `<button class=\"btn-outline\" onclick=\"backupPage.nextStep()\">Next <i data-lucide=\"arrow-right\"></i></button>`
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
    const dbs = (d.Databases || []).length > 0 ? d.Databases.join(', ') : 'All databases';
    const uploads = (d.UploadTargets || []).length > 0 ? d.UploadTargets.map(t => t.type.toUpperCase()).join(', ') : 'None';
    const mode = d.ManagementMode || 'cronmaster';
    return `
      <div class="ws-header">
        <i data-lucide="file-text" style="width:14px;height:14px"></i>
        <span>Profile Summary</span>
      </div>
      <div class="ws-section">
        <div class="ws-label">Name</div>
        <div class="ws-value">${esc(d.Name) || '<em style="color:var(--text3)">not set</em>'}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">Connection</div>
        <div class="ws-value ws-mono">${esc(d.Host || 'localhost')}:${d.Port || 3306}</div>
        <div class="ws-sub">${esc(d.User || 'root')}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">Databases</div>
        <div class="ws-value">${esc(dbs)}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">Destination</div>
        <div class="ws-value ws-mono" style="word-break:break-all">${esc(d.BackupPath) || '<em style="color:var(--text3)">not set</em>'}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">Compression</div>
        <div class="ws-value">${d.Compression ? d.Compression.toUpperCase() : 'ZIP'} Level ${d.CompressionLevel || 5}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">Upload</div>
        <div class="ws-value">${esc(uploads)}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">Schedule</div>
        <div class="ws-value ws-mono">${esc(d.CronExpression) || '* * * * *'}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">Mode</div>
        <div class="ws-value">${mode === 'nssm' ? '&#128736; NSSM Service' : '&#9201; Kyrion'}</div>
      </div>
      <div class="ws-section">
        <div class="ws-label">Status</div>
        <div class="ws-value">${d.Enabled !== false ? '<span style="color:var(--green)">&#9679; Enabled</span>' : '<span style="color:var(--red)">&#9679; Disabled</span>'}</div>
      </div>
    `;
  }

  _updateFloatingSummary() {
    const el = document.getElementById('wizard-summary');
    if (!el) return;
    el.innerHTML = this._renderFloatingSummary();
    lucide.createIcons();
  }

  setMode(mode) {
    this.draft.ManagementMode = mode;
    // Toggle active class on mode buttons
    document.querySelectorAll('.bp-mode-option').forEach(el => el.classList.remove('active'));
    // Find the correct label by checking the onclick attribute or data value
    const labels = document.querySelectorAll('.bp-mode-option');
    labels.forEach(label => {
      const isCron = label.getAttribute('onclick').includes("'cronmaster'");
      if ((mode === 'cronmaster' && isCron) || (mode === 'nssm' && !isCron)) {
        label.classList.add('active');
      }
    });
    this._updateFloatingSummary();
  }

  _renderStepContent() {
    const d = this.draft;
    switch (this.currentStep) {
      case 0: return `
        <label class="form-label">Profile Name *</label>
        <input type="text" class="form-input" id="wiz-name" value="${esc(d.Name)}" placeholder="Daily MySQL Backup" oninput="backupPage.draft.Name=this.value; backupPage._updateFloatingSummary()">

        <label class="form-label">MySQL Connection</label>
        <div style="display:grid;grid-template-columns:1fr 80px;gap:8px">
          <div class="form-group"><label class="form-label">Host</label><input type="text" class="form-input" id="wiz-host" value="${esc(d.Host)}" oninput="backupPage.draft.Host=this.value; backupPage._updateFloatingSummary()"></div>
          <div class="form-group"><label class="form-label">Port</label><input type="number" class="form-input" id="wiz-port" value="${d.Port}" oninput="backupPage.draft.Port=parseInt(this.value)||3306; backupPage._updateFloatingSummary()"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div class="form-group"><label class="form-label">User</label><input type="text" class="form-input" id="wiz-user" value="${esc(d.User)}" oninput="backupPage.draft.User=this.value"></div>
          <div class="form-group"><label class="form-label">Password</label><input type="password" class="form-input" id="wiz-pass" value="${esc(d.Password)}" oninput="backupPage.draft.Password=this.value"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn-outline btn-sm" onclick="backupPage.testWizardConn()"><i data-lucide="wifi"></i> Test Connection</button>
          <span id="wiz-conn-status" style="font-size:12px;display:flex;align-items:center"></span>
        </div>
      `;

      case 1: return `
        <label class="form-label">Select Databases</label>
        <p style="font-size:12px;color:var(--text3);margin-bottom:8px">If none selected, ALL databases will be backed up.</p>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <button class="btn-outline btn-sm" onclick="backupPage.loadWizardDbs()"><i data-lucide="refresh-cw"></i> Load Databases</button>
          <span id="wiz-db-status" style="font-size:12px"></span>
        </div>
        <div id="wiz-db-chips" class="bp-db-list">
          ${(d.Databases || []).map(db => `
            <label class="bp-db-check-row">
              <input type="checkbox" class="bp-db-check" data-db="${esc(db)}" ${d.Databases?.includes(db) ? 'checked' : ''} onchange="backupPage._syncDbs()">
              <span class="bp-db-check-box"></span>
              <span class="bp-db-check-name">${esc(db)}</span>
            </label>
          `).join('')}
        </div>
        <p id="wiz-db-all-label" style="font-size:12px;color:var(--primary-light);margin-top:8px">${(!d.Databases || d.Databases.length === 0) ? '\u2713 All databases will be backed up' : `${d.Databases.length} selected`}</p>
      `;

      case 2: return `
        <label class="form-label">Backup Destination</label>
        <div style="display:flex;gap:6px;margin-bottom:12px">
          <input type="text" class="form-input" id="wiz-path" value="${esc(d.BackupPath)}" placeholder="C:\\Backups\\MySQL" oninput="backupPage.draft.BackupPath=this.value; backupPage._updateFloatingSummary()" style="flex:1">
          <button class="btn-outline btn-sm" onclick="backupPage.browseBackupPath()" title="Browse folder"><i data-lucide="folder-open"></i></button>
        </div>

        <label class="form-label">File Naming</label>
        <input type="text" class="form-input" id="wiz-naming" value="${esc(d.NamingPattern)}" oninput="backupPage.draft.NamingPattern=this.value" style="margin-bottom:4px">
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
          <span class="bp-db-chip" onclick="backupPage._insertPlaceholder('{database}')">{database}</span>
          <span class="bp-db-chip" onclick="backupPage._insertPlaceholder('{date}')">{date}</span>
          <span class="bp-db-chip" onclick="backupPage._insertPlaceholder('{time}')">{time}</span>
          <span class="bp-db-chip" onclick="backupPage._insertPlaceholder('{timestamp}')">{timestamp}</span>
        </div>

        <label class="form-label">Compression</label>
        <div style="display:grid;grid-template-columns:1fr 80px;gap:8px">
          <div class="form-group">
            <select class="form-input" id="wiz-compress" onchange="backupPage.draft.Compression=this.value">
              <option value="none" ${d.Compression==='none'?'selected':''}>None (faster)</option>
              <option value="zip" ${d.Compression==='zip'?'selected':''}>ZIP</option>
              <option value="7z" ${d.Compression==='7z'?'selected':''}>7-Zip (smaller)</option>
            </select>
          </div>
          <div class="form-group"><label class="form-label">Level ${d.CompressionLevel}</label><input type="range" min="1" max="9" value="${d.CompressionLevel}" oninput="backupPage.draft.CompressionLevel=parseInt(this.value); this.previousElementSibling.textContent='Level '+this.value" style="width:100%"></div>
        </div>

        <label class="form-label">mysqldump Options</label>
        <div class="mysql-opts-grid">
          <label class="mysql-opt"><input type="checkbox" id="opt-st" ${d.ExtraArgs?.includes('single-transaction') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Single Transaction</span><small>InnoDB consistency without locking</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-routines" ${d.ExtraArgs?.includes('routines') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Routines</span><small>Stored procedures & functions</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-triggers" ${d.ExtraArgs?.includes('triggers') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Triggers</span><small>Backup trigger definitions</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-events" ${d.ExtraArgs?.includes('events') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Events</span><small>Scheduled event definitions</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-locktables" ${d.ExtraArgs?.includes('lock-tables') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Lock Tables</span><small>Read lock during dump (MyISAM)</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-add-drop" ${d.ExtraArgs?.includes('add-drop-table') !== false && d.ExtraArgs?.includes('no-add-drop') === false ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Add DROP TABLE</span><small>Include DROP before CREATE</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-create-db" ${d.ExtraArgs?.includes('databases') || d.ExtraArgs?.includes('all-databases') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Create Database</span><small>Include CREATE DATABASE statement</small></label>
          <label class="mysql-opt"><input type="checkbox" id="opt-compress" ${d.ExtraArgs?.includes('compress') ? 'checked' : ''} onchange="backupPage._syncMysqlOpts()"><span>Compress Protocol</span><small>Compress client-server traffic</small></label>
        </div>
        <details style="margin-top:8px"><summary style="font-size:11px;color:var(--text3);cursor:pointer">Advanced: custom args</summary>
          <input type="text" class="form-input" id="wiz-args" value="${esc(d.ExtraArgs)}" oninput="backupPage.draft.ExtraArgs=this.value" style="margin-top:6px;font-size:12px;font-family:monospace" placeholder="--extra-args-here">
        </details>

        <label class="form-label">Local Storage</label>
        <div class="checkbox-row">
          <input type="checkbox" id="wiz-keeplocal" ${d.KeepLocal !== false ? 'checked' : ''} onchange="backupPage.draft.KeepLocal=this.checked">
          <label for="wiz-keeplocal">Keep backup files locally</label>
        </div>
        <div class="form-group" style="margin-top:6px"><label class="form-label">Auto-delete local backups after (days)</label><input type="number" class="form-input" id="wiz-keepdays" value="${d.KeepDays || 7}" min="1" max="365" oninput="backupPage.draft.KeepDays=parseInt(this.value)||7" style="width:100px"></div>
      `;

      case 3: return `
        <label class="form-label">Upload Targets</label>
        <p style="font-size:12px;color:var(--text3);margin-bottom:12px">Send backup files to remote servers after creation. Optional.</p>
        <div id="wiz-targets">${(d.UploadTargets || []).map((t, i) => this._renderTarget(t, i)).join('')}</div>
        <div style="display:flex;gap:6px;margin-top:8px">
          <button class="btn-outline btn-sm" onclick="backupPage.addTarget('ftp')"><i data-lucide="globe"></i> FTP</button>
          <button class="btn-outline btn-sm" onclick="backupPage.addTarget('sftp')"><i data-lucide="lock"></i> SFTP</button>
          <button class="btn-outline btn-sm" onclick="backupPage.addTarget('smb')"><i data-lucide="hard-drive"></i> SMB/NAS</button>
        </div>
      `;

      case 4: return `
        <label class="form-label">Schedule (Cron Expression)</label>
        <input type="text" class="form-input" id="wiz-cron" value="${esc(d.CronExpression)}" oninput="backupPage.draft.CronExpression=this.value; backupPage._validateCron(this.value); backupPage._updateFloatingSummary()" placeholder="0 2 * * *" style="margin-bottom:4px;font-family:monospace;font-size:14px;letter-spacing:1px">
        <div id="cron-validator" style="margin-bottom:8px;padding:8px 10px;border-radius:6px;background:rgba(255,255,255,.02);border:1px solid var(--border);font-size:11px;min-height:36px">
          ${this._renderCronBreakdown(d.CronExpression)}
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
          <span class="bp-db-chip" onclick="backupPage._setCron('0 * * * *')">Every hour</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('0 2 * * *')">Daily 2 AM</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('0 2 * * 1-5')">Weekdays</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('0 2 * * 0')">Sundays</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('0 2 1 * *')">Monthly</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('*/15 * * * *')">Every 15 min</span>
          <span class="bp-db-chip" onclick="backupPage._setCron('0 0 1 * *')">1st of month</span>
        </div>

        <label class="form-label" style="margin-top:12px">Management Mode</label>
        <p style="font-size:12px;color:var(--text3);margin-bottom:8px">Kyrion runs backup when the app is open. NSSM keeps it running as a Windows service even when the app is closed.</p>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <label class="bp-mode-option ${(d.ManagementMode || 'cronmaster') === 'cronmaster' ? 'active' : ''}" onclick="backupPage.setMode('cronmaster')">
            <input type="radio" name="mgmt-mode" value="cronmaster" ${(d.ManagementMode || 'cronmaster') === 'cronmaster' ? 'checked' : ''} style="display:none">
            <i data-lucide="monitor" style="width:16px;height:16px"></i>
            <div><strong>Kyrion</strong><br><small>App must be open</small></div>
          </label>
          <label class="bp-mode-option ${d.ManagementMode === 'nssm' ? 'active' : ''}" onclick="backupPage.setMode('nssm')">
            <input type="radio" name="mgmt-mode" value="nssm" ${d.ManagementMode === 'nssm' ? 'checked' : ''} style="display:none">
            <i data-lucide="server" style="width:16px;height:16px"></i>
            <div><strong>NSSM Service</strong><br><small>Always running</small></div>
          </label>
        </div>

        <div class="checkbox-row">
          <input type="checkbox" id="wiz-enabled" ${d.Enabled !== false ? 'checked' : ''} onchange="backupPage.draft.Enabled=this.checked">
          <label for="wiz-enabled">Enable this backup profile</label>
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
          <div>
            <label class="form-label" style="margin-bottom:2px;font-size:10px">Host</label>
            <input type="text" class="form-input" id="wiz-t-host-${i}" value="${esc(t.host || t.url || '')}" placeholder="ftp.example.com" oninput="backupPage._syncTargets()">
          </div>
          ${!isSmb ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <div>
              <label class="form-label" style="margin-bottom:2px;font-size:10px">User</label>
              <input type="text" class="form-input" id="wiz-t-user-${i}" value="${esc(t.user || '')}" placeholder="username" oninput="backupPage._syncTargets()">
            </div>
            <div>
              <label class="form-label" style="margin-bottom:2px;font-size:10px">Password</label>
              <input type="password" class="form-input" id="wiz-t-pass-${i}" value="${esc(t.password || '')}" placeholder="password" oninput="backupPage._syncTargets()">
            </div>
          </div>` : ''}
          <div>
            <label class="form-label" style="margin-bottom:2px;font-size:10px">${isSmb ? 'Network Path' : 'Remote Path'}</label>
            <input type="text" class="form-input" id="wiz-t-path-${i}" value="${esc(t.path || '')}" placeholder="${isSmb ? '\\\\server\\share\\backup' : '/backups/'}" oninput="backupPage._syncTargets()">
          </div>
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
    const user = document.getElementById(`wiz-t-user-${i}`)?.value;
    const pass = document.getElementById(`wiz-t-pass-${i}`)?.value;
    const path = document.getElementById(`wiz-t-path-${i}`)?.value;
    const resultEl = document.getElementById(`wiz-t-result-${i}`);
    if (!host) { if (resultEl) { resultEl.style.display='block'; resultEl.innerHTML='<span style="color:var(--red)">Host is required</span>'; } return; }
    if (resultEl) { resultEl.style.display='block'; resultEl.innerHTML='<span style="color:var(--text3)">Testing connection...</span>'; }
    try {
      if (type === 'ftp') {
        const r = await window.api.testFtpConnection({ host, user, password: pass, path: path || '/' });
        if (resultEl) resultEl.innerHTML = r.success
          ? `<span style="color:var(--green)">&#10003; Connected successfully</span>`
          : `<span style="color:var(--red)">&#10007; ${esc(r.message || 'Connection failed')}</span>`;
      } else if (type === 'sftp') {
        const r = await window.api.testSftpConnection({ host, user, password: pass, path: path || '/' });
        if (resultEl) resultEl.innerHTML = r.success
          ? `<span style="color:var(--green)">&#10003; Connected successfully</span>`
          : `<span style="color:var(--red)">&#10007; ${esc(r.message || 'Connection failed')}</span>`;
      } else {
        if (resultEl) resultEl.innerHTML = `<span style="color:var(--text3)">SMB/NAS path will be tested during backup</span>`;
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
      label.textContent = dbs.length === 0 ? `\u2713 All databases will be backed up` : `${dbs.length} of ${total} selected`;
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
    const header = 'Timestamp,Status,Duration,Databases,TotalSize,SizeHuman\n';
    const rows = history.map(h => {
      const ts = h.Timestamp || '';
      const dbs = (h.Databases || []).join(';');
      return `"${ts}","${h.Status}","${h.Duration}","${dbs}","${h.TotalSize || 0}","${h.TotalSizeHuman || ''}"`;
    }).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `backup-history-${profileId.slice(0, 8)}.csv`;
    a.click();
    showToast('CSV exported', 'success');
  }

  // ─── NSSM Deploy/Undeploy ───
  async deployBackupNssm(profileId) {
    showToast('Deploying NSSM service...', 'info');
    const result = await window.api.deployBackupNssm(profileId);
    if (result.success) {
      showToast(`Service deployed: ${result.serviceName}`, 'success');
    } else {
      showToast(result.message || 'Deploy failed', 'error');
    }
    this.load();
  }

  async undeployBackupNssm(profileId) {
    if (!confirm('Stop and remove the NSSM service for this backup?')) return;
    showToast('Removing NSSM service...', 'info');
    const result = await window.api.undeployBackupNssm(profileId);
    if (result.success) {
      showToast('Service removed', 'success');
    } else {
      showToast(result.message || 'Remove failed', 'error');
    }
    this.load();
  }
}

const backupPage = new BackupPage();
