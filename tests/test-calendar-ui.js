const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNNER = path.join(__dirname, 'fixtures', 'calendar-ui-runner.js');

function runCalendar() {
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
      reject(new Error(`calendar renderer did not finish. stderr:\n${stderr}`));
    }, 30000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`calendar renderer exited ${code}. stderr:\n${stderr}`));
      const line = stdout.split(/\r?\n/).reverse().find(value => value.startsWith('CALENDAR_UI_RESULT='));
      if (!line) return reject(new Error(`calendar renderer returned no result. stdout:\n${stdout}\nstderr:\n${stderr}`));
      try { resolve(JSON.parse(line.slice('CALENDAR_UI_RESULT='.length))); }
      catch (error) { reject(error); }
    });
  });
}

describe('Calendar UI in the real Electron renderer', () => {
  let result;

  before(async function () {
    if (!fs.existsSync(ELECTRON)) return this.skip();
    result = await runCalendar();
  });

  it('renders a complete and organized month without overflowing May 31 into July', () => {
    expect(result.firstRender.days).to.equal(42);
    expect(result.firstRender.cellsWithItems).to.equal(1);
    expect(result.firstRender.chips).to.equal(1);
    expect(result.firstRender.metrics).to.equal(4);
    expect(result.junePeriod.toLowerCase()).to.include('june');
  });

  it('keeps the selected view when an older request resolves last', () => {
    expect(result.duringAgenda).to.equal(true);
    expect(result.finalView).to.equal('agenda');
    expect(result.staleVisible).to.equal(false);
  });
});
