class SimpleRichText {
  constructor() {
    this.overlay = null;
    this.editor = null;
    this.onApply = null;
    this.opener = null;
  }

  t(key) {
    return typeof i18n !== 'undefined' && i18n.t ? i18n.t(key) : key;
  }

  safeUrl(value) {
    const raw = String(value || '').replace(/[\u0000-\u0020]+/g, '').trim();
    try {
      const url = new URL(raw);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
    } catch (error) {
      return null;
    }
  }

  sanitize(html) {
    const input = document.createElement('template');
    input.innerHTML = String(html || '');
    const output = document.createElement('div');
    const allowed = new Map([
      ['STRONG', 'STRONG'], ['B', 'STRONG'], ['EM', 'EM'], ['I', 'EM'],
      ['UL', 'UL'], ['OL', 'OL'], ['LI', 'LI'], ['BR', 'BR'], ['P', 'P'], ['A', 'A'],
    ]);
    const dropped = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'TEMPLATE', 'NOSCRIPT']);
    const append = (source, target) => {
      for (const node of source.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          target.appendChild(document.createTextNode(node.textContent || ''));
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (dropped.has(node.tagName)) continue;
        const tag = allowed.get(node.tagName);
        if (!tag) {
          append(node, target);
          continue;
        }
        const clean = document.createElement(tag);
        if (tag === 'A') {
          const href = this.safeUrl(node.getAttribute('href'));
          if (!href) {
            append(node, clean);
          } else {
            clean.setAttribute('href', href);
            clean.setAttribute('target', '_blank');
            clean.setAttribute('rel', 'noopener noreferrer');
            append(node, clean);
          }
        } else {
          append(node, clean);
        }
        target.appendChild(clean);
      }
    };
    append(input.content, output);
    return output.innerHTML;
  }

  toText(html) {
    const node = document.createElement('div');
    node.innerHTML = this.sanitize(html);
    for (const item of node.querySelectorAll('li')) item.appendChild(document.createTextNode('\n'));
    return node.textContent.replace(/\n{3,}/g, '\n\n').trim();
  }

  fromText(text) {
    const node = document.createElement('div');
    node.textContent = String(text || '');
    return node.innerHTML.replace(/\n/g, '<br>');
  }

  ensureOverlay() {
    this.overlay = document.getElementById('rich-text-overlay');
    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.id = 'rich-text-overlay';
      this.overlay.className = 'secondary-modal-overlay hidden';
      document.body.appendChild(this.overlay);
    }
    if (this.overlay.dataset.ready) return;
    this.overlay.dataset.ready = '1';
    this.overlay.addEventListener('click', event => {
      if (event.target === this.overlay) this.cancel();
    });
    this.overlay.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        const focusable = Array.from(this.overlay.querySelectorAll('button:not(:disabled), [contenteditable="true"]')).filter(element => element.offsetParent !== null);
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
    });
  }

  open(options = {}) {
    this.ensureOverlay();
    this.opener = document.activeElement;
    this.onApply = options.onApply || null;
    const initial = this.sanitize(options.html || this.fromText(options.text || ''));
    this.overlay.innerHTML = `
      <div class="secondary-modal rich-text-modal" role="dialog" aria-modal="true" aria-labelledby="rich-text-title">
        <div class="secondary-modal-header">
          <h2 id="rich-text-title"><i data-lucide="text"></i> ${this.t('richText.title')}</h2>
          <button class="btn-secondary-sm" type="button" data-rich-cancel>${this.t('taskModal.cancel')}</button>
        </div>
        <div class="rich-text-toolbar" role="toolbar" aria-label="${this.t('richText.toolbar')}">
          <button type="button" data-rich-command="bold" aria-label="${this.t('richText.bold')}"><i data-lucide="bold"></i></button>
          <button type="button" data-rich-command="italic" aria-label="${this.t('richText.italic')}"><i data-lucide="italic"></i></button>
          <button type="button" data-rich-command="insertUnorderedList" aria-label="${this.t('richText.unorderedList')}"><i data-lucide="list"></i></button>
          <button type="button" data-rich-command="insertOrderedList" aria-label="${this.t('richText.orderedList')}"><i data-lucide="list-ordered"></i></button>
          <button type="button" data-rich-command="removeFormat" aria-label="${this.t('richText.removeFormatting')}"><i data-lucide="eraser"></i></button>
          <button type="button" data-rich-link aria-label="${this.t('richText.link')}"><i data-lucide="link"></i></button>
        </div>
        <div id="rich-text-editor" class="rich-text-editor" contenteditable="true" role="textbox" aria-multiline="true"></div>
        <div id="rich-text-error" class="form-hint" role="alert"></div>
        <div class="secondary-modal-actions">
          <button class="btn-ghost" type="button" data-rich-cancel>${this.t('taskModal.cancel')}</button>
          <button class="btn-glow" type="button" data-rich-apply><i data-lucide="check"></i> ${this.t('richText.apply')}</button>
        </div>
      </div>`;
    this.editor = document.getElementById('rich-text-editor');
    this.editor.innerHTML = initial;
    this.editor.addEventListener('paste', event => {
      event.preventDefault();
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    });
    this.editor.addEventListener('drop', event => {
      event.preventDefault();
      const text = event.dataTransfer.getData('text/plain');
      document.execCommand('insertText', false, text);
    });
    this.overlay.querySelectorAll('[data-rich-command]').forEach(button => {
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', () => {
        this.editor.focus();
        document.execCommand(button.dataset.richCommand, false, null);
      });
    });
    this.overlay.querySelector('[data-rich-link]').addEventListener('click', () => this.createLink());
    this.overlay.querySelectorAll('[data-rich-cancel]').forEach(button => button.addEventListener('click', () => this.cancel()));
    this.overlay.querySelector('[data-rich-apply]').addEventListener('click', () => this.apply());
    this.overlay.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
    this.editor.focus();
  }

  createLink() {
    this.editor.focus();
    const selected = window.getSelection().toString();
    const value = window.prompt(this.t('richText.linkPrompt'), 'https://');
    if (value == null) return;
    const href = this.safeUrl(value);
    const error = document.getElementById('rich-text-error');
    if (!href) {
      error.textContent = this.t('richText.invalidUrl');
      return;
    }
    error.textContent = '';
    if (selected) document.execCommand('createLink', false, href);
    else document.execCommand('insertText', false, href);
  }

  apply() {
    const html = this.sanitize(this.editor.innerHTML);
    const text = this.toText(html);
    const callback = this.onApply;
    const opener = this.opener;
    this.close();
    if (callback) callback({ html, text });
    if (opener && opener.isConnected) opener.focus();
  }

  cancel() {
    const opener = this.opener;
    this.close();
    if (opener && opener.isConnected) opener.focus();
  }

  close() {
    this.overlay.classList.add('hidden');
    this.overlay.innerHTML = '';
    this.editor = null;
    this.onApply = null;
  }

  renderPreview(element, task) {
    if (!element) return;
    if (task && task.DescriptionHtml) element.innerHTML = this.sanitize(task.DescriptionHtml);
    else element.textContent = task && task.Description ? task.Description : '';
  }
}

window.simpleRichText = new SimpleRichText();
