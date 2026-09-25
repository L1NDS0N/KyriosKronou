// retentionPage.js - Standalone Retention screen: remove unnecessary backup
// files from a folder based on their dates - from the file NAME (2026-09-22/)
// or from the file METADATA (mtime), user's choice.
//
// Minimalist on purpose: one folder, one date source, one default policy
// (keep 90 days, never below 5 files, prune empty dated folders). "Default
// mode" runs exactly that. Advanced mode reveals every rule the sync
// profiles use, plus a live preview and a one-click "apply" that deletes.
//
// Deletion goes through runRetentionNow, which audits every removed file.

'use strict';

function retEsc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

class RetentionPage {
  constructor() {
    this.folder = '';
    this.useMetadata = false;   // false = dates from file names
    this.advanced = false;      // default mode vs full rule set
    this.analysis = null;
    this.preview = null;        // what WOULD be deleted right now
    this.lastRun = null;        // result of an executed run
    this.busy = false;
    this.previewTimer = null;
    this.previewRequest = 0;
    this.previewKey = null;
    this.profiles = [];
    this.editingProfileId = null;
    this.previewTab = 'all';
  }

  async load() {
    if (window.api.getRetentionProfiles) {
      try {
        const profiles = await window.api.getRetentionProfiles();
        this.profiles = Array.isArray(profiles) ? profiles : [];
      } catch (e) {
        this.profiles = [];
      }
    }
    this.render();
  }

  render() {
    const host = document.getElementById('retention-content');
    if (!host) return;
    host.innerHTML = `
      <div class="retention-layout">
        <div class="retention-config">
          <div class="glass-card ret-card">
            <div class="glass-card-header"><h3><i data-lucide="scissors"></i> ${retEsc(i18n.t('retention.cardTitle'))}</h3></div>
            <div class="form-hint" style="margin-bottom:14px">${retEsc(i18n.t('retention.cardHint'))}</div>

            <label class="form-label">${retEsc(i18n.t('retention.folderLabel'))}</label>
            <div class="input-row">
              <input type="text" class="form-input" id="ret-folder" data-path-input data-path-kind="directory" value="${retEsc(this.folder)}" placeholder="D:\\Backups" oninput="retentionPage.folder=this.value; retentionPage._resetResults()">
              <button class="btn-outline btn-sm" onclick="retentionPage._browse()" title="${retEsc(i18n.t('taskModal.browse'))}"><i data-lucide="folder-open"></i></button>
              <button class="btn-glow btn-sm" onclick="retentionPage.analyze()" id="ret-analyze-btn"><i data-lucide="search"></i> ${retEsc(i18n.t('retention.analyzeBtn'))}</button>
            </div>

            <div class="ret-toggles">
              <label class="check-row" data-tip="${retEsc(i18n.t('retention.tipNames'))}">
                <input type="radio" name="ret-datesrc" ${!this.useMetadata ? 'checked' : ''} onchange="retentionPage.setDateSource(false)">
                <span>${retEsc(i18n.t('retention.dateNames'))}</span>
              </label>
              <label class="check-row" data-tip="${retEsc(i18n.t('retention.tipMetadata'))}">
                <input type="radio" name="ret-datesrc" ${this.useMetadata ? 'checked' : ''} onchange="retentionPage.setDateSource(true)">
                <span>${retEsc(i18n.t('retention.dateMetadata'))}</span>
              </label>
            </div>

            <div id="ret-analysis" style="margin-top:14px">${this._renderAnalysis()}</div>
          </div>

          <div class="glass-card ret-card" id="ret-policy-card" style="display:${this.analysis && this.analysis.ok ? 'block' : 'none'}">
            <div class="glass-card-header"><h3><i data-lucide="sliders-horizontal"></i> ${retEsc(i18n.t('retention.policyTitle'))}</h3></div>
            ${this._renderPolicy()}
          </div>
        </div>

        <aside class="glass-card ret-card ret-preview-sidebar" id="ret-preview-card">
          <div class="glass-card-header"><h3><i data-lucide="eye"></i> ${retEsc(i18n.t('retention.previewTitle'))}</h3></div>
          ${this._renderLastRun()}
          <div class="ret-preview-content">${this._renderPreviewState()}</div>
          <button class="btn-danger" onclick="retentionPage.applyNow()" id="ret-apply-btn" ${this.preview && this.preview.ok ? '' : 'disabled'}><i data-lucide="trash-2"></i> ${retEsc(i18n.t('retention.applyBtn'))}</button>
        </aside>
      </div>
      <div class="glass-card ret-card ret-schedules-card">
        <div class="ret-schedules-header">
          <div class="glass-card-header"><h3><i data-lucide="calendar-clock"></i> ${retEsc(i18n.t('retention.profilesTitle'))}</h3></div>
          <button class="btn-glow btn-sm" onclick="retentionPage.showScheduleEditor()"><i data-lucide="plus"></i> ${retEsc(i18n.t('retention.newProfile'))}</button>
        </div>
        <div class="form-hint" style="margin-bottom:12px">${retEsc(i18n.t('retention.profilesHint'))}</div>
        <div id="ret-profiles-list">${this._renderProfiles()}</div>
      </div>
    `;
    if (window.PathInput) PathInput.attachAll(host);
    if (window.lucide) lucide.createIcons();
  }

