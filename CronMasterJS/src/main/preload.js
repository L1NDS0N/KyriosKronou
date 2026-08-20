// preload.js - IPC Bridge
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Tasks
  getTasks: () => ipcRenderer.invoke('get-tasks'),
  addTask: (data) => ipcRenderer.invoke('add-task', data),
  updateTask: (data) => ipcRenderer.invoke('update-task', data),
  deleteTask: (id) => ipcRenderer.invoke('delete-task', id),
  executeTask: (task) => ipcRenderer.invoke('execute-task', task),
  getDueTasks: () => ipcRenderer.invoke('get-due-tasks'),

  // History
  getHistory: () => ipcRenderer.invoke('get-history'),
  exportHistory: (format) => ipcRenderer.invoke('export-history', format),

  // Import/Export
  exportTasks: () => ipcRenderer.invoke('export-tasks'),
  importTasks: () => ipcRenderer.invoke('import-tasks'),

  // Services
  getServices: () => ipcRenderer.invoke('get-services'),
  getServiceCount: () => ipcRenderer.invoke('get-service-count'),
  checkNssm: (p) => ipcRenderer.invoke('check-nssm', p),

  // NSSM Installer
  nssmCheckInstalled: (p) => ipcRenderer.invoke('nssm-check-installed', p),
  nssmCheckManagers: () => ipcRenderer.invoke('nssm-check-managers'),
  nssmInstallVia: (manager) => ipcRenderer.invoke('nssm-install-via', manager),
  nssmDownloadManual: () => ipcRenderer.invoke('nssm-download-manual'),
  installService: (data) => ipcRenderer.invoke('install-service', data),
  startService: (name) => ipcRenderer.invoke('start-service', name),
  stopService: (name) => ipcRenderer.invoke('stop-service', name),
  restartService: (name) => ipcRenderer.invoke('restart-service', name),
  uninstallService: (name) => ipcRenderer.invoke('uninstall-service', name),

  // Wrapper + NSSM Service per Task
  generateWrapper: (task) => ipcRenderer.invoke('generate-wrapper', task),
  removeWrapper: (taskId) => ipcRenderer.invoke('remove-wrapper', taskId),
  listWrappers: () => ipcRenderer.invoke('list-wrappers'),
  readServiceLog: (taskId) => ipcRenderer.invoke('read-service-log', taskId),
  getServiceParams: (name) => ipcRenderer.invoke('get-service-params', name),
  setServiceParams: (name, params) => ipcRenderer.invoke('set-service-params', name, params),
  renameService: (oldName, newName) => ipcRenderer.invoke('rename-service', oldName, newName),
  readScriptFile: (path) => ipcRenderer.invoke('read-script-file', path),
  saveScriptFile: (path, content) => ipcRenderer.invoke('save-script-file', path, content),
  getScriptsDir: () => ipcRenderer.invoke('get-scripts-dir'),
  browseFolder: (title) => ipcRenderer.invoke('browse-folder', title),
  getBackupProfiles: () => ipcRenderer.invoke('get-backup-profiles'),
  createBackupProfile: (data) => ipcRenderer.invoke('create-backup-profile', data),
  updateBackupProfile: (data) => ipcRenderer.invoke('update-backup-profile', data),
  deleteBackupProfile: (id) => ipcRenderer.invoke('delete-backup-profile', id),
  runBackup: (id) => ipcRenderer.invoke('run-backup', id),
  testMysqlConnection: (h,p,u,pass) => ipcRenderer.invoke('test-mysql-connection', h,p,u,pass),
  listMysqlDatabases: (h,p,u,pass) => ipcRenderer.invoke('list-mysql-databases', h,p,u,pass),
  exportBackupProfile: (id) => ipcRenderer.invoke('export-backup-profile', id),
  importBackupProfile: () => ipcRenderer.invoke('import-backup-profile'),
  checkMysqldump: () => ipcRenderer.invoke('check-mysqldump'),
  testFtpConnection: (cfg) => ipcRenderer.invoke('test-ftp-connection', cfg),
  testSftpConnection: (cfg) => ipcRenderer.invoke('test-sftp-connection', cfg),
  downloadMysqldump: () => ipcRenderer.invoke('download-mysqldump'),
  setMysqldumpPath: (p) => ipcRenderer.invoke('set-mysqldump-path', p),
  deployTaskService: (task) => ipcRenderer.invoke('deploy-task-service', task),
  undeployTaskService: (task) => ipcRenderer.invoke('undeploy-task-service', task),
  getTaskServiceStatus: (taskId) => ipcRenderer.invoke('get-task-service-status', taskId),

  // Config
  getSetting: (key, defaultVal) => ipcRenderer.invoke('get-setting', key, defaultVal),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  loadProfile: (name) => ipcRenderer.invoke('load-profile', name),

  // System Tray
  getTraySettings: () => ipcRenderer.invoke('get-tray-settings'),
  setCloseToTray: (enabled) => ipcRenderer.invoke('set-close-to-tray', enabled),
  setStartWithWindows: (enabled) => ipcRenderer.invoke('set-start-with-windows', enabled),
  apiServerStart: (port) => ipcRenderer.invoke('api-server-start', port),
  apiServerStop: () => ipcRenderer.invoke('api-server-stop'),
  apiServerStatus: () => ipcRenderer.invoke('api-server-status'),

  // Cron
  validateCron: (expr) => ipcRenderer.invoke('validate-cron', expr),
  getCronDescription: (expr) => ipcRenderer.invoke('get-cron-description', expr),
  getNextRun: (expr) => ipcRenderer.invoke('get-next-run', expr),

  // File dialogs
  openScriptDialog: () => ipcRenderer.invoke('open-script-dialog'),

  // Window
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close: () => ipcRenderer.invoke('window-close'),

  // Logs & Audit
  getLogs: () => ipcRenderer.invoke('get-logs'),
  getErrors: () => ipcRenderer.invoke('get-errors'),
  getAuditLogs: () => ipcRenderer.invoke('get-audit-logs'),
  getLogStats: () => ipcRenderer.invoke('get-log-stats'),
  exportLogs: (type, format) => ipcRenderer.invoke('export-logs', type, format),
  reportError: (errorData) => ipcRenderer.invoke('renderer-error', errorData),

  // Events
  onDataUpdated: (callback) => ipcRenderer.on('data-updated', callback),
  onTaskExecuted: (callback) => ipcRenderer.on('task-executed', (e, result) => callback(result))
});
