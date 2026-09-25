const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });

  try {
    await win.loadFile(path.join(__dirname, 'retention-ui.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      let previewMode = 'fail';
      let applyCalls = 0;
      let appliedPolicy = null;
      let confirmCalls = 0;
      window.__profileRuns = [];
      window.confirm = () => { confirmCalls++; return true; };
      window.api = {
        analyzeSyncFolder: async () => ({
          ok: true, folderPattern: 'dated-folders', totalFiles: 40, totalBytes: 4096,
          suggested: { ByAge: true, KeepDays: 30, MinKeep: 5 }
        }),
        previewSyncRetention: async () => previewMode === 'fail'
          ? { ok: false, error: 'Destination unavailable' }
          : { ok: true, delete: [{ rel: 'old.zip', reason: 'age', date: '2020-01-01T00:00:00Z', detail: 'old' }], kept: [], rules: [], minKeep: 5, dateSource: 'names', totalFiles: 40, totalSnapshots: 40, folders: [{ rel: 'daily', folderPattern: 'dated-folders', delete: [{ rel: '2020-01-01/old.zip', folder: 'daily', reason: 'age', date: '2020-01-01T00:00:00Z', detail: 'old' }], kept: [{ rel: '2026-09-01/fresh.zip', folder: 'daily', reason: 'monthly', date: '2026-09-01T00:00:00Z', detail: 'monthly copy' }], rules: [{ type: 'age', kind: 'delete', days: 30 }], minKeep: 5, dateSource: 'names' }] },
        runRetentionNow: async (folder, policy) => { applyCalls++; appliedPolicy = policy; return { ok: true, deleted: 1, freed: 10, failed: [] }; },
        getRetentionProfiles: async () => [{ Id: 'scheduled-1', Name: 'Nightly backups', FolderPath: 'D:/Backups', CronExpression: '0 3 * * *', Enabled: true, LastStatus: 'Success', LastRun: '2026-09-24T03:00:00Z' }],
        runRetentionProfile: async id => { window.__profileRuns.push(id); return { success: true }; },
      };

      retentionPage.render();
      const defaultPolicy = JSON.parse(JSON.stringify(retentionPage._getCfg()));
      const defaultControls = {
        count: document.getElementById('ret-default-count').checked,
        countValue: document.getElementById('ret-default-count-n').value,
        monthly: document.getElementById('ret-default-monthly').checked,
        months: document.getElementById('ret-default-months').value,
        advancedAge: !!document.getElementById('ret-adv-age')
      };
      const folderInput = document.getElementById('ret-folder');
      folderInput.focus();
      folderInput.value = 'D:/Typed';
      folderInput.dispatchEvent(new Event('input', { bubbles: true }));
      const folderInputPreserved = document.getElementById('ret-folder') === folderInput && folderInput.value === 'D:/Typed';
      const folderFocusPreserved = document.activeElement === folderInput;

      retentionPage.folder = 'D:/Backups';
      await retentionPage.analyze();
      clearTimeout(retentionPage.previewTimer);
      const analyzedPolicy = JSON.parse(JSON.stringify(retentionPage._getCfg()));
      const initialDisabled = document.getElementById('ret-apply-btn').disabled;
      const sidebarVisible = !!document.getElementById('ret-preview-card');
      const previewButtonCount = document.querySelectorAll('[onclick*="runPreview"]').length;

      await retentionPage.runPreview();
      const failedDisabled = document.getElementById('ret-apply-btn').disabled;
      await retentionPage.applyNow();
      const blocked = { applyCalls, confirmCalls, toasts: window.__toasts.slice() };

      previewMode = 'success';
      await retentionPage.runPreview();
      const successEnabled = !document.getElementById('ret-apply-btn').disabled;
      const folderAccordions = document.querySelectorAll('.ret-folder-accordion').length;
      const previewViewButtons = document.querySelectorAll('[data-ret-view]').length;
      retentionPage.setPreviewView('tree');
      const treeFolders = document.querySelectorAll('[data-ret-tree-folder]').length;
      const treeFiles = document.querySelectorAll('[data-ret-tree-file]').length;
      const treePattern = document.querySelector('[data-ret-tree-file]').getAttribute('data-ret-pattern');
      const treePatternText = document.querySelector('.ret-tree-file-details').textContent;
      const treeModeActive = document.querySelector('[data-ret-view="tree"]').classList.contains('active');
      const defaultFormats = retentionPage._getCfg().FileExtensions.slice();
      retentionPage._toggleFormat('.bak', true);
      const customFormats = retentionPage._getCfg().FileExtensions.slice();
      clearTimeout(retentionPage.previewTimer);
      retentionPage._setAllFormats(true);
      const allFormats = retentionPage._getCfg().FileExtensions.slice();
      clearTimeout(retentionPage.previewTimer);
      retentionPage._setDays('45');
      const changedDisabled = document.getElementById('ret-apply-btn').disabled;
      clearTimeout(retentionPage.previewTimer);

      await retentionPage.runPreview();
      await retentionPage.applyNow();
      clearTimeout(retentionPage.previewTimer);
      await retentionPage.load();
      const profileRows = document.querySelectorAll('[data-retention-profile]').length;
      await retentionPage.runScheduleProfile('scheduled-1');
      return { initialDisabled, failedDisabled, blocked, successEnabled, changedDisabled, applyCalls, appliedPolicy, sidebarVisible, previewButtonCount, modalCalls: window.__modalCalls, folderInputPreserved, folderFocusPreserved, defaultPolicy, analyzedPolicy, defaultControls, folderAccordions, previewViewButtons, treeFolders, treeFiles, treePattern, treePatternText, treeModeActive, defaultFormats, customFormats, allFormats, profileRows, profileRuns: window.__profileRuns, pageErrors: [] };
    })()`);
    const measureLayout = async (width) => {
      win.setSize(width, 900);
      await new Promise(resolve => setTimeout(resolve, 80));
      return win.webContents.executeJavaScript(`(() => {
        const layout = document.querySelector('.retention-layout');
        const sidebar = document.getElementById('ret-preview-card');
        return {
          viewport: window.innerWidth,
          layout: Math.round(layout.getBoundingClientRect().width),
          sidebar: Math.round(sidebar.getBoundingClientRect().width),
          columns: getComputedStyle(layout).gridTemplateColumns.split(' ').length,
          maxWidth: getComputedStyle(sidebar).maxWidth
        };
      })()`);
    };
    result.responsive = { narrow: await measureLayout(1000), wide: await measureLayout(1700) };
    process.stdout.write(`RETENTION_UI_RESULT=${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    app.exit(1);
  }
});