  _resetResults() {
    clearTimeout(this.previewTimer);
    this.previewRequest++;
    this.analysis = null;
    this.preview = null;
    this.previewKey = null;
    this.lastRun = null;
    this.render();
  }

  async _browse() {
    const r = await window.api.browseFolder(i18n.t('taskModal.browse'));
    if (r && r.path) {
      this.folder = r.path;
      this._resetResults();
    }
  }

  setDateSource(useMetadata) {
    this.useMetadata = useMetadata;
    clearTimeout(this.previewTimer);
    this.previewRequest++;
    this.analysis = null;
    this.preview = null;
    this.previewKey = null;
    this.lastRun = null;
    this.render();
    // Re-run automatically when a folder is already loaded: the source of
    // dates changes the analysis, so stale numbers would mislead.
    if (this.folder) this.analyze();
  }

  async analyze() {
    if (!this.folder || this.busy) return;
    this.busy = true;
    const btn = document.getElementById('ret-analyze-btn');
    if (btn) btn.disabled = true;
    try {
      this.analysis = await window.api.analyzeSyncFolder(this.folder, {
        useNames: !this.useMetadata,
        useMetadata: this.useMetadata,
        extensions: [...this._getCfg().FileExtensions],
      });
    } catch (e) {
      this.analysis = { ok: false, error: e.message };
    }
    this.busy = false;
    if (btn) btn.disabled = false;
    // Default mode auto-suggests; advanced waits for explicit input.
    if (this.analysis && this.analysis.ok && !this.advanced && this.analysis.suggested) {
      this._applySuggestion(this.analysis.suggested, true);
    }
    this.render();
    this._schedulePreview();
  }

  // ─── Analysis display ───
  _renderAnalysis() {
    if (!this.analysis) return '';
    const a = this.analysis;
    if (a.ok === false) {
      return `<div class="form-hint" style="color:var(--red)">${retEsc(a.error)}</div>`;
    }
    const patternLabels = {
      'dated-folders': i18n.t('sync.patternDatedFolders'),
      'dated-files': i18n.t('sync.patternDatedFiles'),
      'mixed': i18n.t('sync.patternMixed'),
      'flat': i18n.t('sync.patternFlat'),
      'empty': i18n.t('sync.patternEmpty'),
    };
    const src = this.useMetadata
      ? retEsc(i18n.t('retention.sourceMetadata'))
      : retEsc(i18n.t('retention.sourceNames'));
    return `
      <div class="ret-analysis">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <span class="badge badge-active"><i data-lucide="fingerprint" style="width:11px;height:11px"></i> ${retEsc(patternLabels[a.folderPattern] || a.folderPattern)}</span>
          <span class="badge badge-info">${a.totalFiles} ${retEsc(i18n.t('sync.filesCount'))}</span>
          <span class="badge badge-info">${retEsc(this._fmtBytes(a.totalBytes || 0))}</span>
          ${a.medianGapDays ? `<span class="badge badge-info">~${a.medianGapDays}d ${retEsc(i18n.t('sync.medianGap'))}</span>` : ''}
          ${a.fromMetadata ? `<span class="badge badge-info">${a.fromMetadata} ${retEsc(i18n.t('retention.viaMetadata'))}</span>` : ''}
        </div>
        <div class="form-hint" style="margin-top:6px">${retEsc(i18n.t('retention.datesFrom'))}: <b>${src}</b></div>
      </div>`;
  }

  // ─── Policy form (default vs advanced) ───
  _renderPolicy() {
    const adv = this.advanced;
    return `
      <div class="ret-mode-row">
        <label class="check-row">
          <input type="checkbox" ${adv ? 'checked' : ''} onchange="retentionPage.setAdvanced(this.checked)">
          <span>${retEsc(i18n.t('retention.advancedMode'))}<span class="check-hint">${retEsc(i18n.t('retention.advancedHint'))}</span></span>
        </label>
      </div>
      ${this._renderFormatRules()}
      ${adv ? this._renderAdvancedRules() : this._renderDefaultRules()}
    `;
  }

  _renderFormatRules() {
    const cfg = this._getCfg();
    const extensions = Array.isArray(cfg.FileExtensions) ? cfg.FileExtensions : ['.7z', '.zip'];
    const all = extensions.length === 0;
    const choices = ['.7z', '.zip', '.bak', '.tar', '.gz'];
    for (const ext of extensions) if (!choices.includes(ext)) choices.push(ext);
    return `<div class="ret-format-rule">
      <div class="form-section-title"><i data-lucide="file-check-2"></i> ${retEsc(i18n.t('retention.formatsTitle'))}</div>
      <div class="form-hint" style="margin:0 0 8px">${retEsc(i18n.t('retention.formatsHint'))}</div>
      <label class="check-row"><input type="checkbox" ${all ? 'checked' : ''} onchange="retentionPage._setAllFormats(this.checked)"><span>${retEsc(i18n.t('retention.formatsAll'))}</span></label>
      <div class="ret-format-choices">${choices.map(ext => `<label class="check-row"><input type="checkbox" ${!all && extensions.includes(ext) ? 'checked' : ''} onchange="retentionPage._toggleFormat('${ext}', this.checked)"><span class="mono">${retEsc(ext)}</span></label>`).join('')}</div>
      <div class="input-row" style="margin-top:6px"><input type="text" class="form-input mono" id="ret-custom-format" placeholder="${retEsc(i18n.t('retention.formatsCustom'))}" onkeydown="if(event.key==='Enter'){event.preventDefault();retentionPage._addFormat()}"><button class="btn-outline btn-sm" onclick="retentionPage._addFormat()"><i data-lucide="plus"></i></button></div>
    </div>`;
  }

