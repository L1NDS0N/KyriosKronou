const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });

  try {
    await win.loadFile(path.join(__dirname, 'backup-ui.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const pageErrors = [];
      window.addEventListener('error', event => pageErrors.push(event.message));
      let activeStats = 0;
      let maxActiveStats = 0;
      let mysqldumpChecks = 0;
      const revealCalls = [];
      const folderCalls = [];
      window.api = {
        getBackupProfiles: async () => [
          { Id: 'legacy', Name: 'Legacy profile', Host: 'localhost', Port: 3306, BackupPath: 'C:/Backups', CronExpression: '0 2 * * *', Databases: ['app'], Enabled: true },
          { Id: 'normal', Name: 'Normal profile', Host: 'db', Port: 3306, BackupPath: 'D:/Backups', CronExpression: '0 3 * * *', Databases: ['app'], UploadTargets: [{ type: 'sftp' }], Enabled: true }
        ],
        getDbEngines: async () => [{ id: 'mysql', label: 'MySQL / MariaDB', defaultPort: 3306, formats: null }],
        checkMysqldump: async () => { mysqldumpChecks++; return { found: true, path: 'C:/fake/mysqldump.exe' }; },
        getBackupHistoryStats: async id => {
          activeStats++;
          maxActiveStats = Math.max(maxActiveStats, activeStats);
          await new Promise(resolve => setTimeout(resolve, 30));
          activeStats--;
          if (id === 'legacy') throw new Error('history unavailable');
          return { stats: { total: 4, success: 4, failed: 0 } };
        },
        createBackupProfile: async () => ({ success: false, message: 'Destination is read-only' }),
        updateBackupProfile: async () => ({ success: true }),
        getBackupHistory: async () => ({ success: true, history: [
          {
            Id: 'run-1', ProfileId: 'normal', Timestamp: new Date(2026, 0, 2, 3, 4, 5).toISOString(),
            Status: 'Partial', Duration: '1.2s', Databases: ['app', 'billing', 'legacy'],
            TotalSize: 10, TotalSizeHuman: '1.0 KB', LogPath: 'C:/logs/backup.log',
            Results: [
              { database: 'app', success: true, sizeHuman: '1.0 KB', fileName: 'app_20260102_030405.sql', filePath: 'D:/Backups/app_20260102_030405.sql', remoteOnly: false },
              { database: 'billing', success: true, sizeHuman: 'no servidor', fileName: '', filePath: '', remoteOnly: true },
              { database: 'legacy', success: false, sizeHuman: '0 B', message: 'mysqldump exited with 2', fileName: '', filePath: '', remoteOnly: false }
            ]
          }
        ] }),
        revealBackupArtifact: async (profileId, name) => {
          revealCalls.push({ profileId, name });
          // The file was removed after upload (KeepLocal off).
          if (name === 'app_20260102_030405.sql') return { ok: false, reason: 'artifact.notFound' };
          return { ok: true, fileName: name };
        },
        openBackupFolder: async (profileId) => {
          folderCalls.push(profileId);
          if (profileId === 'legacy') return { ok: false, reason: 'artifact.folderNotFound' };
          return { ok: true, folder: 'D:/Backups' };
        },
      };

      await backupPage.load();
      const list = {
        cards: document.querySelectorAll('.backup-profile-card').length,
        undefinedVisible: document.getElementById('backup-profiles-list').textContent.includes('undefined'),
        maxActiveStats,
        mysqldumpChecks,
        statusHost: !!document.getElementById('mysqldump-status'),
      };

      window.__toasts.length = 0;
      await backupPage.showHistory('normal');
      const artifactButtons = [...document.querySelectorAll('[data-backup-artifact]')];
      const artifactLabels = artifactButtons.map(b => b.textContent.trim());
      artifactButtons[0].click();
      await new Promise(resolve => setTimeout(resolve, 30));
      artifactButtons[1].click();
      await new Promise(resolve => setTimeout(resolve, 30));
      const history = {
        buttons: artifactButtons.length,
        artifactLabels,
        revealCalls,
        folderCalls,
        rowToggled: document.querySelector('.bh-entry').classList.contains('expanded'),
        toasts: window.__toasts.map(t => t.type),
      };

      backupPage.showCreateModal();
      window.__toasts.length = 0;
      backupPage.currentStep = 4;
      backupPage._renderWizard();
      backupPage.draft.BackupPath = 'E:/Backups';
      backupPage.draft.CronExpression = '0 4 * * *';
      backupPage.draft.Enabled = true;
      document.getElementById('wiz-cron').value = '0 4 * * *';
      document.getElementById('wiz-enabled').checked = true;
      await backupPage.saveProfile();

      return {
        list,
        history,
        save: {
          modalOpen: !document.getElementById('modal-overlay').classList.contains('hidden'),
          hideCalls: window.__hideCalls,
          toasts: window.__toasts,
          buttonEnabled: !document.querySelector('[data-backup-save]').disabled,
          saving: backupPage.saving,
        },
        pageErrors,
      };
    })()`);
    process.stdout.write(`BACKUP_UI_RESULT=${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    app.exit(1);
  }
});
