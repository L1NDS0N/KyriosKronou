const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNNER = path.join(__dirname, 'fixtures', 'sync-ui-runner.js');

function runRealRenderer() {
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
      reject(new Error(`real sync renderer did not finish. stderr:\n${stderr}`));
    }, 30000);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`real sync renderer exited ${code}. stderr:\n${stderr}`));
      const line = stdout.split(/\r?\n/).reverse().find(value => value.startsWith('SYNC_UI_RESULT='));
      if (!line) return reject(new Error(`real sync renderer returned no result. stdout:\n${stdout}\nstderr:\n${stderr}`));
      try {
        resolve(JSON.parse(line.slice('SYNC_UI_RESULT='.length)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe('Sync UI in the real Electron renderer', () => {
  let result;

  before(async function () {
    if (!fs.existsSync(ELECTRON)) return this.skip();
    result = await runRealRenderer();
  });

  it('loads profile history concurrently and exposes an explicit edit action', () => {
    expect(result.menu.cards).to.equal(3);
    expect(result.menu.maxHistoryRequests).to.equal(3);
    expect(result.menu.editButtons).to.equal(3);
  });

  it('keeps exactly one Save button on every wizard tab', () => {
    expect(result.saveButtonsByTab).to.deep.equal([
      { step: 0, count: 1, text: 'Save' },
      { step: 1, count: 1, text: 'Save' },
      { step: 2, count: 1, text: 'Save' },
    ]);
  });

  it('applies retention action prerequisites and invalidation rules', () => {
    expect(result.actionState).to.deep.equal({ emptyAnalyze: true, emptyPreview: true, emptySimulate: true });
    expect(result.actionEnabled).to.deep.equal({ analyze: true, preview: true, simulate: true });
    expect(result.actionCalls).to.deep.equal({ analyze: 1, preview: 1, simulate: 1 });
    expect(result.invalidated).to.equal(true);
  });

  it('saves the current draft when Save is used outside the last tab', () => {
    expect(result.saves).to.have.length(2);
    expect(result.saves[0].operation).to.equal('create');
    expect(result.saves[0].profile.SourcePath).to.equal('C:/source');
    expect(result.saves[0].profile.DestPath).to.equal('D:/destination');
    expect(result.saves[1].operation).to.equal('create');
    expect(result.saves[1].profile.SourcePath).to.equal('C:/source-2');
    expect(result.saves[1].profile.DestPath).to.equal('D:/destination-2');
  });
});
