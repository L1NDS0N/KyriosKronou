// tests/test-backup-artifacts.js
//
// "Show in Explorer" for a backup is the one place where a path typed by a
// renderer becomes a path Explorer is asked to open. backup-history.json is a
// file any process with write access can edit, so the name that comes from the UI
// is treated as hostile input: the path is rebuilt from the profile's own folder
// and nothing is opened unless the result is a real file inside it.
//
// These tests run against a real temp folder, because the whole point of the
// module is what the filesystem says, not what a mock was told to say.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const artifacts = require('../src/main/backupArtifacts');

const B = String.fromCharCode(92); // backslash

function managerFor(profiles) {
  return { getProfile: (id) => profiles.find(p => p.Id === id) || null };
}

describe('Backup artifacts: the name the UI sends', () => {
  it('accepts a plain file name', () => {
    expect(artifacts.validateName('app_20260102_030405.sql')).to.deep.equal({ ok: true, name: 'app_20260102_030405.sql' });
  });

  it('refuses an empty name', () => {
    for (const empty of ['', '   ', null, undefined, 42, {}]) {
      expect(artifacts.validateName(empty).reason, `accepted ${JSON.stringify(empty)}`)
        .to.equal(artifacts.REASONS.NAME_MISSING);
    }
  });

  // The Win32 API stops reading the name at the null byte, so "app.sql\0.dll"
  // is a bypass on its own - before any path is resolved.
  it('refuses a name carrying a null byte', () => {
    const r = artifacts.validateName(`app.sql${String.fromCharCode(0)}.dll`);
    expect(r.reason).to.equal(artifacts.REASONS.INVALID_NAME);
  });

  it('refuses anything that is a path rather than a name', () => {
    const cases = ['..', '.', '..' + B + 'Windows' + B + 'System32',
      'sub' + B + 'app.sql', 'sub/app.sql', 'C:' + B + 'Windows' + B + 'win.ini',
      'C:app.sql', B + B + 'server' + B + 'share' + B + 'app.sql'];
    for (const name of cases) {
      expect(artifacts.validateName(name).reason, `accepted ${name}`).to.equal(artifacts.REASONS.INVALID_NAME);
    }
  });

  // A double dot inside a name is legal on NTFS: refusing it would reject a real
  // backup file, so only a whole-segment ".." counts.
  it('keeps a legitimate name that merely contains two dots', () => {
    expect(artifacts.validateName('app..2026.sql').ok).to.equal(true);
  });
});

describe('Backup artifacts: containment', () => {
  const root = 'C:' + B + 'Backups';

  it('accepts a file directly inside the folder', () => {
    expect(artifacts.isInside(root, root + B + 'app.sql')).to.equal(true);
    expect(artifacts.isInside(root, root + B + 'daily' + B + 'app.sql')).to.equal(true);
  });

  // Windows paths are not case-sensitive: the service and the GUI each write the
  // history, and a case-sensitive check would refuse a file that is really there.
  it('compares without regard to case', () => {
    expect(artifacts.isInside('C:' + B + 'Backups', 'c:' + B + 'backups' + B + 'APP.SQL')).to.equal(true);
    expect(artifacts.isInside('C:' + B + 'BACKUPS', 'C:' + B + 'backups')).to.equal(false);
  });

  it('refuses a sibling folder that merely shares a prefix', () => {
    expect(artifacts.isInside(root, 'C:' + B + 'Backups-old' + B + 'app.sql')).to.equal(false);
  });

  it('refuses the folder itself and anything above it', () => {
    expect(artifacts.isInside(root, root)).to.equal(false);
    expect(artifacts.isInside(root, 'C:' + B + 'app.sql')).to.equal(false);
    expect(artifacts.isInside(root, 'C:' + B)).to.equal(false);
  });

  it('refuses another drive', () => {
    expect(artifacts.isInside(root, 'D:' + B + 'Backups' + B + 'app.sql')).to.equal(false);
  });

  it('works when the profile folder is a drive root', () => {
    expect(artifacts.isInside('C:' + B, 'C:' + B + 'Backups' + B + 'app.sql')).to.equal(true);
  });
});

