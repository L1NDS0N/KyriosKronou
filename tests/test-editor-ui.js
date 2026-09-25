const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNNER = path.join(__dirname, 'fixtures', 'editor-ui-runner.js');

function runEditor() {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON, [RUNNER], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`editor renderer did not finish. stderr:\n${stderr}`));
    }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`editor renderer exited ${code}. stderr:\n${stderr}`));
      const line = stdout.split(/\r?\n/).reverse().find(value => value.startsWith('EDITOR_UI_RESULT='));
      if (!line) return reject(new Error(`editor renderer returned no result. stdout:\n${stdout}\nstderr:\n${stderr}`));
      try { resolve(JSON.parse(line.slice('EDITOR_UI_RESULT='.length))); }
      catch (error) { reject(error); }
    });
  });
}

describe('Renderer component cleanup', () => {
  const renderer = path.join(__dirname, '..', 'src', 'renderer');
  const index = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const desktopCss = fs.readFileSync(path.join(renderer, 'style.css'), 'utf8');
  const webCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'style.css'), 'utf8');

  it('loads the native editors without CodeMirror assets', () => {
    expect(index).to.not.match(/codemirror|show-hint|matchbrackets|closebrackets|active-line/i);
    expect(index).to.include('simpleRichText.js');
    expect(index).to.include('scriptEditor.js');
  });

  it('uses rectangular badges without automatic dots on desktop and web', () => {
    expect(desktopCss).to.not.match(/\.badge::before/);
    expect(webCss).to.not.match(/\.badge::before/);
    expect(desktopCss).to.match(/\.badge-warn/);
  });

  it('removes the mysqldump status card from the backups page', () => {
    expect(index).to.not.include('id="mysqldump-status"');
  });
});

describe('Task editor UI in the real Electron renderer', () => {
  let result;

  before(async function () {
    if (!fs.existsSync(ELECTRON)) return this.skip();
    result = await runEditor();
  });

  it('opens rich text and script editing in separate modal layers', () => {
    expect(result.richParent).to.equal('rich-text-overlay');
    expect(result.scriptParent).to.equal('script-editor-overlay');
    expect(result.overlayHidden).to.equal(true);
    expect(result.codeMirrorLoaded).to.equal(false);
    expect(result.richFocus).to.equal('rich-opener');
    expect(result.scriptFocus).to.equal('script-opener');
    expect(result.richFocusWrapped).to.equal(true);
    expect(result.scriptFocusWrapped).to.equal(true);
  });

  it('sanitizes rich text and keeps safe links', () => {
    expect(result.richHtml).to.not.include('script');
    expect(result.richHtml).to.not.include('onclick');
    expect(result.richHtml).to.not.include('onerror');
    expect(result.richHtml).to.not.include('javascript:');
    expect(result.richHtml).to.include('<strong>Nightly</strong>');
    expect(result.richHtml).to.include('https://example.com');
    expect(result.richApplied.text).to.equal('Nightlybadgood');
  });

  it('preserves script text exactly and supports cancel without applying', () => {
    expect(result.scriptApplied).to.deep.equal({ content: '  Write-Host "keep spaces"\r\n', type: 'bat' });
    expect(result.canceled).to.equal(false);
  });
});
