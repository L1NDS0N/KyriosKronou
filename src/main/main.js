// main.js - Electron Main Process (with System Tray + Autostart + Audit Logging + Service Mode)
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const CronParser = require('./cronParser');
const Logger = require('./logger');
const ConfigManager = require('./configManager');
const TaskManager = require('./taskManager');
const ServiceManager = require('./serviceManager');
const NssmInstaller = require('./nssmInstaller');
const WrapperGenerator = require('./wrapperGenerator');
const ApiServer = require('./apiServer');
const BackupManager = require('./backupManager');
const KyrionService = require('./kyrionService');
const paths = require('./paths');
const { SchedulerCore, ROLE_GUI, readOwner } = require('./schedulerCore');

// ─── Single instance ───
// Only one GUI process may exist. A second launch (double-clicked icon, tray
// relaunch, autostart racing a manual start) must surface the existing window
// instead of starting a second scheduler.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

const SERVICE_NAME = KyrionService.SERVICE_NAME;

let mainWindow;
let tray = null;
let cronParser, logger, config, taskManager, serviceManager, nssmInstaller;
let kyrionService;
let scheduler;
let wrapperGenerator;
let apiServer;
let backupManager;
let isQuitting = false;

// ─── Push Notifications ───
function sendNotification(title, body, type) {
  try {
    if (!config || !config.getSetting('Notifications', true)) return;
    if (!Notification.isSupported()) return;

    // Try push-128.png, fallback to push-64.png, then tray-32.png
    const assetDir = path.join(__dirname, '..', 'renderer', 'assets');
    let iconPath = path.join(assetDir, 'push-128.png');
    if (!fs.existsSync(iconPath)) iconPath = path.join(assetDir, 'push-64.png');
    if (!fs.existsSync(iconPath)) iconPath = path.join(assetDir, 'tray-32.png');
    if (!fs.existsSync(iconPath)) iconPath = path.join(__dirname, '..', 'build-resources', 'icon.ico');
    const notif = new Notification({
      title,
      body,
      silent: false,
      icon: fs.existsSync(iconPath) ? iconPath : undefined
    });
    notif.on('click', () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
    notif.show();
  } catch (e) { /* notifications are best-effort */ }
}

function sendTaskNotification(task, result) {
  const success = result && result.success !== false;
  const title = success ? '\u2705 Task Completed' : '\u274c Task Failed';
  const body = `${task.Name}\n${success ? 'Executed successfully' : 'Failed: ' + (result.error || 'Unknown error')}${result.duration ? '\nDuration: ' + result.duration : ''}`;
  sendNotification(title, body, success ? 'success' : 'error');
}

function sendServiceNotification(action, serviceName, success, message) {
  const icon = success ? '\u2705' : '\u274c';
  const title = `${icon} Service ${action}`;
  sendNotification(title, `${serviceName}\n${message || (success ? 'Operation completed' : 'Operation failed')}`, success ? 'success' : 'error');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#050508',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => { mainWindow.show(); });

  // Close → minimize to tray if setting enabled
  mainWindow.on('close', (e) => {
    const closeToTray = config ? config.getSetting('CloseToTray', true) : true;
    if (closeToTray && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return;
    }
    if (scheduler) scheduler.stop();
    if (logger) logger.flush();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  // Load logo from assets for system tray
  let trayIcon;
  const trayPath = path.join(__dirname, '..', 'renderer', 'assets', 'tray-32.png');
  if (fs.existsSync(trayPath)) {
    trayIcon = nativeImage.createFromPath(trayPath).resize({ width: 16, height: 16 });
  } else {
    // Fallback: generate a 16x16 purple circle
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const cx = x - size / 2 + 0.5, cy = y - size / 2 + 0.5;
        const dist = Math.sqrt(cx * cx + cy * cy);
        const radius = size / 2 - 1;
        if (dist < radius - 0.5) {
          buf[i] = 130; buf[i + 1] = 90; buf[i + 2] = 200; buf[i + 3] = 255;
        } else if (dist < radius + 0.5) {
          const alpha = Math.max(0, Math.min(255, Math.round(255 * (radius + 0.5 - dist))));
          buf[i] = 130; buf[i + 1] = 90; buf[i + 2] = 200; buf[i + 3] = alpha;
        } else {
          buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 0;
        }
      }
    }
    trayIcon = nativeImage.createFromBuffer(buf, { width: size, height: size }).resize({ width: 16, height: 16 });
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Κύριος Χρόνος - Task Scheduler');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Κύριος Χρόνος', enabled: false },
    { type: 'separator' },
    {
      label: 'Show Window', click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      }
    },
    { type: 'separator' },
    {
      label: 'Quick Actions', submenu: [
        { label: 'Refresh Dashboard', click: () => { if (mainWindow) mainWindow.webContents.send('tray-refresh'); } },
        { label: 'Run Due Tasks', click: () => { runDueTasksFromTray(); } }
      ]
    },
    { type: 'separator' },
    {
      label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked, path: app.getPath('exe') });
        if (config) {
          const old = config.getSetting('StartWithWindows', false);
          config.setSetting('StartWithWindows', menuItem.checked);
          config.save();
          logger.auditSettingsChanged('StartWithWindows', old, menuItem.checked);
        }
      }
    },
    { label: 'Minimize to Tray on Close', type: 'checkbox', checked: true,
      click: (menuItem) => {
        if (config) {
          const old = config.getSetting('CloseToTray', true);
          config.setSetting('CloseToTray', menuItem.checked);
          config.save();
          logger.auditSettingsChanged('CloseToTray', old, menuItem.checked);
        }
      }
    },
    { type: 'separator' },
    { label: 'Exit', click: () => { isQuitting = true; app.quit(); } }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  if (config) {
    const closeToTray = config.getSetting('CloseToTray', true);
    contextMenu.items[7].checked = closeToTray;
    const startWithWin = config.getSetting('StartWithWindows', false);
    contextMenu.items[5].checked = startWithWin;
  }
}