  _setAllFormats(enabled) {
    this._getCfg().FileExtensions = enabled ? [] : ['.7z', '.zip'];
    this._invalidatePreview();
    this.render();
  }

  _toggleFormat(ext, enabled) {
    const cfg = this._getCfg();
    const current = Array.isArray(cfg.FileExtensions) ? cfg.FileExtensions : ['.7z', '.zip'];
    cfg.FileExtensions = enabled ? Array.from(new Set([...current, ext])) : current.filter(x => x !== ext);
    this._invalidatePreview();
    this.render();
  }

  _addFormat() {
    const input = document.getElementById('ret-custom-format');
    if (!input) return;
    const value = input.value.trim().toLowerCase();
    if (!value) return;
    const ext = value.startsWith('.') ? value : `.${value}`;
    const cfg = this._getCfg();
    const current = Array.isArray(cfg.FileExtensions) ? cfg.FileExtensions : ['.7z', '.zip'];
    cfg.FileExtensions = Array.from(new Set([...current.filter(x => x), ext]));
    input.value = '';
    this._invalidatePreview();
    this.render();
  }

  _renderDefaultRules() {
    return `
      <div class="ret-default">
        <div class="form-hint" style="margin-bottom:8px">${retEsc(i18n.t('retention.defaultHint'))}</div>
        <div class="ret-default-row">
          <span>${retEsc(i18n.t('retention.keepLabel'))}</span>
          <input type="number" class="form-input" id="ret-days" value="${this._getCfg().KeepDays}" min="1" max="3650" style="width:90px" onchange="retentionPage._setDays(this.value)">
          <span>${retEsc(i18n.t('sync.days'))}</span>
        </div>
        <div class="form-hint" style="margin-top:8px">${retEsc(i18n.t('retention.defaultSafety'))}</div>
      </div>`;
  }

  _renderAdvancedRules() {
    const c = this._getCfg();
    return `
      <div class="ret-advanced">
        <label class="check-row"><input type="checkbox" id="ret-adv-age" ${c.ByAge ? 'checked' : ''} onchange="retentionPage._syncAdvanced()">
          <span>${retEsc(i18n.t('sync.retByAge'))} <input type="number" class="form-input" id="ret-adv-days" value="${c.KeepDays}" min="1" max="3650" style="width:80px;display:inline-block;padding:2px 6px" onchange="retentionPage._syncAdvanced()"> ${retEsc(i18n.t('sync.days'))}</span></label>
        <label class="check-row"><input type="checkbox" id="ret-adv-count" ${c.ByCount ? 'checked' : ''} onchange="retentionPage._syncAdvanced()">
          <span>${retEsc(i18n.t('sync.retByCount'))} <input type="number" class="form-input" id="ret-adv-count-n" value="${c.KeepCount}" min="1" max="10000" style="width:80px;display:inline-block;padding:2px 6px" onchange="retentionPage._syncAdvanced()"> ${retEsc(i18n.t('sync.snapshots'))}</span></label>
        <label class="check-row"><input type="checkbox" id="ret-adv-weekly" ${c.ByWeekly ? 'checked' : ''} onchange="retentionPage._syncAdvanced()">
          <span>${retEsc(i18n.t('retention.byWeekly'))} <input type="number" class="form-input" id="ret-adv-weeks" value="${c.WeeklyKeepWeeks}" min="1" max="520" style="width:80px;display:inline-block;padding:2px 6px" onchange="retentionPage._syncAdvanced()"> ${retEsc(i18n.t('retention.weeks'))}</span></label>
        <label class="check-row"><input type="checkbox" id="ret-adv-biweekly" ${c.ByBiweekly ? 'checked' : ''} onchange="retentionPage._syncAdvanced()">
          <span>${retEsc(i18n.t('retention.byBiweekly'))} <input type="number" class="form-input" id="ret-adv-fortnights" value="${c.BiweeklyKeepPeriods}" min="1" max="480" style="width:80px;display:inline-block;padding:2px 6px" onchange="retentionPage._syncAdvanced()"> ${retEsc(i18n.t('retention.fortnights'))}</span></label>
        <label class="check-row"><input type="checkbox" id="ret-adv-monthly" ${c.ByMonthly ? 'checked' : ''} onchange="retentionPage._syncAdvanced()">
          <span>${retEsc(i18n.t('retention.byMonthly'))} <input type="number" class="form-input" id="ret-adv-months" value="${c.MonthlyKeepMonths}" min="1" max="240" style="width:80px;display:inline-block;padding:2px 6px" onchange="retentionPage._syncAdvanced()"> ${retEsc(i18n.t('retention.months'))}</span></label>
        <div class="form-hint" style="margin:2px 0 8px 26px">${retEsc(i18n.t('retention.periodicHint'))}</div>
        <label class="check-row"><input type="checkbox" id="ret-adv-size" ${c.BySize ? 'checked' : ''} onchange="retentionPage._syncAdvanced()">
          <span>${retEsc(i18n.t('sync.retBySize'))} <input type="number" class="form-input" id="ret-adv-gb" value="${c.FreeGb || 10}" min="1" max="100000" style="width:80px;display:inline-block;padding:2px 6px" onchange="retentionPage._syncAdvanced()"> GB</span></label>
        <div style="margin-top:10px">
          <label class="form-label">${retEsc(i18n.t('sync.minKeep'))}</label>
          <input type="number" class="form-input" id="ret-adv-minkeep" value="${c.MinKeep != null ? c.MinKeep : 3}" min="0" max="1000" style="width:100px" onchange="retentionPage._syncAdvanced()">
          <div class="form-hint">${retEsc(i18n.t('sync.minKeepHint'))}</div>
        </div>
      </div>`;
  }

