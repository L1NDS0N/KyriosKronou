const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadFile(path.join(__dirname, 'sync-ui.html'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      syncPage.profiles = [
        { Id: 'one', Name: 'One', Engine: 'local', SourcePath: 'C:/one', DestPath: 'D:/one', Enabled: true, Retention: {} },
        { Id: 'two', Name: 'Two', Engine: 'local', SourcePath: 'C:/two', DestPath: 'D:/two', Enabled: true, Retention: {} },
        { Id: 'three', Name: 'Three', Engine: 'local', SourcePath: 'C:/three', DestPath: 'D:/three', Enabled: true, Retention: {} }
      ];
      syncPage.engines = [{ id: 'local', label: 'Local' }];
      let activeHistoryRequests = 0;
      let maxHistoryRequests = 0;
      window.api.getSyncHistory = async () => {
        activeHistoryRequests++;
        maxHistoryRequests = Math.max(maxHistoryRequests, activeHistoryRequests);
        await new Promise(resolve => setTimeout(resolve, 30));
        activeHistoryRequests--;
        return { stats: { total: 1, success: 1, failed: 0 } };
      };
      await syncPage.render();
      const menu = {
        maxHistoryRequests,
        editButtons: document.querySelectorAll('[data-sync-edit]').length,
        cards: document.querySelectorAll('.sync-profile-card').length
      };

      syncPage.showCreateModal();
      syncPage.draft.Retention.Enabled = true;
      syncPage.draft.SourcePath = '';
      syncPage.draft.DestPath = '';
      syncPage.currentStep = 1;
      syncPage._renderWizard();
      const actionState = {
        emptyAnalyze: document.getElementById('sync-action-analyze').disabled,
        emptyPreview: document.getElementById('sync-action-preview').disabled,
        emptySimulate: document.getElementById('sync-action-simulate').disabled,
      };
      await syncPage.runAnalysis();
      await syncPage.refreshPreview();
      await syncPage.runSimulation();
      syncPage._setSourcePath('C:/source');
      syncPage._setDestPath('D:/destination');
      const actionEnabled = {
        analyze: !document.getElementById('sync-action-analyze').disabled,
        preview: !document.getElementById('sync-action-preview').disabled,
        simulate: !document.getElementById('sync-action-simulate').disabled,
      };
      await syncPage.runAnalysis();
      await syncPage.refreshPreview();
      await syncPage.runSimulation();
      syncPage._setSourcePath('C:/changed');
      const invalidated = !syncPage.analysis && !syncPage.retentionPreview && !syncPage.simulation;

      syncPage.showCreateModal();
      const saveButtonsByTab = [];
      for (let step = 0; step < 3; step++) {
        syncPage.currentStep = step;
        syncPage._renderWizard();
        const button = document.querySelector('[data-sync-save]');
        saveButtonsByTab.push({ step, count: document.querySelectorAll('[data-sync-save]').length, text: button && button.textContent.trim() });
      }

      syncPage.currentStep = 0;
      syncPage._renderWizard();
      syncPage.draft.SourcePath = 'C:/source';
      syncPage.draft.DestPath = 'D:/destination';
      await syncPage.saveProfile();

      syncPage.showCreateModal();
      syncPage.currentStep = 1;
      syncPage._renderWizard();
      syncPage.draft.SourcePath = 'C:/source-2';
      syncPage.draft.DestPath = 'D:/destination-2';
      await syncPage.saveProfile();

      return { menu, saveButtonsByTab, saves: window.__saves, actionState, actionEnabled, actionCalls: window.__retentionActionCalls, invalidated };
    })()`);
    process.stdout.write(`SYNC_UI_RESULT=${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    app.exit(1);
  }
});
