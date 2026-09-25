const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 760,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });

  try {
    await win.loadFile(path.join(__dirname, 'editor-ui.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      showModal('<button id="rich-opener">Edit description</button><button id="script-opener">Open script</button>');
      const richOpener = document.getElementById('rich-opener');
      richOpener.focus();
      let richApplied = null;
      simpleRichText.open({
        html: '<p onclick="alert(1)"><strong>Nightly</strong><script>alert(2)<\\/script><a href="javascript:alert(3)" style="color:red">bad</a><a href="https://example.com">good</a><img src=x onerror=alert(4)></p>',
        onApply: value => { richApplied = value; },
      });
      const richHtml = document.querySelector('#rich-text-editor').innerHTML;
      const richParent = document.querySelector('#rich-text-overlay .secondary-modal').parentElement.id;
      const richFirst = document.querySelector('#rich-text-overlay button');
      const richLast = document.querySelector('[data-rich-apply]');
      richLast.focus();
      richLast.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const richFocusWrapped = document.activeElement === richFirst;
      document.querySelector('[data-rich-apply]').click();
      const richFocus = document.activeElement.id;

      document.getElementById('script-opener').focus();
      let scriptApplied = null;
      scriptEditor.open({
        content: '  Write-Host "keep spaces"\\r\\n',
        type: 'ps1',
        onApply: value => { scriptApplied = value; },
      });
      const scriptParent = document.querySelector('#script-editor-overlay .script-text-modal').parentElement.id;
      const scriptFirst = document.querySelector('#script-editor-overlay button');
      const scriptLast = document.querySelector('[data-script-apply]');
      document.querySelector('[data-script-type="bat"]').click();
      scriptLast.focus();
      scriptLast.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const scriptFocusWrapped = document.activeElement === scriptFirst;
      document.querySelector('[data-script-apply]').click();
      const scriptFocus = document.activeElement.id;

      let canceled = false;
      scriptEditor.open({ content: 'discard me', onApply: () => { canceled = true; } });
      document.querySelector('[data-script-cancel]').click();

      return {
        richHtml,
        richParent,
        richApplied,
        richFocus,
        richFocusWrapped,
        scriptParent,
        scriptApplied,
        scriptFocus,
        scriptFocusWrapped,
        canceled,
        overlayHidden: document.getElementById('script-editor-overlay').classList.contains('hidden'),
        codeMirrorLoaded: typeof window.CodeMirror !== 'undefined',
      };
    })()`);
    process.stdout.write(`EDITOR_UI_RESULT=${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    app.exit(1);
  }
});