  _getCfg() {
    if (!this.cfg) {
      this.cfg = { Enabled: true, FileExtensions: ['.7z', '.zip'], ByAge: true, KeepDays: 90, ByCount: false, KeepCount: 10, BySize: false, FreeGb: 0, ByWeekly: false, WeeklyKeepWeeks: 8, ByBiweekly: false, BiweeklyKeepPeriods: 12, ByMonthly: false, MonthlyKeepMonths: 12, MinKeep: 5 };
    }
    // The date source toggle is part of the policy: preview and apply must
    // date snapshots exactly as the analysis did.
    this.cfg.DateSource = this.useMetadata ? 'metadata' : 'names';
    return this.cfg;
  }

  _setDays(v) { this._getCfg().KeepDays = parseInt(v, 10) || 90; this._invalidatePreview(); }

  setAdvanced(on) {
    this.advanced = on;
    this.preview = null;
    this.previewKey = null;
    this.render();
  }

  _syncAdvanced(invalidate = true) {
    // The default/minimal mode has no advanced controls in the DOM.
    if (!document.getElementById('ret-adv-age')) return;
    const c = this._getCfg();
    c.ByAge = document.getElementById('ret-adv-age').checked;
    c.KeepDays = parseInt(document.getElementById('ret-adv-days').value, 10) || 30;
    c.ByCount = document.getElementById('ret-adv-count').checked;
    c.KeepCount = parseInt(document.getElementById('ret-adv-count-n').value, 10) || 10;
    c.ByWeekly = document.getElementById('ret-adv-weekly').checked;
    c.WeeklyKeepWeeks = parseInt(document.getElementById('ret-adv-weeks').value, 10) || 8;
    c.ByBiweekly = document.getElementById('ret-adv-biweekly').checked;
    c.BiweeklyKeepPeriods = parseInt(document.getElementById('ret-adv-fortnights').value, 10) || 12;
    c.ByMonthly = document.getElementById('ret-adv-monthly').checked;
    c.MonthlyKeepMonths = parseInt(document.getElementById('ret-adv-months').value, 10) || 12;
    c.BySize = document.getElementById('ret-adv-size').checked;
    c.FreeGb = parseFloat(document.getElementById('ret-adv-gb').value) || 0;
    c.MinKeep = parseInt(document.getElementById('ret-adv-minkeep').value, 10) || 0;
    if (invalidate) this._invalidatePreview();
  }

  _invalidatePreview() {
    this.preview = null;
    this.previewKey = null;
    const button = document.getElementById('ret-apply-btn');
    if (button) button.disabled = true;
    const content = document.querySelector('.ret-preview-content');
    if (content) content.innerHTML = this._renderPreviewState();
    this._schedulePreview();
  }

  _schedulePreview() {
    clearTimeout(this.previewTimer);
    if (!this.folder || !this.analysis || this.analysis.ok === false) return;
    this.previewTimer = setTimeout(() => this.runPreview(), 300);
  }

  _renderPreviewState() {
    if (!this.folder) return `<div class="form-hint">${retEsc(i18n.t('retention.previewIdleFolder'))}</div>`;
    if (!this.analysis || this.analysis.ok === false) return `<div class="form-hint">${retEsc(i18n.t('retention.previewIdleAnalysis'))}</div>`;
    if (!this.preview) return `<div class="form-hint">${retEsc(i18n.t('retention.previewUpdating'))}</div>`;
    return this._renderPreview();
  }