describe('Backup artifacts: resolving what the history claims exists', () => {
  let dir;
  let profile;
  let manager;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backupartifacts-'));
    fs.writeFileSync(path.join(dir, 'app_20260102_030405.sql'), 'dump');
    fs.mkdirSync(path.join(dir, 'daily'));
    fs.writeFileSync(path.join(dir, 'daily', 'app_20260101.sql'), 'dump');
    profile = { Id: 'p1', Name: 'Nightly', BackupPath: dir };
    manager = managerFor([profile]);
  });

  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

  it('resolves a real file to a full path and its size', () => {
    const found = artifacts.findArtifact(manager, 'p1', 'app_20260102_030405.sql');
    expect(found.ok).to.equal(true);
    expect(found.filePath).to.equal(path.join(dir, 'app_20260102_030405.sql'));
    expect(found.fileName).to.equal('app_20260102_030405.sql');
    expect(found.size).to.equal(4);
  });

  it('resolves a file in a subfolder of the profile folder', () => {
    expect(artifacts.findArtifact(manager, 'p1', 'app_20260101.sql').ok).to.equal(false);
    expect(artifacts.findArtifact(manager, 'p1', 'app_20260101.sql').reason)
      .to.equal(artifacts.REASONS.NOT_FOUND);
  });

  it('reports a file that is no longer there', () => {
    expect(artifacts.findArtifact(manager, 'p1', 'deleted.sql').reason).to.equal(artifacts.REASONS.NOT_FOUND);
  });

  // A folder in the backup folder is not something to hand to Explorer.
  it('refuses a directory', () => {
    expect(artifacts.findArtifact(manager, 'p1', 'daily').reason).to.equal(artifacts.REASONS.NOT_A_FILE);
  });

  it('refuses to reach outside the profile folder', () => {
    for (const name of ['..' + B + 'app.sql', '..' + B + '..' + B + 'Windows' + B + 'win.ini', 'daily' + B + '..' + B + 'app.sql']) {
      expect(artifacts.findArtifact(manager, 'p1', name).reason, `accepted ${name}`)
        .to.equal(artifacts.REASONS.INVALID_NAME);
    }
  });

  it('refuses an unknown or empty profile id', () => {
    expect(artifacts.findArtifact(manager, 'other', 'app.sql').reason).to.equal(artifacts.REASONS.PROFILE_MISSING);
    expect(artifacts.findArtifact(manager, '', 'app.sql').reason).to.equal(artifacts.REASONS.PROFILE_MISSING);
    expect(artifacts.findArtifact(null, 'p1', 'app.sql').reason).to.equal(artifacts.REASONS.PROFILE_MISSING);
  });

  it('refuses a profile whose folder is relative, missing or not a folder', () => {
    const cases = [
      [{ BackupPath: 'Backups' }, artifacts.REASONS.FOLDER_MISSING],
      [{ BackupPath: '' }, artifacts.REASONS.FOLDER_MISSING],
      [{ BackupPath: `C:${B}Backups${String.fromCharCode(0)}x` }, artifacts.REASONS.FOLDER_MISSING],
      [{ BackupPath: path.join(dir, 'nowhere') }, artifacts.REASONS.FOLDER_NOT_FOUND],
      [{ BackupPath: path.join(dir, 'app_20260102_030405.sql') }, artifacts.REASONS.NOT_A_FOLDER],
      [{}, artifacts.REASONS.FOLDER_MISSING],
    ];
    for (const [bad, reason] of cases) {
      const found = artifacts.findArtifact({ getProfile: () => bad }, 'p1', 'app.sql');
      expect(found.reason, `accepted BackupPath ${JSON.stringify(bad.BackupPath)}`).to.equal(reason);
    }
  });

  it('finds the folder alone, for the "the file is gone" fallback', () => {
    const found = artifacts.findFolder(manager, 'p1');
    expect(found).to.deep.equal({ ok: true, folder: path.resolve(dir) });
    expect(artifacts.findFolder(manager, 'nope').reason).to.equal(artifacts.REASONS.PROFILE_MISSING);
  });
});

