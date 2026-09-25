const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNNER = path.join(__dirname, 'fixtures', 'retention-ui-runner.js');

function runRetention() {
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
      reject(new Error(`retention renderer did not finish. stderr:\n${stderr}`));
    }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`retention renderer exited ${code}. stderr:\n${stderr}`));
      const line = stdout.split(/\r?\n/).reverse().find(value => value.startsWith('RETENTION_UI_RESULT='));
      if (!line) return reject(new Error(`retention renderer returned no result. stdout:\n${stdout}\nstderr:\n${stderr}`));
      try { resolve(JSON.parse(line.slice('RETENTION_UI_RESULT='.length))); }
      catch (error) { reject(error); }
    });
  });
}

describe('Retention UI in the real Electron renderer', () => {
  let result;

  before(async function () {
    if (!fs.existsSync(ELECTRON)) return this.skip();
    result = await runRetention();
  });

  it('keeps the preview permanently visible without opening a modal', () => {
    expect(result.sidebarVisible).to.equal(true);
    expect(result.previewButtonCount).to.equal(0);
    expect(result.modalCalls).to.equal(0);
  });

  it('stretches the retention layout and sidebar with the window', () => {
    expect(result.responsive.narrow.columns).to.equal(1);
    expect(result.responsive.wide.columns).to.equal(2);
    expect(result.responsive.wide.sidebar).to.be.within(400, 800);
    expect(result.responsive.wide.layout).to.be.greaterThan(result.responsive.narrow.layout + 400);
    expect(result.responsive.wide.maxWidth).to.equal('none');
  });

  it('standardizes primary, small and destructive button sizes', () => {
    expect(result.responsive.wide.primaryButton).to.equal(34);
    expect(result.responsive.wide.smallButton).to.equal(28);
    expect(result.responsive.wide.dangerButton).to.equal(28);
    expect(result.responsive.wide.disabledOpacity).to.equal('0.4');
  });

  it('defaults to 30 recent files plus monthly retention', () => {
    expect(result.defaultPolicy.ByCount).to.equal(true);
    expect(result.defaultPolicy.KeepCount).to.equal(30);
    expect(result.defaultPolicy.ByMonthly).to.equal(true);
    expect(result.defaultPolicy.MonthlyKeepMonths).to.equal(12);
    expect(result.defaultPolicy.ByAge).to.equal(false);
    expect(result.defaultPolicy.ByWeekly).to.equal(false);
    expect(result.defaultPolicy.ByBiweekly).to.equal(false);
    expect(result.defaultPolicy.BySize).to.equal(false);
    expect(result.analyzedPolicy).to.deep.equal(result.defaultPolicy);
    expect(result.defaultControls).to.deep.equal({ count: true, countValue: '30', monthly: true, months: '12', advancedAge: false });
  });

  it('keeps the folder input and its focus while typing', () => {
    expect(result.folderInputPreserved).to.equal(true);
    expect(result.folderFocusPreserved).to.equal(true);
  });

  it('keeps Apply disabled without a successful preview', () => {
    expect(result.initialDisabled).to.equal(true);
    expect(result.failedDisabled).to.equal(true);
    expect(result.blocked.applyCalls).to.equal(0);
    expect(result.blocked.confirmCalls).to.equal(0);
    expect(result.blocked.toasts).to.have.lengthOf(1);
    expect(result.blocked.toasts[0].type).to.equal('error');
  });

  it('invalidates the preview whenever the policy changes', () => {
    expect(result.successEnabled).to.equal(true);
    expect(result.changedDisabled).to.equal(true);
  });

  it('groups the preview by folder and defaults to 7z and zip formats', () => {
    expect(result.folderAccordions).to.equal(1);
    expect(result.defaultFormats).to.deep.equal(['.7z', '.zip']);
    expect(result.customFormats).to.deep.equal(['.7z', '.zip', '.bak']);
    expect(result.allFormats).to.deep.equal([]);
  });

  it('offers a file tree that shows the pattern matched by every file', () => {
    expect(result.previewViewButtons).to.equal(2);
    expect(result.treeModeActive).to.equal(true);
    expect(result.treeFolders).to.equal(3);
    expect(result.treeFiles).to.equal(2);
    expect(result.treePattern).to.equal('dated-folders');
    expect(result.treePatternText).to.match(/dated/i);
  });

  it('lists scheduled profiles and runs them by persisted id', () => {
    expect(result.profileRows).to.equal(1);
    expect(result.profileRuns).to.deep.equal(['scheduled-1']);
  });

  it('applies the exact policy that was previewed', () => {
    expect(result.applyCalls).to.equal(1);
    expect(result.appliedPolicy.DateSource).to.equal('names');
    expect(result.appliedPolicy.KeepDays).to.equal(45);
    expect(result.appliedPolicy.MinKeep).to.equal(5);
  });
});