  _applySuggestion(s, silent) {
    this.cfg = {
      Enabled: true,
      FileExtensions: this.cfg && Array.isArray(this.cfg.FileExtensions) ? [...this.cfg.FileExtensions] : ['.7z', '.zip'],
      ByAge: !!s.ByAge, KeepDays: s.KeepDays || 90,
      ByCount: !!s.ByCount, KeepCount: s.KeepCount || 10,
      BySize: !!s.BySize, FreeGb: s.FreeGb || 0,
      ByWeekly: !!s.ByWeekly, WeeklyKeepWeeks: s.WeeklyKeepWeeks || 8,
      ByBiweekly: !!s.ByBiweekly, BiweeklyKeepPeriods: s.BiweeklyKeepPeriods || 12,
      ByMonthly: !!s.ByMonthly, MonthlyKeepMonths: s.MonthlyKeepMonths || 12,
      MinKeep: s.MinKeep != null ? s.MinKeep : 5,
    };
    if (!silent) showToast(i18n.t('sync.suggestionApplied'), 'success');
  }

  // ─── Preview & execution ───
  async runPreview() {
    if (!this.folder || this.busy) return;
    this._syncAdvanced(false);
    const request = ++this.previewRequest;
    const folder = this.folder;
    const policy = { ...this._getCfg() };
    const previewKey = JSON.stringify({ folder, policy });
    try {
      const preview = await window.api.previewSyncRetention(folder, policy);
      if (request !== this.previewRequest || folder !== this.folder) return;
      this.preview = preview;
      this.previewKey = preview.ok ? previewKey : null;
    } catch (e) {
      if (request !== this.previewRequest || folder !== this.folder) return;
      this.preview = { ok: false, error: e.message };
      this.previewKey = null;
    }
    this.render();
  }

  async applyNow() {
    if (!this.folder || this.busy) return;
    if (!this.preview || this.preview.ok === false) {
      showToast(i18n.t('retention.previewRequired'), 'error');
      return;
    }
    this._syncAdvanced(false);
    const n = this.preview.delete.length;
    const msg = i18n.t('retention.confirmDelete', { n });
    if (!confirm(msg)) return;
    this.busy = true;
    const btn = document.getElementById('ret-apply-btn');
    if (btn) btn.disabled = true;
    try {
      this.lastRun = await window.api.runRetentionNow(this.folder, this._getCfg());
    } catch (e) {
      this.lastRun = { ok: false, error: e.message, deleted: 0 };
    }
    this.busy = false;
    this.preview = null;
    this.previewKey = null;
    this.render();
    if (this.lastRun && this.lastRun.ok) {
      showToast(i18n.t('retention.doneToast', { n: this.lastRun.deleted, size: this._fmtBytes(this.lastRun.freed || 0) }), 'success');
      this.analyze(); // refresh the numbers after deletion
    } else {
      showToast((this.lastRun && this.lastRun.error) || 'Error', 'error');
    }
  }

  _renderFolderPreviews(p) {
    return `<div class="ret-preview-folders">${p.folders.map((f, index) => this._renderFolderPreview(f, index, p)).join('')}</div>`;
  }

  _renderFolderPreview(f, index, p) {
    const path = f.path || f.folder || f.relFolder || f.relativePath || f.dir || f.rel || '.';
    const analysisFolder = (this.analysis && this.analysis.folders || []).find(item => (item.rel || '') === (f.rel || ''));
    const rules = f.rules || [];
    const tabs = [
      { id: 'all', label: i18n.t('retention.previewTabAll') },
      { id: 'age', label: i18n.t('retention.previewTabAge') },
      { id: 'count', label: i18n.t('retention.previewTabCount') },
      { id: 'size', label: i18n.t('retention.previewTabSize') },
      { id: 'weekly', label: i18n.t('retention.previewTabWeekly') },
      { id: 'biweekly', label: i18n.t('retention.previewTabBiweekly') },
      { id: 'monthly', label: i18n.t('retention.previewTabMonthly') },
      { id: 'minKeep', label: i18n.t('retention.previewTabSafety') },
    ].filter(tab => tab.id === 'all' || (tab.id === 'minKeep' && f.minKeep > 0) || rules.some(r => r.type === tab.id) || [...(f.delete || []), ...(f.kept || [])].some(x => x.reason === tab.id));
    const active = tabs.some(t => t.id === this.previewTab) ? this.previewTab : 'all';
    const selected = tabs.find(t => t.id === active) || tabs[0];
    const deletes = active === 'all' ? (f.delete || []) : (f.delete || []).filter(x => x.reason === active);
    const kept = active === 'all' ? (f.kept || []) : (f.kept || []).filter(x => x.reason === active);
    const selectedRules = active === 'all' ? rules : rules.filter(r => r.type === active);
    return `<details class="ret-folder-accordion" ${index === 0 ? 'open' : ''}>
      <summary><span class="ret-folder-name"><i data-lucide="folder"></i> ${retEsc(path)}</span><span class="ret-folder-count">${retEsc(i18n.t('retention.folderPreviewCount', { delete: deletes.length, keep: kept.length }))}</span></summary>
      <div class="ret-folder-pattern">${retEsc(i18n.t('retention.folderPattern'))}: ${retEsc(f.folderPattern || f.pattern || (analysisFolder && (analysisFolder.folderPattern || analysisFolder.pattern)) || '—')}</div>
      <div class="ret-preview-tabs">${tabs.map(tab => `<button class="ret-preview-tab ${tab.id === active ? 'active' : ''}" onclick="retentionPage.previewTab='${tab.id}'; retentionPage._renderPreviewSidebar()">${retEsc(tab.label)}</button>`).join('')}</div>
      ${this._renderRules({ rules: selectedRules, minKeep: active === 'all' || active === 'minKeep' ? f.minKeep : 0, dateSource: f.dateSource || p.dateSource })}
      ${deletes.length ? this._renderPreviewTable(deletes, 'var(--amber)') : ''}
      ${kept.length ? this._renderPreviewTable(kept, 'var(--green)') : ''}
      ${!deletes.length && !kept.length ? `<div class="form-hint" style="color:var(--green)">${retEsc(i18n.t('retention.previewTabEmpty'))}</div>` : ''}
    </details>`;
  }