describe('Backup artifacts: what the UI is offered', () => {
  it('offers the file when the result has a local one', () => {
    expect(artifacts.hasLocalArtifact({ success: true, fileName: 'app.sql', filePath: 'C:/Backups/app.sql' })).to.equal(true);
  });

  it('offers only the folder when the file was written on the database host', () => {
    expect(artifacts.hasLocalArtifact({ success: true, remoteOnly: true, fileName: 'app.bak' })).to.equal(false);
  });

  it('offers nothing for a failed result or a name that cannot be a file', () => {
    expect(artifacts.hasLocalArtifact({ success: false, fileName: 'app.sql' })).to.equal(false);
    expect(artifacts.hasLocalArtifact({ success: true, fileName: '..' + B + 'app.sql' })).to.equal(false);
    expect(artifacts.hasLocalArtifact(null)).to.equal(false);
  });
});

describe('Backup artifacts: the module is loadable outside Electron', () => {
  it('never requires electron, so the service and the tests can load it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'backupArtifacts.js'), 'utf8');
    expect(src).to.not.match(/require\(['"]electron['"]\)/);
  });

  it('reports failures as i18n keys, not sentences', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'backupArtifacts.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    for (const reason of Object.values(artifacts.REASONS)) expect(reason).to.match(/^artifact\.[a-zA-Z]+$/);
    expect(code, 'the main process must not choose the language').to.not.match(/[ãõçáéíóúâêô]/i);
  });
});

describe('Backup artifacts: desktop wiring', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const backupManagerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'backupManager.js'), 'utf8');
  const backupPageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'backupPage.js'), 'utf8');

  it('exposes both actions through the desktop IPC bridge', () => {
    expect(mainSource).to.include("ipcMain.handle('reveal-backup-artifact'");
    expect(mainSource).to.include("ipcMain.handle('open-backup-folder'");
    expect(preloadSource).to.include("revealBackupArtifact: (profileId, name) => ipcRenderer.invoke('reveal-backup-artifact', profileId, name)");
    expect(preloadSource).to.include("openBackupFolder: (profileId) => ipcRenderer.invoke('open-backup-folder', profileId)");
  });

  // The renderer sends a name. If a path ever appears in the bridge, the whole
  // containment check in backupArtifacts is bypassed.
  it('never lets a path cross from the renderer', () => {
    const bridge = preloadSource.split('\n').filter(l => /BackupArtifact|BackupFolder/.test(l)).join('\n');
    expect(bridge).to.not.match(/filePath|path\b/);
    expect(backupPageSource).to.not.match(/revealBackupArtifact\([^)]*filePath/);
    expect(backupPageSource).to.include('data-backup-artifact');
  });

  // shell.showItemInFolder/openPath take the path as a value. `explorer
  // /select,...` on a command line would hand it to a parser instead.
  it('opens artifacts through the shell API, not a command line', () => {
    expect(mainSource).to.include('shell.showItemInFolder(target.filePath)');
    expect(mainSource).to.include('shell.openPath(target.folder)');
    // Comments are allowed to name the mistake they are avoiding.
    const code = mainSource.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(code).to.not.match(/explorer(\.exe)?\s+\/select/i);
  });

  it('keeps filePath, fileName and remoteOnly in the persisted history', () => {
    expect(backupManagerSource).to.include('filePath: local,');
    expect(backupManagerSource).to.include("fileName: local ? path.basename(local) : ''");
    expect(backupManagerSource).to.include('remoteOnly: !!r.remoteOnly');
  });
});
