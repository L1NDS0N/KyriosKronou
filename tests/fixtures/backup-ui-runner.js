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
      };

      await backupPage.load();
      const list = {
        cards: document.querySelectorAll('.backup-profile-card').length,
        undefinedVisible: document.getElementById('backup-profiles-list').textContent.includes('undefined'),
        maxActiveStats,
        mysqldumpChecks,
        statusHost: !!document.getElementById('mysqldump-status'),
      };

      backupPage.showCreateModal();
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