  _renderPreviewTable(items, color) {
    return `<div class="ret-list-scroll"><table class="ret-file-table">
      <thead><tr><th>${retEsc(i18n.t('retention.colReason'))}</th><th>${retEsc(i18n.t('retention.colFile'))}</th><th>${retEsc(i18n.t('retention.colDate'))}</th><th>${retEsc(i18n.t('retention.colDetail'))}</th></tr></thead>
      <tbody>${items.map(x => `<tr><td class="mono" style="color:${color};white-space:nowrap">${retEsc(i18n.t('retention.reason.' + x.reason))}</td><td class="mono" style="word-break:break-all">${retEsc(x.rel)}</td><td class="mono" style="white-space:nowrap">${retEsc(x.date ? x.date.slice(0, 10) : '')}</td><td style="color:var(--text3);white-space:nowrap">${retEsc(x.detail || '')}</td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  _renderPreviewSidebar() {
    const content = document.querySelector('.ret-preview-content');
    if (content) content.innerHTML = this._renderPreviewState();
    const button = document.getElementById('ret-apply-btn');
    if (button) button.disabled = !(this.preview && this.preview.ok);
    this._updateScheduleSaveButton();
    if (window.lucide) lucide.createIcons();
  }

  _renderPreview() {
    const p = this.preview;
    if (!p) return '';
    if (p.ok === false) return `<div class="form-hint" style="color:var(--red)">${retEsc(p.error)}</div>`;
    if (Array.isArray(p.folders) && p.folders.length) return this._renderFolderPreviews(p);
    const del = p.delete || [];
    const kept = p.kept || [];
    // Every file is listed - no "+N more". The user signs off on deleting
    // exactly these, so a truncated list is not a preview.
    const table = (items, color) => `
      <table class="ret-file-table">
        <thead><tr><th>${retEsc(i18n.t('retention.colReason'))}</th><th>${retEsc(i18n.t('retention.colFile'))}</th><th>${retEsc(i18n.t('retention.colDate'))}</th><th>${retEsc(i18n.t('retention.colDetail'))}</th></tr></thead>
        <tbody>${items.map(x => `
          <tr>
            <td class="mono" style="color:${color};white-space:nowrap">${retEsc(i18n.t('retention.reason.' + x.reason))}</td>
            <td class="mono" style="word-break:break-all">${retEsc(x.rel)}</td>
            <td class="mono" style="white-space:nowrap">${retEsc(x.date ? x.date.slice(0, 10) : '')}</td>
            <td style="color:var(--text3);white-space:nowrap">${retEsc(x.detail || '')}</td>
          </tr>`).join('')}</tbody>
      </table>`;
    return `
      ${this._renderRules(p)}
      ${p.totalFiles != null ? `<div class="form-hint" style="margin:8px 0">${retEsc(i18n.t('retention.summary', { total: p.totalFiles, snaps: p.totalSnapshots || 0 }))}</div>` : ''}
      ${del.length ? `
        <div class="ret-list ret-list-delete">
          <div class="ret-list-title" style="color:var(--red)"><i data-lucide="trash-2" style="width:12px;height:12px"></i> ${retEsc(i18n.t('retention.deleteListTitle', { n: del.length, size: this._fmtBytes(p.deleteBytes || 0) }))}</div>
          <div class="ret-list-scroll">${table(del, 'var(--amber)')}</div>
        </div>` : `<div class="form-hint" style="color:var(--green)">✓ ${retEsc(i18n.t('sync.previewNothing'))}</div>`}
      ${kept.length ? `
        <div class="ret-list ret-list-kept">
          <div class="ret-list-title" style="color:var(--green)"><i data-lucide="shield-check" style="width:12px;height:12px"></i> ${retEsc(i18n.t('retention.keptListTitle', { n: kept.length }))}</div>
          <div class="ret-list-scroll">${table(kept, 'var(--green)')}</div>
        </div>` : ''}`;
  }

  _renderRules(p) {
    if (!p.rules || !p.rules.length) return '';
    const items = p.rules.map(r => {
      const n = r.type === 'age' ? r.days
        : r.type === 'count' ? r.keep
          : r.type === 'size' ? Math.round(r.freeBytes / 1073741824)
            : r.periods;
      return `<li><i data-lucide="${r.kind === 'keep' ? 'shield' : 'trash-2'}" style="width:12px;height:12px"></i> ${retEsc(i18n.t('retention.rule.' + r.type, { n }))}</li>`;
    });
    const hasKeep = p.rules.some(r => r.kind === 'keep');
    if (hasKeep && !p.rules.some(r => r.kind === 'delete')) {
      items.push(`<li style="color:var(--amber)"><i data-lucide="alert-triangle" style="width:12px;height:12px"></i> ${retEsc(i18n.t('retention.rule.onlyPeriodic'))}</li>`);
    }
    if (p.minKeep > 0) items.push(`<li><i data-lucide="shield" style="width:12px;height:12px"></i> ${retEsc(i18n.t('retention.rule.minKeep', { n: p.minKeep }))}</li>`);
    if (hasKeep || p.minKeep > 0) items.push(`<li><i data-lucide="info" style="width:12px;height:12px"></i> ${retEsc(i18n.t('retention.rule.protectWins'))}</li>`);
    const src = p.dateSource === 'metadata' ? i18n.t('retention.sourceMetadata') : i18n.t('retention.sourceNamesFallback');
    items.push(`<li><i data-lucide="calendar" style="width:12px;height:12px"></i> ${retEsc(i18n.t('retention.rule.dateSource', { src }))}</li>`);
    return `
      <div class="ret-rules">
        <div class="ret-list-title">${retEsc(i18n.t('retention.rulesTitle'))}</div>
        <ul>${items.join('')}</ul>
      </div>`;
  }

  _renderLastRun() {
    const r = this.lastRun;
    if (!r || !r.ok) return '';
    return `
      <div class="ret-lastrun">
        <i data-lucide="check-circle-2" style="width:14px;height:14px;color:var(--green)"></i>
        ${retEsc(i18n.t('retention.lastRun', { n: r.deleted, size: this._fmtBytes(r.freed || 0) }))}
        ${(r.failed && r.failed.length) ? `<div class="form-hint" style="color:var(--amber)">${r.failed.length} ${retEsc(i18n.t('retention.failedCount'))}</div>` : ''}
      </div>`;
  }

  _renderProfiles() {
    if (!this.profiles.length) return `<div class="form-hint">${retEsc(i18n.t('retention.noProfiles'))}</div>`;
    return this.profiles.map(p => {
      const status = p.LastStatus || '';
      const statusClass = status === 'Success' ? 'badge-active' : status === 'Error' ? 'badge-error' : status === 'Partial' ? 'badge-warn' : 'badge-disabled';
      return `<div class="ret-profile-row ${p.Enabled ? '' : 'disabled'}" data-retention-profile="${retEsc(p.Id)}">
        <div class="ret-profile-info">
          <div class="ret-profile-name">${retEsc(p.Name)}</div>
          <div class="ret-profile-path mono">${retEsc(p.FolderPath)}</div>
          <div class="ret-profile-meta"><span class="mono">${retEsc(p.CronExpression || '—')}</span>${p.LastRun ? `<span>${retEsc(i18n.t('retention.lastRunAt', { date: new Date(p.LastRun).toLocaleString() }))}</span>` : ''}</div>
        </div>
        <div class="ret-profile-actions">
          <span class="badge ${statusClass}">${retEsc(status || i18n.t('retention.neverRun'))}</span>
          <label class="toggle-switch"><input type="checkbox" ${p.Enabled ? 'checked' : ''} onchange="retentionPage.toggleScheduleProfile('${retEsc(p.Id)}', this.checked)"><span class="toggle-slider"></span></label>
          <button class="btn-outline btn-sm" onclick="retentionPage.runScheduleProfile('${retEsc(p.Id)}')"><i data-lucide="play"></i> ${retEsc(i18n.t('retention.runProfile'))}</button>
          <button class="btn-secondary-sm" onclick="retentionPage.editScheduleProfile('${retEsc(p.Id)}')" title="${retEsc(i18n.t('profile.edit'))}"><i data-lucide="pencil"></i></button>
          <button class="btn-danger" onclick="retentionPage.deleteScheduleProfile('${retEsc(p.Id)}')" title="${retEsc(i18n.t('profile.delete'))}"><i data-lucide="trash-2"></i></button>
        </div>
      </div>`;
    }).join('');
  }

  _currentPreviewKey() {
    return this.folder ? JSON.stringify({ folder: this.folder, policy: { ...this._getCfg() } }) : null;
  }

  _updateScheduleSaveButton() {
    const button = document.querySelector('[data-retention-save]');
    if (button) button.disabled = !(this.preview && this.preview.ok && this.previewKey === this._currentPreviewKey());
  }

  async showScheduleEditor() {
    if (!this.folder || !this.analysis || this.analysis.ok === false || !this.preview || !this.preview.ok) {
      showToast(i18n.t('retention.profileDraftRequired'), 'error');
      return;
    }
    this.editingProfileId = null;
    this.scheduleDraft = {
      Name: `${i18n.t('retention.newProfile')} ${this.profiles.length + 1}`,
      CronExpression: '0 3 * * *',
      Enabled: true,
    };
    this._openScheduleEditor();
  }

  async editScheduleProfile(id) {
    const p = this.profiles.find(x => x.Id === id);
    if (!p) return;
    this.editingProfileId = id;
    this.advanced = true;
    this.folder = p.FolderPath || '';
    this.useMetadata = p.Retention && p.Retention.DateSource === 'metadata';
    this.cfg = { ...this._getCfg(), ...(p.Retention || {}) };
    this._resetResults();
    await this.analyze();
    this.scheduleDraft = {
      Name: p.Name || '',
      CronExpression: p.CronExpression || '0 3 * * *',
      Enabled: p.Enabled !== false,
    };
    this._openScheduleEditor();
  }

  _openScheduleEditor() {
    const d = this.scheduleDraft;
    showModal(`
      <h2><i data-lucide="calendar-clock"></i> ${retEsc(i18n.t(this.editingProfileId ? 'retention.editProfile' : 'retention.newProfile'))}</h2>
      <label class="form-label">${retEsc(i18n.t('retention.profileName'))}</label>
      <input type="text" class="form-input" id="ret-profile-name" value="${retEsc(d.Name)}" oninput="retentionPage.scheduleDraft.Name=this.value">
      <label class="form-label" style="margin-top:12px">${retEsc(i18n.t('summary.schedule'))}</label>
      <input type="text" class="form-input mono" id="ret-profile-cron" value="${retEsc(d.CronExpression)}" oninput="retentionPage.scheduleDraft.CronExpression=this.value">
      <label class="check-row" style="margin-top:14px"><input type="checkbox" ${d.Enabled ? 'checked' : ''} onchange="retentionPage.scheduleDraft.Enabled=this.checked"><span>${retEsc(i18n.t('wizard.enableProfile'))}</span></label>
      <div class="modal-actions"><button class="btn-ghost" onclick="hideModal()">${retEsc(i18n.t('taskModal.cancel'))}</button><button class="btn-glow" data-retention-save onclick="retentionPage.saveScheduleProfile()" ${this.preview && this.preview.ok && this.previewKey === this._currentPreviewKey() ? '' : 'disabled'}>${retEsc(i18n.t('retention.saveProfile'))}</button></div>
    `, true);
    this._updateScheduleSaveButton();
    if (window.lucide) lucide.createIcons();
  }

  async saveScheduleProfile() {
    if (!this.scheduleDraft || !this.preview || !this.preview.ok || this.previewKey !== this._currentPreviewKey()) {
      showToast(i18n.t('retention.previewRequired'), 'error');
      return;
    }
    const d = this.scheduleDraft;
    if (!d.Name || !d.Name.trim() || !d.CronExpression || !d.CronExpression.trim()) {
      showToast(i18n.t('retention.profileFieldsRequired'), 'error');
      return;
    }
    const payload = {
      ...(this.editingProfileId ? { Id: this.editingProfileId } : {}),
      Name: d.Name.trim(),
      FolderPath: this.folder,
      Retention: { ...this._getCfg() },
      CronExpression: d.CronExpression.trim(),
      Enabled: !!d.Enabled,
    };
    try {
      const result = this.editingProfileId
        ? await window.api.updateRetentionProfile(payload)
        : await window.api.createRetentionProfile(payload);
      if (!result || result.success === false) {
        showToast((result && result.message) || i18n.t('retention.profileSaveFailed'), 'error');
        return;
      }
      hideModal();
      this.editingProfileId = null;
      await this.load();
    } catch (e) {
      showToast(e.message || i18n.t('retention.profileSaveFailed'), 'error');
    }
  }

  async toggleScheduleProfile(id, enabled) {
    const p = this.profiles.find(x => x.Id === id);
    if (!p || !window.api.updateRetentionProfile) return;
    const result = await window.api.updateRetentionProfile({ ...p, Enabled: !!enabled });
    if (!result || result.success === false) {
      showToast((result && result.message) || i18n.t('retention.profileSaveFailed'), 'error');
    }
    await this.load();
  }

  async runScheduleProfile(id) {
    if (!window.api.runRetentionProfile) return;
    this.busy = true;
    try {
      const result = await window.api.runRetentionProfile(id);
      if (result && result.success === false) showToast(result.message || i18n.t('retention.profileRunFailed'), 'error');
      else showToast(i18n.t('retention.profileRunOk'), 'success');
    } catch (e) {
      showToast(e.message || i18n.t('retention.profileRunFailed'), 'error');
    } finally {
      this.busy = false;
      await this.load();
    }
  }

  async deleteScheduleProfile(id) {
    const p = this.profiles.find(x => x.Id === id);
    if (!p || !confirm(i18n.t('retention.profileDeleteConfirm', { name: p.Name }))) return;
    if (!window.api.deleteRetentionProfile) return;
    await window.api.deleteRetentionProfile(id);
    await this.load();
  }

  _fmtBytes(b) {
    if (!b) return '0 B';
    if (b > 1073741824) return (b / 1073741824).toFixed(1) + ' GB';
    if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
    if (b > 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
  }
}

window.retentionPage = new RetentionPage();
