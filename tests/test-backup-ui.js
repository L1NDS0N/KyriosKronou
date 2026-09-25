const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNNER = path.join(__dirname, 'fixtures', 'backup-ui-runner.js');

function runBackup() {
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
      reject(new Error(`backup renderer did not finish. stderr:\n${stderr}`));
    }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`backup renderer exited ${code}. stderr:\n${stderr}`));
      const line = stdout.split(/\r?\n/).reverse().find(value => value.startsWith('BACKUP_UI_RESULT='));
      if (!line) return reject(new Error(`backup renderer returned no result. stdout:\n${stdout}\nstderr:\n${stderr}`));
      try { resolve(JSON.parse(line.slice('BACKUP_UI_RESULT='.length))); }
      catch (error) { reject(error); }
    });
  });
}

describe('Backup UI in the real Electron renderer', () => {
  let result;

  before(async function () {
    if (!fs.existsSync(ELECTRON)) return this.skip();
    result = await runBackup();
  });

  it('survives legacy profiles and failed history lookups while loading concurrently', () => {
    expect(result.list.cards).to.equal(2);
    expect(result.list.undefinedVisible).to.equal(false);
    expect(result.list.maxActiveStats).to.equal(2);
    expect(result.pageErrors).to.deep.equal([]);
  });

  it('does not query or render the removed mysqldump status', () => {
    expect(result.list.mysqldumpChecks).to.equal(0);
    expect(result.list.statusHost).to.equal(false);
  });

  it('keeps a failed profile save open and reports the backend error', () => {
    expect(result.save.modalOpen).to.equal(true);
    expect(result.save.hideCalls).to.equal(0);
    expect(result.save.buttonEnabled).to.equal(true);
    expect(result.save.saving).to.equal(false);
    expect(result.save.toasts).to.have.lengthOf(1);
    expect(result.save.toasts[0]).to.deep.equal({ message: 'Destination is read-only', type: 'error' });
  });
});

describe('Backup UI: the local artifact action on a history result', () => {
  let result;

  before(async function () {
    if (!fs.existsSync(ELECTRON)) return this.skip();
    result = await runBackup();
  });

  it('offers one action per successful result, and none for the failed one', () => {
    // app has a local file, billing was written on the database host, legacy
    // failed: the failed one has nothing to open.
    expect(result.history.buttons).to.equal(2);
    expect(result.history.artifactLabels[0]).to.equal('Show in Explorer');
    expect(result.history.artifactLabels[1]).to.equal('Open folder');
  });

  // The main process rebuilds the path from the profile folder, so the renderer
  // only ever hands over a name.
  it('sends the profile id and the file name, never a path', () => {
    expect(result.history.revealCalls).to.deep.equal([{ profileId: 'normal', name: 'app_20260102_030405.sql' }]);
    // Twice: once as the fallback for the missing file, once for the result that
    // was written on the database host and has no local file at all.
    expect(result.history.folderCalls).to.deep.equal(['normal', 'normal']);
  });

  it('falls back to the folder when the file is gone, and says so', () => {
    expect(result.history.toasts).to.deep.equal(['info', 'success']);
  });

  // The row toggles on click; an action button that also collapses the row it
  // lives in would be its own annoyance.
  it('does not toggle the history row when the button is used', () => {
    expect(result.history.rowToggled).to.equal(false);
  });
});
