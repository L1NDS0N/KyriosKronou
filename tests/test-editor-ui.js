const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'fixtures', 'editor-ui-runner.js');

const { rodar, ELECTRON } = require('./fixtures/electron-runner');

const runEditor = () => rodar(RUNNER, 'editor renderer');

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
