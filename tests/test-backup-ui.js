const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'fixtures', 'backup-ui-runner.js');

// Sobe o renderer pelo helper compartilhado. Ver tests/fixtures/electron-runner.js:
// o primeiro spawn numa maquina fria passa de 30s (medido: 47s), e o timeout
// curto matava um processo que so estava lento. O helper repete uma vez e
// distingue lentidao de travamento.
const { rodar, ELECTRON } = require('./fixtures/electron-runner');

const runBackup = () => rodar(RUNNER, 'backup renderer');
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