async function runDueTasksFromTray() {
  if (!taskManager) return;
  const dueTasks = taskManager.getDueTasks();
  for (const task of dueTasks) {
    const result = await taskManager.executeTask(task);
    logger.auditTaskExecuted(task.Id, task.Name, result);
    sendTaskNotification(task, result);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('task-executed', result);
      mainWindow.webContents.send('data-updated');
    }
  }
}

function initComponents() {
  // Config lives in %ProgramData% so the GUI (running as the user) and the
  // service (running as LocalSystem) read and write the SAME files.
  const { configDir, logsDir } = paths.ensureDirs();
  const migration = paths.migrateLegacyData();

  cronParser = new CronParser();
  logger = new Logger(logsDir);
  config = new ConfigManager(configDir, 'default');
  taskManager = new TaskManager(config, logger, cronParser);
  serviceManager = new ServiceManager(logger, config);
  // Was declared and used by the nssm-* IPC handlers but never constructed,
  // so every one of them threw "Cannot read properties of undefined".
  nssmInstaller = new NssmInstaller(logger);
  kyrionService = new KyrionService(logger, serviceManager);
  wrapperGenerator = new WrapperGenerator(config, logger);
  backupManager = new BackupManager(config, logger);

  if (migration.migrated) {
    logger.log('INFO', `Migrated ${migration.copied} file(s) from ${migration.sources.join(', ')} to ${paths.dataDir()}`);
  }

  logger.log('INFO', `Κύριος Χρόνος started (data: ${paths.dataDir()})`);
  logger.audit('APP_STARTED', { targetType: 'app', after: { version: app.getVersion() } });
}

/**
 * Start or stop the GUI's web interface to match scheduler ownership.
 * Only the process actually running the jobs serves the web UI, which keeps
 * the two from racing for the port and means the page always reflects the
 * process doing the work.
 */
function syncWebInterface() {
  const enabled = config.getSetting('ApiEnabled', false);
  const shouldHost = enabled && scheduler && scheduler.isOwner;

  if (shouldHost && (!apiServer || !apiServer.isRunning())) {
    apiServer = new ApiServer(taskManager, config, logger, serviceManager, wrapperGenerator, backupManager);
    apiServer.start()
      .then((info) => logger.log('INFO', `Web interface started on ${info.url}`))
      .catch((err) => logger.error('Web interface failed to start', err));
  } else if (!shouldHost && apiServer && apiServer.isRunning()) {
    logger.log('INFO', 'Handing the web interface to the service');
    apiServer.stop().catch(() => {});
  }
}

// ─── GUI scheduler ───
// Same engine the service runs. It only executes when it holds the ownership
// lease, so with the service installed the GUI stays a passive viewer and jobs
// never fire twice.
function startScheduler() {
  scheduler = new SchedulerCore(
    { taskManager, backupManager, cronParser, logger },
    ROLE_GUI,
    {
      onTaskExecuted: (task, result) => {
        sendTaskNotification(task, result);
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('task-executed', result);
          mainWindow.webContents.send('data-updated');
        }
      },
      onBackupExecuted: (profile, result) => {
        sendNotification(
          result && result.success ? '✅ Backup Completed' : '❌ Backup Failed',
          `${profile.Name}
${result && result.success ? 'Backup successful' : 'Backup failed'}
Duration: ${(result && result.duration) || '-'}`,
          result && result.success ? 'success' : 'error'
        );
        if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('data-updated');
      },
      onOwnershipChange: (isOwner) => {
        syncWebInterface();
        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('scheduler-ownership-changed', { isOwner });
        }
      },
    }
  ).start();
}


