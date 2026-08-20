// scriptEditor.js - Inline Script Editor using CodeMirror
// Manages script creation, editing, and saving for tasks

class ScriptEditor {
  constructor() {
    this.editor = null;
    this.currentTaskId = null;
    this.currentType = 'ps1';
    this.scriptsDir = null; // Set from main process
  }

  // Initialize CodeMirror editor in a container element
  init(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !window.CodeMirror) return null;

    // Create mode selector + editor wrapper
    container.innerHTML = `
      <div class="script-editor-toolbar">
        <div class="script-type-selector">
          <button class="script-type-btn active" data-type="ps1" onclick="scriptEditor.setMode('ps1')">
            <i data-lucide="file-code"></i> PowerShell (.ps1)
          </button>
          <button class="script-type-btn" data-type="bat" onclick="scriptEditor.setMode('bat')">
            <i data-lucide="file-text"></i> Batch (.bat)
          </button>
        </div>
        <div class="script-editor-actions">
          <button class="btn-secondary-sm" onclick="scriptEditor.formatScript()" title="Format document">
            <i data-lucide="align-left"></i> Format
          </button>
          <button class="btn-secondary-sm" onclick="scriptEditor.clearScript()" title="Clear editor">
            <i data-lucide="eraser"></i> Clear
          </button>
        </div>
      </div>
      <div class="script-editor-wrap">
        <textarea id="script-editor-textarea"></textarea>
      </div>
      <div class="script-editor-status">
        <span id="script-status-mode">PowerShell</span>
        <span id="script-status-lines">Ln 1, Col 1</span>
        <span id="script-status-size">0 bytes</span>
      </div>
    `;

    this.editor = CodeMirror.fromTextArea(document.getElementById('script-editor-textarea'), {
      mode: 'powershell',
      theme: 'cronmaster-dark',
      lineNumbers: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      styleActiveLine: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      lineWrapping: true,
      scrollbarStyle: 'native',
      extraKeys: {
        'Ctrl-Space': 'autocomplete',
        'Tab': (cm) => {
          if (cm.somethingSelected()) {
            cm.indentSelection('add');
          } else {
            cm.replaceSelection('  ', 'end');
          }
        }
      }
    });

    // Update status bar on cursor activity
    this.editor.on('cursorActivity', () => {
      const pos = this.editor.getCursor();
      const lines = this.editor.lineCount();
      const size = new Blob([this.editor.getValue()]).size;
      const modeLabel = this.currentType === 'ps1' ? 'PowerShell' : 'Batch';
      document.getElementById('script-status-mode').textContent = modeLabel;
      document.getElementById('script-status-lines').textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1} | ${lines} lines`;
      document.getElementById('script-status-size').textContent = `${size} bytes`;
    });

    // Trigger initial resize
    setTimeout(() => this.editor.refresh(), 100);

    if (window.lucide) lucide.createIcons();
    return this.editor;
  }

  setMode(type) {
    this.currentType = type;
    const mode = type === 'ps1' ? 'powershell' : 'shell';
    this.editor.setOption('mode', mode);

    // Update toolbar buttons
    document.querySelectorAll('.script-type-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.type === type);
    });

    const modeLabel = type === 'ps1' ? 'PowerShell' : 'Batch';
    document.getElementById('script-status-mode').textContent = modeLabel;
  }

  // Load a script from file path
  async loadFromFile(filePath) {
    try {
      const content = await window.api.readScriptFile(filePath);
      if (content.success) {
        this.editor.setValue(content.content);
        // Detect type from extension
        if (filePath.endsWith('.bat') || filePath.endsWith('.cmd')) {
          this.setMode('bat');
        } else {
          this.setMode('ps1');
        }
        return true;
      }
    } catch (e) {
      console.error('Failed to load script:', e);
    }
    return false;
  }

  // Load script content directly (from task's ScriptContent field)
  loadContent(content, type) {
    this.editor.setValue(content || '');
    if (type) this.setMode(type);
  }

  // Get current content
  getContent() {
    return this.editor ? this.editor.getValue() : '';
  }

  // Get current mode
  getMode() {
    return this.currentType;
  }

  // Get file extension
  getExtension() {
    return this.currentType === 'ps1' ? '.ps1' : '.bat';
  }

  // Set editor readonly
  setReadOnly(readonly) {
    if (this.editor) {
      this.editor.setOption('readOnly', readonly);
    }
  }

  // Clear the editor
  clearScript() {
    if (this.editor && this.editor.getValue().trim()) {
      if (confirm('Clear the editor content?')) {
        this.editor.setValue('');
        this.editor.clearHistory();
      }
    }
  }

  // Simple format/indent
  formatScript() {
    if (!this.editor) return;
    const content = this.editor.getValue();
    const lines = content.split('\n');
    let indent = 0;
    const formatted = lines.map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      // Decrease indent for closing braces/keywords
      if (/^\}/.test(trimmed) || /^(end|catch|finally|else|elseif)/i.test(trimmed)) {
        indent = Math.max(0, indent - 1);
      }
      const result = '  '.repeat(indent) + trimmed;
      // Increase indent for opening braces
      if (/\{\s*$/.test(trimmed) || /^(function|if|else|elseif|foreach|for|while|do|try|catch|finally|switch|case)/i.test(trimmed)) {
        if (!/^\}/.test(trimmed)) indent++;
      }
      return result;
    });
    this.editor.setValue(formatted.join('\n'));
  }

  // Destroy editor
  destroy() {
    if (this.editor) {
      this.editor.toTextArea();
      this.editor = null;
    }
  }
}

// Global instance
const scriptEditor = new ScriptEditor();
