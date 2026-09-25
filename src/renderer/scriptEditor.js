class ScriptEditor {
  constructor() {
    this.editor = null;
    this.currentType = 'ps1';
    this.content = '';
    this.overlay = null;
    this.onApply = null;
    this.opener = null;
    this.dirty = false;
  }

  t(key) {
    return typeof i18n !== 'undefined' && i18n.t ? i18n.t(key) : key;
  }

  ensureOverlay() {
    this.overlay = document.getElementById('script-editor-overlay');
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.id = 'script-editor-overlay';
      this.overlay.className = 'secondary-modal-overlay hidden';
      document.body.appendChild(this.overlay);
    }
    if (this.overlay.dataset.ready) return;
    this.overlay.dataset.ready = '1';
    this.overlay.addEventListener('click', event => {
      if (event.target === this.overlay) this.cancel();
    });
    this.overlay.addEventListener('keydown', event => {
      if (event.key === 'Tab' && event.target !== this.editor) {
        const focusable = Array.from(this.overlay.querySelectorAll('button:not(:disabled), textarea')).filter(element => element.offsetParent !== null);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && event.target === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.apply();
      }
    });
  }

  open(options = {}) {
    this.ensureOverlay();
    this.opener = document.activeElement;
    this.onApply = options.onApply || null;
    this.content = String(options.content || '');
    this.currentType = options.type === 'bat' ? 'bat' : 'ps1';
    this.dirty = false;
    this.overlay.innerHTML = `
      <div class="secondary-modal script-text-modal" role="dialog" aria-modal="true" aria-labelledby="script-editor-title">
        <div class="secondary-modal-header">
          <h2 id="script-editor-title"><i data-lucide="code-2"></i> ${this.t('scriptEditor.title')}</h2>
          <button class="btn-secondary-sm" type="button" data-script-cancel>${this.t('taskModal.cancel')}</button>
        </div>
        <div class="script-editor-toolbar">
          <div class="script-type-selector" role="group" aria-label="${this.t('scriptEditor.language')}">
            <button class="script-type-btn ${this.currentType === 'ps1' ? 'active' : ''}" type="button" data-script-type="ps1">PowerShell</button>
            <button class="script-type-btn ${this.currentType === 'bat' ? 'active' : ''}" type="button" data-script-type="bat">Batch</button>
          </div>
          <button class="btn-secondary-sm" type="button" data-script-clear><i data-lucide="eraser"></i> ${this.t('scriptEditor.clear')}</button>
        </div>
        <textarea id="script-editor-textarea" class="script-editor-textarea" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="${this.t('scriptEditor.content')}"></textarea>
        <div class="script-editor-status"><span id="script-status-mode">${this.currentType === 'ps1' ? 'PowerShell' : 'Batch'}</span><span id="script-status-size">0 bytes</span></div>
        <div class="secondary-modal-actions">
          <button class="btn-ghost" type="button" data-script-cancel>${this.t('taskModal.cancel')}</button>
          <button class="btn-glow" type="button" data-script-apply><i data-lucide="check"></i> ${this.t('scriptEditor.apply')}</button>
        </div>
      </div>`;
    this.editor = document.getElementById('script-editor-textarea');
    this.editor.value = this.content;
    this.editor.addEventListener('input', () => { this.dirty = true; this.updateStatus(); });
    this.editor.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = this.editor.selectionStart;
        this.editor.setRangeText('  ', start, this.editor.selectionEnd, 'end');
      }
    });
    this.overlay.querySelectorAll('[data-script-type]').forEach(button => {
      button.addEventListener('click', () => this.setMode(button.dataset.scriptType));
    });
    this.overlay.querySelector('[data-script-clear]').addEventListener('click', () => this.clearScript());
    this.overlay.querySelectorAll('[data-script-cancel]').forEach(button => button.addEventListener('click', () => this.cancel()));
    this.overlay.querySelector('[data-script-apply]').addEventListener('click', () => this.apply());
    this.overlay.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
    this.updateStatus();
    this.editor.focus();
  }

  setMode(type) {
    this.currentType = type === 'bat' ? 'bat' : 'ps1';
    if (!this.editor) return;
    this.overlay.querySelectorAll('[data-script-type]').forEach(button => {
      button.classList.toggle('active', button.dataset.scriptType === this.currentType);
    });
    this.updateStatus();
  }

  updateStatus() {
    if (!this.editor) return;
    const mode = document.getElementById('script-status-mode');
    const size = document.getElementById('script-status-size');
    if (mode) mode.textContent = this.currentType === 'ps1' ? 'PowerShell' : 'Batch';
    if (size) size.textContent = `${new Blob([this.editor.value]).size} ${this.t('scriptEditor.bytes')}`;
  }

  clearScript() {
    if (this.editor && this.editor.value && !window.confirm(this.t('scriptEditor.clearConfirm'))) return;
    if (this.editor) {
      this.editor.value = '';
      this.dirty = true;
      this.updateStatus();
      this.editor.focus();
    }
  }

  loadContent(content, type) {
    this.content = String(content || '');
    if (type) this.currentType = type === 'bat' ? 'bat' : 'ps1';
    if (this.editor) this.editor.value = this.content;
  }

  getContent() {
    return this.editor ? this.editor.value : this.content;
  }

  getMode() {
    return this.currentType;
  }

  getExtension() {
    return this.currentType === 'ps1' ? '.ps1' : '.bat';
  }

  apply() {
    const content = this.dirty ? this.editor.value : this.content;
    const type = this.currentType;
    const callback = this.onApply;
    const opener = this.opener;
    this.close();
    if (callback) callback({ content, type });
    if (opener && opener.isConnected) opener.focus();
  }

  cancel() {
    const opener = this.opener;
    this.close();
    if (opener && opener.isConnected) opener.focus();
  }

  close() {
    if (this.overlay) {
      this.overlay.classList.add('hidden');
      this.overlay.innerHTML = '';
    }
    this.editor = null;
    this.onApply = null;
  }

  destroy() {
    this.content = '';
    this.currentType = 'ps1';
    this.close();
  }
}

const scriptEditor = new ScriptEditor();
window.scriptEditor = scriptEditor;