// IPC Handlers with audit logging and error wrappers
function registerIPC() {
  // ─── Task Operations ───
  ipcMain.handle('get-tasks', () => taskManager.getAllTasks());

  ipcMain.handle('add-task', (e, data) => {
    const result = taskManager.addTask(data);
    if (result.success !== false) {
      logger.auditTaskCreated({ Id: result.Id, Name: data.Name, CronExpression: data.CronExpression, ScriptPath: data.ScriptPath });
    }
    return result;
  });

  ipcMain.handle('update-task', (e, data) => {
    const existing = taskManager.getTask(data.Id);
    const wasEnabled = existing ? existing.Enabled : true;
    const result = taskManager.updateTask(data);
    if (result.success !== false) {
      logger.auditTaskUpdated(data.Id,
        existing ? { name: existing.Name, cron: existing.CronExpression, enabled: existing.Enabled } : null,
        { name: data.Name, cron: data.CronExpression, enabled: data.Enabled }
      );

      // If task was just disabled and is NSSM-managed, stop the service (don't remove)
      if (wasEnabled && !data.Enabled && data.ManagementMode === 'nssm') {
        const serviceName = `Kyrion_${String(data.Id).replace(/[^a-zA-Z0-9]/g, '').substring(0, 20)}`;
        try {
          const svcInfo = serviceManager.getServiceInfo(serviceName);
          if (svcInfo && svcInfo.Status === 'Running') {
            serviceManager.stopService(serviceName);
            logger.log('INFO', `NSSM service stopped (task disabled): ${serviceName}`);
          }
        } catch (err) {
          logger.error(`Failed to stop NSSM service on disable: ${serviceName}`, err);
        }
      }

      // If task was just re-enabled and is NSSM-managed, start the service
      if (!wasEnabled && data.Enabled && data.ManagementMode === 'nssm') {
        const serviceName = `Kyrion_${String(data.Id).replace(/[^a-zA-Z0-9]/g, '').substring(0, 20)}`;
        try {
          const svcInfo = serviceManager.getServiceInfo(serviceName);
          if (svcInfo && svcInfo.Status !== 'Running') {
            serviceManager.startService(serviceName);
            logger.log('INFO', `NSSM service started (task enabled): ${serviceName}`);
          }
        } catch (err) {
          logger.error(`Failed to start NSSM service on enable: ${serviceName}`, err);
        }
      }
    }
    return result;
  });

  ipcMain.handle('delete-task', (e, id) => {
    const existing = taskManager.getTask(id);
    const result = taskManager.deleteTask(id);
    if (result.success !== false) {
      logger.auditTaskDeleted(id, existing ? existing.Name : id);
    }
    return result;
  });

  ipcMain.handle('execute-task', async (e, task) => {
    const result = await taskManager.executeTask(task);
    logger.auditTaskExecuted(task.Id, task.Name, result);
    sendTaskNotification(task, result);
    if (mainWindow) mainWindow.webContents.send('data-updated');
    return result;
  });

  ipcMain.handle('get-due-tasks', () => taskManager.getDueTasks());

  // ─── History ───
  ipcMain.handle('get-history', () => taskManager.getHistory());
  ipcMain.handle('export-history', async (e, format) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    });
    if (!result.canceled && result.filePath) {
      const res = taskManager.exportHistory(result.filePath);
      logger.auditExport(format, res.count || 0);
      return res;
    }
    return { success: false, message: 'Cancelled' };
  });

  // ─── Import / Export Tasks ───
  ipcMain.handle('export-tasks', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (!result.canceled && result.filePath) {
      const res = taskManager.exportTasks(result.filePath);
      logger.auditExport('json', res.count || 0);
      return res;
    }
    return { success: false, message: 'Cancelled' };
  });

  ipcMain.handle('import-tasks', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      const res = taskManager.importTasks(result.filePaths[0]);
      if (res.success) logger.auditImport(res.count || 0);
      return res;
    }
    return { success: false, message: 'Cancelled' };
  });

  // ─── Services ───
  ipcMain.handle('get-services', async () => serviceManager.getAllServicesAsync());
  ipcMain.handle('get-service-count', () => serviceManager.getServiceCount());
  ipcMain.handle('check-nssm', (e, p) => serviceManager.checkNssm(p));

  // ─── NSSM Installer ───
  ipcMain.handle('nssm-check-installed', (e, p) => nssmInstaller.checkInstalled(p));
  ipcMain.handle('nssm-check-managers', () => nssmInstaller.checkPackageManagers());
  ipcMain.handle('nssm-install-via', async (e, manager) => {
    const result = await nssmInstaller.installVia(manager);
    // NSSM's location just changed, so the cached "not found" answer is stale.
    serviceManager.clearNssmCache();
    logger.auditNssmInstalled(manager, result.success);
    return result;
  });
  ipcMain.handle('nssm-download-manual', async () => {
    const result = await nssmInstaller.downloadManual(app.getPath('userData'));
    serviceManager.clearNssmCache();
    logger.auditNssmInstalled('manual-download', result.success);
    return result;
  });

  // ─── Service Management (async to avoid UI freeze) ───
  ipcMain.handle('install-service', async (e, data) => {
    const result = await serviceManager.installServiceAsync(data.name, data.appPath, data.args, data.workDir, data.startupType);
    if (result.success) logger.auditServiceInstalled(data.name, data.appPath);
    return result;
  });

  ipcMain.handle('start-service', async (e, name) => {
    const result = await serviceManager._runNssmAsync('start', name);
    if (result.success) logger.auditServiceStarted(name);
    return { success: result.success, message: result.success ? 'Started' : result.message };
  });

  ipcMain.handle('stop-service', async (e, name) => {
    const result = await serviceManager._runNssmAsync('stop', name);
    if (result.success) logger.auditServiceStopped(name);
    return { success: result.success, message: result.success ? 'Stopped' : result.message };
  });

  ipcMain.handle('restart-service', async (e, name) => {
    await serviceManager._runNssmAsync('stop', name);
    const result = await serviceManager._runNssmAsync('start', name);
    if (result.success) {
      logger.auditServiceStopped(name);
      logger.auditServiceStarted(name);
    }
    return { success: result.success, message: result.success ? 'Restarted' : result.message };
  });

  ipcMain.handle('uninstall-service', async (e, name) => {
    const result = await serviceManager.uninstallServiceAsync(name);
    if (result.success) logger.auditServiceUninstalled(name);
    return result;
  });

  // ─── Wrapper + Deploy ───
  ipcMain.handle('generate-wrapper', (e, task) => wrapperGenerator.generateWrapper(task));
  ipcMain.handle('remove-wrapper', (e, taskId) => wrapperGenerator.removeWrapper(taskId));
  ipcMain.handle('get-wrapper-path', (e, taskId) => wrapperGenerator.getWrapperPath(taskId));
  ipcMain.handle('list-wrappers', () => wrapperGenerator.listWrappers());

  // ─── Service Parameter Editing ───
  ipcMain.handle('get-service-params', (e, serviceName) => {
    try {
      const info = serviceManager.getServiceInfo(serviceName);
      if (!info) return { success: false, message: 'Service not found' };
      // Get all NSSM parameters
      const params = {};
      const fields = ['Application', 'AppDirectory', 'AppParameters', 'DisplayName', 'Description', 'Start', 'AppStdout', 'AppStderr', 'AppRotateFiles', 'AppRotateBytes'];
      for (const field of fields) {
        const result = serviceManager._runNssm('get', serviceName, field);
        params[field] = result.output ? result.output.trim() : '';
      }
      params.Name = serviceName;
      params.Status = info.Status;
      return { success: true, params };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('set-service-params', (e, serviceName, params) => {
    try {
      // Apply each parameter
      if (params.Application) serviceManager._runNssm('set', serviceName, 'Application', params.Application);
      if (params.AppDirectory) serviceManager._runNssm('set', serviceName, 'AppDirectory', params.AppDirectory);
      if (params.AppParameters !== undefined) serviceManager._runNssm('set', serviceName, 'AppParameters', params.AppParameters);
      if (params.DisplayName) serviceManager._runNssm('set', serviceName, 'DisplayName', params.DisplayName);
      if (params.Description) serviceManager._runNssm('set', serviceName, 'Description', params.Description);
      if (params.Start) serviceManager._runNssm('set', serviceName, 'Start', params.Start);
      if (params.AppStdout) serviceManager._runNssm('set', serviceName, 'AppStdout', params.AppStdout);
      if (params.AppStderr) serviceManager._runNssm('set', serviceName, 'AppStderr', params.AppStderr);
      if (params.AppRotateFiles !== undefined) serviceManager._runNssm('set', serviceName, 'AppRotateFiles', params.AppRotateFiles ? 1 : 0);
      if (params.AppRotateBytes) serviceManager._runNssm('set', serviceName, 'AppRotateBytes', params.AppRotateBytes);
      logger.log('INFO', `Service parameters updated: ${serviceName}`);
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('rename-service', async (e, oldName, newName) => {
    try {
      if (!oldName || !newName) return { success: false, message: 'Names required' };
      // Get current params
      const info = serviceManager.getServiceInfo(oldName);
      if (!info) return { success: false, message: 'Service not found' };
      const params = {};
      const fields = ['Application', 'AppDirectory', 'AppParameters', 'DisplayName', 'Description', 'Start', 'AppStdout', 'AppStderr'];
      for (const field of fields) {
        const result = serviceManager._runNssm('get', oldName, field);
        params[field] = result.output ? result.output.trim() : '';
      }
      // Stop and remove old service
      serviceManager.stopService(oldName);
      serviceManager.uninstallService(oldName);
      // Install new service with same params
      serviceManager.installService(newName, params.Application, params.AppParameters, params.AppDirectory, 'Automatic');
      // Restore other params
      if (params.DisplayName) serviceManager._runNssm('set', newName, 'DisplayName', params.DisplayName);
      if (params.Description) serviceManager._runNssm('set', newName, 'Description', params.Description);
      if (params.AppStdout) serviceManager._runNssm('set', newName, 'AppStdout', params.AppStdout);
      if (params.AppStderr) serviceManager._runNssm('set', newName, 'AppStderr', params.AppStderr);
      serviceManager.startService(newName);
      logger.audit('SERVICE_RENAMED', { targetType: 'service', before: { name: oldName }, after: { name: newName } });
      return { success: true, newName };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('read-service-log', (e, taskId) => {
    try {
      const logPath = require('path').join(config.configDir, '..', 'logs', `task-${taskId}.log`);
      if (require('fs').existsSync(logPath)) {
        const content = require('fs').readFileSync(logPath, 'utf8');
        const lines = content.split('\n');
        return { success: true, content, lines: lines.slice(-50) }; // last 50 lines
      }
      return { success: false, message: 'Log file not found', content: '' };
    } catch (err) {
      return { success: false, message: err.message, content: '' };
    }
  });

  // ─── Script File Management ───
  ipcMain.handle('read-script-file', (e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return { success: false, message: 'File not found' };
      }
      const content = fs.readFileSync(filePath, 'utf8');
      return { success: true, content };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('save-script-file', (e, filePath, content) => {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
      return { success: true, path: filePath };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('get-scripts-dir', () => {
    const dir = path.join(config.configDir, '..', 'scripts');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  });

  ipcMain.handle('browse-folder', async (e, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Select Folder',
      properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { path: '' };
    return { path: result.filePaths[0] };
  });

  ipcMain.handle('deploy-task-service', async (e, task) => {
    try {
      if (!task || !task.Id || !task.ScriptPath) {
        logger.error('Deploy failed: invalid task data', null, { taskId: task?.Id });
        return { success: false, message: 'Invalid task data' };
      }

      // Check if NSSM is installed
      const nssmCheck = serviceManager.checkNssm();
      if (!nssmCheck.installed) {
        return { success: false, message: 'NSSM is not installed. Go to Services > Check NSSM to install it first.' };
      }

      // Check if script exists
      const fs = require('fs');
      if (!fs.existsSync(task.ScriptPath)) {
        return { success: false, message: `Script not found: ${task.ScriptPath}` };
      }

      const { wrapperPath, serviceName } = wrapperGenerator.generateWrapper(task);

      // Stop existing service if any
      const existingInfo = serviceManager.getServiceInfo(serviceName);
      if (existingInfo) {
        serviceManager.stopService(serviceName);
        serviceManager.uninstallService(serviceName);
        // Wait a moment for the service to be fully removed
        await new Promise(r => setTimeout(r, 1000));
      }

      const result = serviceManager.installService(serviceName, 'powershell.exe', `-ExecutionPolicy Bypass -NoProfile -File "${wrapperPath}"`, path.dirname(wrapperPath), 'Automatic');
      if (!result.success) {
        return { success: false, message: result.message || 'Failed to install service' };
      }

      // Configure NSSM restart behavior:
      // - Restart on failure (delay 5000ms)
      // - Exit with no error = don't restart (graceful stop)
      // - Exit with error = restart after delay
      serviceManager._runNssm('set', serviceName, 'AppExit', 'Default', 'Restart');
      serviceManager._runNssm('set', serviceName, 'AppRestartDelay', '5000');

      // Set process priority to below normal (less resource usage)
      serviceManager._runNssm('set', serviceName, 'AppPriority', 'BELOW_NORMAL_PRIORITY_CLASS');

      // Start the service
      const startResult = serviceManager.startService(serviceName);
      logger.auditServiceDeployed(task.Id, serviceName);

      // Verify the service actually started (check after 5s)
      setTimeout(() => {
        const info = serviceManager.getServiceInfo(serviceName);
        if (info) {
          if (info.Status === 'Running') {
            logger.log('INFO', `Service ${serviceName} verified running`);
          } else {
            logger.error(`Service ${serviceName} installed but status: ${info.Status}`, null, { taskId: task.Id, status: info.Status });
          }
        }
      }, 5000);

      sendServiceNotification('Deployed', serviceName, true, `Task: ${task.Name}`);
      return { success: true, serviceName, wrapperPath, message: `Service ${serviceName} installed and started` };
    } catch (err) {
      logger.error('Deploy failed', err, { taskId: task?.Id });
      sendServiceNotification('Deploy Failed', task?.Name || 'Unknown', false, err.message);
      return { success: false, message: `Deploy failed: ${err.message}` };
    }
  });

  ipcMain.handle('undeploy-task-service', async (e, task) => {
    try {
      if (!task || !task.Id) return { success: false, message: 'Invalid task' };
      const serviceName = `Kyrion_${task.Id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20)}`;
      serviceManager.stopService(serviceName);
      const result = serviceManager.uninstallService(serviceName);
      wrapperGenerator.removeWrapper(task.Id);
      logger.auditServiceUndeployed(task.Id, serviceName);
      sendServiceNotification('Undeployed', serviceName, true, `Task: ${task.Name}`);
      return result;
    } catch (err) {
      logger.error('Undeploy failed', err, { taskId: task?.Id });
      sendServiceNotification('Undeploy Failed', task?.Name || 'Unknown', false, err.message);
      return { success: false, message: `Undeploy failed: ${err.message}` };
    }
  });

  ipcMain.handle('get-task-service-status', (e, taskId) => {
    try {
      if (!taskId) return { serviceName: '', installed: false, status: null };
      // Check NSSM is available first
      const nssmCheck = serviceManager.checkNssm();
      if (!nssmCheck.installed) {
        return { serviceName: '', installed: false, status: null, nssmAvailable: false };
      }
      const serviceName = `Kyrion_${String(taskId).replace(/[^a-zA-Z0-9]/g, '').substring(0, 20)}`;
      const info = serviceManager.getServiceInfo(serviceName);
      const wrapperPath = wrapperGenerator.getWrapperPath(taskId);
      return { serviceName, installed: !!info, status: info ? info.Status : null, nssmAvailable: true, wrapperPath };
    } catch (err) {
      logger.error('Failed to check task service status', err, { taskId });
      return { serviceName: '', installed: false, status: null, nssmAvailable: false };
    }
  });

  // ─── Backup Profiles ───
  ipcMain.handle('get-backup-profiles', () => backupManager.getAllProfiles());
  ipcMain.handle('create-backup-profile', (e, data) => backupManager.createProfile(data));
  ipcMain.handle('update-backup-profile', (e, data) => backupManager.updateProfile(data));
  ipcMain.handle('delete-backup-profile', (e, id) => backupManager.deleteProfile(id));
  ipcMain.handle('run-backup', async (e, profileId) => {
    try {
      const result = await backupManager.executeBackup(profileId);
      return result;
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
  ipcMain.handle('test-mysql-connection', (e, host, port, user, pass) => backupManager.testConnection(host, port, user, pass));
  ipcMain.handle('list-mysql-databases', (e, host, port, user, pass) => backupManager.listDatabases(host, port, user, pass));
  ipcMain.handle('export-backup-profile', (e, id) => {
    const dialog = require('electron').dialog;
    const win = BrowserWindow.getFocusedWindow();
    const result = dialog.showSaveDialogSync(win, { title: 'Export Backup Profile', defaultPath: `backup-profile-${id}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result) return backupManager.exportProfile(id, result);
    return { success: false, message: 'Cancelled' };
  });
  ipcMain.handle('import-backup-profile', async () => {
    const dialog = require('electron').dialog;
    const win = BrowserWindow.getFocusedWindow();
    const result = dialog.showOpenDialogSync(win, { title: 'Import Backup Profile', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
    if (result && result[0]) return backupManager.importProfile(result[0]);
    return { success: false, message: 'Cancelled' };
  });
  ipcMain.handle('check-mysqldump', () => backupManager.getStatus());

  ipcMain.handle('test-ftp-connection', async (e, config) => {
    try {
      const ftp = require('basic-ftp');
      const client = new ftp.Client();
      client.ftp.verbose = false;
      await client.access({ host: config.host, user: config.user, password: config.password, port: parseInt(config.port) || 21 });
      if (config.path) await client.cd(config.path);
      await client.close();
      return { success: true, message: 'FTP connection successful' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('test-sftp-connection', async (e, cfg) => {
    try {
      const Client = require('ssh2-sftp-client');
      const sftp = new Client();
      await sftp.connect({ host: cfg.host, port: parseInt(cfg.port) || 22, username: cfg.user, password: cfg.password });
      if (cfg.path) await sftp.cwd(cfg.path);
      await sftp.end();
      return { success: true, message: 'SFTP connection successful' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
  ipcMain.handle('test-smb-connection', async (e, target) => {
    try {
      return await backupManager.testSmbConnection(target);
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
  ipcMain.handle('set-mysqldump-path', (e, p) => backupManager.setCustomPath(p));
  ipcMain.handle('download-mysqldump', async () => {
    const targetDir = path.join(app.getPath('userData'), 'mysql-tools');
    return await backupManager.downloadMysqldump(targetDir);
  });

  // ─── Backup History ───
  ipcMain.handle('get-backup-history', (e, profileId) => {
    try {
      return { success: true, history: backupManager.getHistory(profileId) };
    } catch (err) {
      return { success: false, history: [], message: err.message };
    }
  });
  ipcMain.handle('get-backup-history-stats', (e, profileId) => {
    try {
      return { success: true, stats: backupManager.getHistoryStats(profileId) };
    } catch (err) {
      return { success: false, stats: {}, message: err.message };
    }
  });

  // ─── Backup NSSM Deployment ───
  ipcMain.handle('deploy-backup-nssm', async (e, profileId) => {
    try {
      const profile = backupManager.getProfile(profileId);
      if (!profile) return { success: false, message: 'Profile not found' };
      if (!wrapperGenerator) return { success: false, message: 'Wrapper generator not initialized' };
      const nssmCheck = serviceManager.checkNssm();
      if (!nssmCheck.installed) return { success: false, message: 'NSSM not installed' };
      // Generate wrapper script for the backup
      const serviceName = `KyrionBackup_${profile.Name.replace(/[^a-zA-Z0-9]/g, '_')}`;
      // Create a PowerShell wrapper that runs mysqldump with the profile settings
      const wrapperScript = backupManager.generateBackupWrapper(profile);
      const wrappersDir = wrapperGenerator.wrappersDir;
      const wrapperPath = path.join(wrappersDir, `${serviceName}.ps1`);
      if (!fs.existsSync(wrappersDir)) fs.mkdirSync(wrappersDir, { recursive: true });
      // Write with UTF-8 BOM so PowerShell 5.1 reads it correctly
      const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
      const contentBuffer = Buffer.from(wrapperScript, 'utf8');
      fs.writeFileSync(wrapperPath, Buffer.concat([BOM, contentBuffer]));
      // Write profile config as JSON (wrapper reads this at runtime)
      if (backupManager._lastGeneratedConfig) {
        const configPath = path.join(wrappersDir, `backup-profile-${profileId}.json`);
        fs.writeFileSync(configPath, JSON.stringify(backupManager._lastGeneratedConfig.configJson, null, 2), 'utf8');
      }
      // Install via NSSM (async to avoid blocking UI)
      const installResult = await serviceManager._runNssmAsync('install', serviceName, 'powershell.exe', `-ExecutionPolicy Bypass -NoProfile -File \"${wrapperPath}\"`);
      if (installResult.success) {
        await serviceManager._runNssmAsync('set', serviceName, 'AppDirectory', wrappersDir);
        await serviceManager._runNssmAsync('set', serviceName, 'Start', 'SERVICE_AUTO_START');
        // Set NSSM to capture stdout/stderr for debugging
        const nssmLogDir = path.join(app.getPath('logs'), 'nssm');
        if (!fs.existsSync(nssmLogDir)) fs.mkdirSync(nssmLogDir, { recursive: true });
        await serviceManager._runNssmAsync('set', serviceName, 'AppStdout', path.join(nssmLogDir, `${serviceName}-stdout.log`));
        await serviceManager._runNssmAsync('set', serviceName, 'AppStderr', path.join(nssmLogDir, `${serviceName}-stderr.log`));
        await serviceManager._runNssmAsync('set', serviceName, 'AppStdoutCreationDisposition', 4);
        await serviceManager._runNssmAsync('set', serviceName, 'AppStderrCreationDisposition', 4);
        await serviceManager._runNssmAsync('set', serviceName, 'AppRotateFiles', 1);
        await serviceManager._runNssmAsync('set', serviceName, 'AppRotateBytes', 1048576);
        await serviceManager._runNssmAsync('start', serviceName);
        backupManager.updateProfile({ Id: profileId, ManagementMode: 'nssm', NssmServiceName: serviceName });
        sendNotification('Backup Service Deployed', `${serviceName} is now running as an NSSM service`, 'success');
      }
      return { success: installResult.success, message: installResult.message, serviceName };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
  ipcMain.handle('undeploy-backup-nssm', async (e, profileId) => {
    try {
      const profile = backupManager.getProfile(profileId);
      if (!profile) return { success: false, message: 'Profile not found' };
      const serviceName = profile.NssmServiceName;
      if (!serviceName) return { success: false, message: 'No NSSM service linked' };
      await serviceManager._runNssmAsync('stop', serviceName);
      await serviceManager._runNssmAsync('remove', serviceName, 'confirm');
      // Remove wrapper and config files
      const wrappersDir = wrapperGenerator.wrappersDir;
      const wrapperPath = path.join(wrappersDir, `${serviceName}.ps1`);
      const configPath = path.join(wrappersDir, `backup-profile-${profileId}.json`);
      if (fs.existsSync(wrapperPath)) fs.unlinkSync(wrapperPath);
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
      backupManager.updateProfile({ Id: profileId, NssmServiceName: '' });
      sendNotification('Backup Service Removed', `${serviceName} has been stopped and removed`, 'info');
      return { success: true, message: 'Service removed' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
  ipcMain.handle('get-backup-nssm-status', async (e, profileId) => {
    try {
      const profile = backupManager.getProfile(profileId);
      if (!profile || !profile.NssmServiceName) return { success: true, status: null };
      // Use async NSSM calls to avoid blocking main thread
      const statusResult = await serviceManager._runNssmAsync('status', profile.NssmServiceName);
      let statusText = null;
      if (statusResult.output) {
        if (statusResult.output.includes('SERVICE_RUNNING')) statusText = 'Running';
        else if (statusResult.output.includes('SERVICE_STOPPED')) statusText = 'Stopped';
        else if (statusResult.output.includes('SERVICE_PAUSED')) statusText = 'Paused';
      }
      return { success: true, status: statusText ? { Status: statusText, Name: profile.NssmServiceName } : null };
    } catch (err) {
      return { success: false, status: null };
    }
  });

  // ─── API Server ───
  ipcMain.handle('api-server-start', async (e, port) => {
    try {
      if (apiServer && apiServer.isRunning()) return { success: false, message: 'API server already running' };
      apiServer = new ApiServer(taskManager, config, logger, serviceManager, wrapperGenerator, backupManager);
      const result = await apiServer.start(port);
      config.setSetting('ApiEnabled', true);
      if (port) config.setSetting('ApiPort', port);
      config.save();
      return result;
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
  ipcMain.handle('api-server-stop', async () => {
    try {
      if (!apiServer) return { success: true, message: 'Not running' };
      const result = await apiServer.stop();
      config.setSetting('ApiEnabled', false);
      config.save();
      return result;
    } catch (err) {
      return { success: false, message: err.message };
    }
  });
  ipcMain.handle('api-server-status', () => {
    return {
      running: apiServer ? apiServer.isRunning() : false,
      port: apiServer ? apiServer.port : config.getSetting('ApiPort', 7600),
      url: apiServer && apiServer.isRunning() ? `http://localhost:${apiServer.port}` : null
    };
  });

  // ─── Settings ───
  ipcMain.handle('get-setting', (e, key, defaultVal) => config.getSetting(key, defaultVal));
  ipcMain.handle('set-setting', (e, key, value) => {
    const old = config.getSetting(key);
    config.setSetting(key, value);
    config.save();
    logger.auditSettingsChanged(key, old, value);
  });
  ipcMain.handle('get-profiles', () => config.getProfileList());
  ipcMain.handle('load-profile', (e, name) => {
    const oldProfile = config.getSetting('_activeProfile', 'default');
    config.loadProfile(name);
    logger.auditProfileSwitched(oldProfile, name);
  });

  // ─── Cron Validation ───
  ipcMain.handle('validate-cron', (e, expr) => cronParser.validate(expr));
  ipcMain.handle('get-cron-description', (e, expr) => cronParser.getDescription(expr));
  ipcMain.handle('get-next-run', (e, expr) => {
    const next = cronParser.getNextRunTime(expr);
    return next ? next.toISOString() : null;
  });

  // ─── Dialog ───
  ipcMain.handle('open-script-dialog', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [
        { name: 'PowerShell Scripts', extensions: ['ps1'] },
        { name: 'Executables', extensions: ['exe'] },
        { name: 'Batch Files', extensions: ['bat', 'cmd'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (!result.canceled && result.filePaths.length > 0) return { success: true, path: result.filePaths[0] };
    return { success: false };
  });

  // ─── System Tray ───
  ipcMain.handle('get-tray-settings', () => ({
    closeToTray: config.getSetting('CloseToTray', true),
    startWithWindows: config.getSetting('StartWithWindows', false)
  }));

  ipcMain.handle('set-close-to-tray', (e, enabled) => {
    const old = config.getSetting('CloseToTray', true);
    config.setSetting('CloseToTray', enabled);
    config.save();
    logger.auditSettingsChanged('CloseToTray', old, enabled);
  });

  ipcMain.handle('set-start-with-windows', (e, enabled) => {
    const old = config.getSetting('StartWithWindows', false);
    config.setSetting('StartWithWindows', enabled);
    config.save();
    app.setLoginItemSettings({ openAtLogin: enabled, path: app.getPath('exe') });
    logger.auditSettingsChanged('StartWithWindows', old, enabled);
  });

  // ─── Window Controls ───
  ipcMain.handle('window-minimize', () => mainWindow.minimize());
  ipcMain.handle('window-maximize', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window-close', () => {
    const closeToTray = config.getSetting('CloseToTray', true);
    if (closeToTray) {
      mainWindow.hide();
    } else {
      isQuitting = true;
      mainWindow.close();
    }
  });

  // ─── Log Access (for UI) ───
  // Read from disk, not from this process's memory: tasks and backups run in
  // the service process, and their log lines only reach the GUI via the files.
  ipcMain.handle('get-logs', () => logger.getRecentLogsFromDisk(200));
  ipcMain.handle('get-errors', () => logger.getRecentErrors(200));
  ipcMain.handle('get-audit-logs', () => logger.getRecentAudit(200));
  ipcMain.handle('get-log-stats', () => logger.getStats());

  ipcMain.handle('export-logs', async (e, type, format) => {
    const filters = format === 'csv'
      ? [{ name: 'CSV', extensions: ['csv'] }]
      : format === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'Text', extensions: ['log', 'txt'] }];

    const result = await dialog.showSaveDialog(mainWindow, { filters });
    if (result.canceled || !result.filePath) return { success: false, message: 'Cancelled' };

    if (type === 'errors') return logger.exportErrors(result.filePath, format);
    if (type === 'audit') return logger.exportAudit(result.filePath, format);
    return logger.exportLogs(result.filePath, format);
  });

  ipcMain.handle('renderer-error', (e, errorData) => {
    logger.error(`Renderer: ${errorData.message}`, null, {
      source: 'renderer',
      stack: errorData.stack,
      filename: errorData.filename,
      lineno: errorData.lineno,
      colno: errorData.colno
    });
  });

  // ─── Service management (install/uninstall the headless Windows service) ───
  ipcMain.handle('get-kyrion-service-status', async () => {
    try {
      const nssmCheck = serviceManager.checkNssm();
      if (nssmCheck.installed && nssmCheck.path && nssmCheck.path !== 'nssm') {
        config.setSetting('NssmPath', nssmCheck.path);
      }
      const health = await kyrionService.getHealth();
      return {
        ...health,
        nssmAvailable: nssmCheck.installed,
        nssmPath: nssmCheck.path,
        serviceName: SERVICE_NAME,
      };
    } catch (err) {
      return { installed: false, running: false, nssmAvailable: false, status: null, error: err.message };
    }
  });

  ipcMain.handle('install-kyrion-service', async () => {
    try {
      const result = await kyrionService.install();
      sendServiceNotification('Installed', SERVICE_NAME, result.success, result.message);
      return result;
    } catch (err) {
      logger.error('Failed to install service', err);
      return { success: false, message: `Install failed: ${err.message}` };
    }
  });

  ipcMain.handle('uninstall-kyrion-service', async () => {
    try {
      const result = await kyrionService.uninstall();
      sendServiceNotification('Uninstalled', SERVICE_NAME, result.success, result.message);
      return result;
    } catch (err) {
      logger.error('Failed to uninstall service', err);
      return { success: false, message: `Uninstall failed: ${err.message}` };
    }
  });

  ipcMain.handle('restart-kyrion-service', async () => {
    try {
      const result = await kyrionService.restart();
      sendServiceNotification('Restarted', SERVICE_NAME, result.success, result.message);
      return result;
    } catch (err) {
      return { success: false, message: `Restart failed: ${err.message}` };
    }
  });

  // ─── Web access control (GitHub allowlist) ───
  ipcMain.handle('get-web-access', () => {
    const raw = config.getSetting('WebAllowedUsers', []);
    const users = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;]+/).filter(Boolean);
    return {
      clientId: config.getSetting('GithubClientId', ''),
      // Never send the secret back to the renderer; only whether one is set.
      hasClientSecret: !!config.getSetting('GithubClientSecret', ''),
      baseUrl: config.getSetting('WebBaseUrl', ''),
      bindAll: config.getSetting('ApiBindAll', false),
      port: config.getSetting('ApiPort', 7600),
      users,
    };
  });

  ipcMain.handle('set-web-access', (e, data) => {
    try {
      if (data.clientId !== undefined) config.setSetting('GithubClientId', String(data.clientId).trim());
      // An empty string means "leave the stored secret alone".
      if (data.clientSecret) config.setSetting('GithubClientSecret', String(data.clientSecret).trim());
      if (data.baseUrl !== undefined) config.setSetting('WebBaseUrl', String(data.baseUrl).trim());
      if (data.bindAll !== undefined) config.setSetting('ApiBindAll', !!data.bindAll);
      logger.audit('WEB_ACCESS_SETTINGS_CHANGED', {
        targetType: 'web',
        after: { clientId: config.getSetting('GithubClientId', ''), bindAll: config.getSetting('ApiBindAll', false) },
      });
      return { success: true };
    } catch (err) {
      return { success: false, message: err.message };
    }
  });

  ipcMain.handle('add-web-user', (e, login) => {
    const name = String(login || '').trim().replace(/^@/, '');
    if (!name) return { success: false, message: 'Informe um login do GitHub' };
    if (!/^[A-Za-z0-9-]{1,39}$/.test(name)) {
      return { success: false, message: 'Login do GitHub inválido' };
    }
    const raw = config.getSetting('WebAllowedUsers', []);
    const users = Array.isArray(raw) ? raw.slice() : [];
    if (users.some(u => u.toLowerCase() === name.toLowerCase())) {
      return { success: false, message: 'Esse login já está na lista' };
    }
    users.push(name);
    config.setSetting('WebAllowedUsers', users);
    logger.audit('WEB_USER_ALLOWED', { targetType: 'web', target: name, after: { login: name } });
    return { success: true, users };
  });

  ipcMain.handle('remove-web-user', (e, login) => {
    const name = String(login || '').trim();
    const raw = config.getSetting('WebAllowedUsers', []);
    const users = (Array.isArray(raw) ? raw : []).filter(u => u.toLowerCase() !== name.toLowerCase());
    config.setSetting('WebAllowedUsers', users);
    // Kick the account out now rather than letting its session run its course.
    if (apiServer && apiServer.auth) apiServer.auth.revokeUser(name);
    logger.audit('WEB_USER_REVOKED', { targetType: 'web', target: name, before: { login: name } });
    return { success: true, users };
  });

  ipcMain.handle('get-web-sessions', () => {
    if (!apiServer || !apiServer.auth) return { success: true, sessions: [] };
    return { success: true, sessions: apiServer.auth.listSessions() };
  });

  ipcMain.handle('start-kyrion-service', async () => kyrionService.start());
  ipcMain.handle('stop-kyrion-service', async () => kyrionService.stop());

  ipcMain.handle('get-kyrion-service-health', async () => {
    try {
      return { success: true, ...(await kyrionService.getHealth()) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Who is currently allowed to execute tasks - drives the GUI banner that
  // explains why the app itself is not running jobs.
  ipcMain.handle('get-scheduler-ownership', () => {
    const owner = readOwner();
    return {
      owner,
      selfIsOwner: !!(scheduler && scheduler.isOwner),
      role: ROLE_GUI,
      pid: process.pid,
      dataDir: paths.dataDir(),
    };
  });
}

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  if (logger) {
    logger.error('Uncaught exception', err, { source: 'main-process' });
  }
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  if (logger) {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled rejection', err, { source: 'main-process' });
  }
});

// A second launch hands its argv to the running instance and raises its window.
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

app.whenReady().then(() => {
  try {
    initComponents();
    registerIPC();
    createWindow();
    createTray();
    startScheduler();

    // The web interface is hosted by whichever process owns the scheduler.
    // With the service installed that is the service, so the GUI must not try
    // to bind the same port - see syncWebInterface().
    syncWebInterface();

    const startWithWin = config.getSetting('StartWithWindows', false);
    const currentLogin = app.getLoginItemSettings().openAtLogin;
    if (startWithWin !== currentLogin) {
      app.setLoginItemSettings({ openAtLogin: startWithWin, path: app.getPath('exe') });
    }
  } catch (err) {
    console.error('Startup error:', err);
    if (logger) logger.error('Startup failed', err);
    dialog.showErrorBox('Κύριος Χρόνος', `Failed to start: ${err.message}`);
  }
});

// Release the execution lease on exit so the service (or a later GUI run) can
// take over immediately instead of waiting for the heartbeat to go stale.
app.on('before-quit', () => {
  isQuitting = true;
  if (scheduler) scheduler.stop();
  if (logger) logger.flush();
});

app.on('window-all-closed', () => {
  const closeToTray = config ? config.getSetting('CloseToTray', true) : true;
  if (!closeToTray || isQuitting) {
    if (scheduler) scheduler.stop();
    if (logger) {
      logger.audit('APP_CLOSED', { targetType: 'app' });
      logger.flush();
    }
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow) { mainWindow.show(); }
  else { createWindow(); }
});
