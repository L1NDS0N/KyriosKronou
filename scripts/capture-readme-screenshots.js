const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = offset => new Date(Date.now() + offset).toISOString();
const dayKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const tasks = [
  { Id: 'task-1', Name: 'Relatório diário de vendas', CronExpression: '0 8 * * 1-5', ScriptPath: 'C:\\Scripts\\sales-report.ps1', ScriptType: 'ps1', Enabled: true, Description: 'Consolida vendas e envia por e-mail.' },
  { Id: 'task-2', Name: 'Rotação de logs', CronExpression: '15 2 * * *', ScriptPath: 'C:\\Scripts\\rotate-logs.bat', ScriptType: 'bat', Enabled: true, Description: 'Comprime e remove logs antigos.' },
  { Id: 'task-3', Name: 'Sincronização ERP → NAS', CronExpression: '0 22 * * *', ScriptPath: 'C:\\Scripts\\sync-erp.ps1', ScriptType: 'ps1', Enabled: true, Description: 'Replica documentos fiscais para o NAS.' },
  { Id: 'task-4', Name: 'Limpeza de temporários', CronExpression: '30 3 * * 0', ScriptPath: 'C:\\Scripts\\cleanup.ps1', ScriptType: 'ps1', Enabled: false, Description: 'Executa semanalmente, desativado neste ambiente.' },
];

const history = [
  { TaskName: 'Relatório diário de vendas', Timestamp: iso(-22 * 60000), Status: 'Success', Duration: '00:00:08', CronExpression: '0 8 * * 1-5' },
  { TaskName: 'Rotação de logs', Timestamp: iso(-3 * 3600000), Status: 'Success', Duration: '00:01:12', CronExpression: '15 2 * * *' },
  { TaskName: 'Sincronização ERP → NAS', Timestamp: iso(-7 * 3600000), Status: 'Error', Duration: '00:00:03', CronExpression: '0 22 * * *' },
  { TaskName: 'Backup MySQL', Timestamp: iso(-26 * 3600000), Status: 'Success', Duration: '00:04:41', CronExpression: '0 2 * * *' },
  { TaskName: 'Backup SQL Server', Timestamp: iso(-50 * 3600000), Status: 'Success', Duration: '00:09:22', CronExpression: '0 23 * * 0' },
  { TaskName: 'Retenção de arquivos antigos', Timestamp: iso(-74 * 3600000), Status: 'Success', Duration: '00:02:05', CronExpression: '30 4 * * *' },
];

const backups = [
  { Id: 'backup-1', Name: 'MySQL · produção', Engine: 'mysql', Enabled: true, Host: 'db01.local', Port: 3306, Databases: ['erp', 'customers'], BackupPath: 'D:\\Backups\\MySQL', CronExpression: '0 2 * * *', Compression: '7z', CompressionLevel: 5, UploadTargets: [{ type: 'sftp' }], LastRun: iso(-26 * 3600000), LastStatus: 'Success' },
  { Id: 'backup-2', Name: 'SQL Server · DW', Engine: 'sqlserver', BackupFormat: 'bak', Enabled: true, Host: 'sql01.local', Port: 1433, Databases: ['dw'], BackupPath: 'D:\\Backups\\SQLServer', CronExpression: '0 23 * * 0', Compression: 'none', UploadTargets: [{ type: 'smb' }], LastRun: iso(-50 * 3600000), LastStatus: 'Success' },
];

const syncs = [
  { Id: 'sync-1', Name: 'Documentos fiscais', Engine: 'local', Enabled: true, SourcePath: 'C:\\ERP\\Documentos', DestPath: 'D:\\Espelho\\Documentos', Mode: 'incremental', Mirror: true, CronExpression: '0 22 * * *', Retention: { Enabled: true, ByAge: true, KeepDays: 30, ByCount: true, KeepCount: 30, ByMonthly: true, MonthlyKeepMonths: 12 }, LastRun: iso(-7 * 3600000), LastStatus: 'Error' },
  { Id: 'sync-2', Name: 'Fotos do servidor', Engine: 'sftp', Enabled: true, Host: 'backup.local', Port: 22, User: 'kiro', SourcePath: '/srv/fotos', DestPath: '/backup/fotos', Mode: 'incremental', Mirror: false, CronExpression: '0 */6 * * *', LastRun: iso(-90 * 60000), LastStatus: 'Success' },
];

const retentionProfiles = [
  { Id: 'ret-1', Name: 'Produção · mensal', FolderPath: 'D:\\Backups\\Producao', CronExpression: '30 4 1 * *', Enabled: true, LastStatus: 'Success', LastRun: iso(-30 * 86400000) },
  { Id: 'ret-2', Name: 'Arquivoold', FolderPath: 'D:\\Backups\\Arquivo', CronExpression: '0 5 * * 0', Enabled: false, LastStatus: null, LastRun: null },
];

const services = [
  { Name: 'Kyrion_Rotation', Status: 'Running', Application: 'C:\\ProgramData\\KyriosChronos\\serviceScheduler.js', StartupType: 'Automatic' },
  { Name: 'Kyrion_Sync', Status: 'Running', Application: 'C:\\ProgramData\\KyriosChronos\\serviceScheduler.js', StartupType: 'Automatic' },
  { Name: 'MySQL80', Status: 'Running', Application: 'C:\\Program Files\\MySQL\\bin\\mysqld.exe', StartupType: 'Automatic' },
  { Name: 'Spooler', Status: 'Stopped', Application: 'C:\\Windows\\System32\\spoolsv.exe', StartupType: 'Manual' },
];

const logs = [
  { timestamp: iso(-6 * 60000), level: 'INFO', message: 'Scheduler tick completed', source: 'scheduler' },
  { timestamp: iso(-22 * 60000), level: 'INFO', message: 'Task finished with status Success', source: 'taskManager' },
  { timestamp: iso(-3 * 3600000), level: 'WARN', message: 'Backup target latency above threshold', source: 'backupManager' },
  { timestamp: iso(-26 * 3600000), level: 'INFO', message: 'MySQL dump uploaded to SFTP', source: 'backupManager' },
];

const errors = [
  { timestamp: iso(-7 * 3600000), message: 'SFTP connection timed out', stack: 'TimeoutError: SFTP connection timed out', context: { profile: 'Fotos do servidor' } },
  { timestamp: iso(-30 * 3600000), message: 'Retention folder was locked', stack: 'EPERM: operation not permitted', context: { folder: 'D:\\Backups\\Producao' } },
];

const audit = [
  { timestamp: iso(-22 * 60000), action: 'TASK_EXECUTED', actor: 'l1nds0n', ip: '127.0.0.1', target: 'Relatório diário de vendas', changes: { status: 'Success' } },
  { timestamp: iso(-3 * 3600000), action: 'PROFILE_UPDATED', actor: 'l1nds0n', ip: '127.0.0.1', target: 'Documentos fiscais', changes: { Enabled: true } },
  { timestamp: iso(-26 * 3600000), action: 'BACKUP_EXECUTED', actor: 'scheduler', ip: '127.0.0.1', target: 'MySQL · produção', changes: { status: 'Success' } },
];

function calendarPayload(fromIso, toIso) {
  const days = {};
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const items = [
    { name: 'Relatório diário', kind: 'task', page: 'tasks', at: '08:00' },
    { name: 'Rotação de logs', kind: 'task', page: 'tasks', at: '02:15' },
    { name: 'Backup MySQL', kind: 'backup', page: 'backup', at: '02:00' },
    { name: 'Sync ERP', kind: 'service', page: 'sync', at: '22:00' },
  ];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    const at = hm => new Date(`${key}T${hm}:00`).toISOString();
    const list = [];
    if (d.getDay() >= 1 && d.getDay() <= 5) list.push({ ...items[0], id: 'task-1', at: at(items[0].at), state: 'future' });
    if (key === dayKey(new Date())) list.push({ ...items[1], id: 'task-2', at: at(items[1].at), state: 'future' });
    if (d.getDate() === 1) list.push({ ...items[2], id: 'backup-1', at: at(items[2].at), state: 'future' });
    if (d.getDay() === 0) list.push({ ...items[3], id: 'sync-1', at: at(items[3].at), state: 'future' });
    if (list.length) days[key] = list;
  }
  return { success: true, days, totals: { scheduled: 18, executed: 14, failed: 1, sources: 4 }, hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: [2, 4, 8, 3, 1, 1, 2, 5, 9, 6, 3, 2, 2, 4, 3, 2, 1, 2, 4, 3, 2, 6, 10, 5][h] })) };
}

const responses = {
  'get-tasks': tasks,
  'get-history': history,
  'get-backup-profiles': backups,
  'get-backup-history': { history, stats: { total: 24, success: 23, failed: 1 } },
  'get-backup-history-stats': { stats: { total: 24, success: 23, failed: 1 } },
  'get-sync-profiles': syncs,
  'get-sync-history': { history: [], stats: { total: 18, success: 17, failed: 1 } },
  'get-sync-engines': [{ id: 'local', label: 'Local / mapped drive', defaultPort: null, credentials: false }, { id: 'sftp', label: 'SFTP', defaultPort: 22, credentials: true }],
  'get-db-engines': [{ id: 'mysql', label: 'MySQL / MariaDB', defaultPort: 3306, formats: null }, { id: 'sqlserver', label: 'SQL Server', defaultPort: 1433, formats: [{ id: 'bak', label: 'Native .bak', requiresExternalTool: false }, { id: 'bacpac', label: 'Portable .bacpac', requiresExternalTool: true }] }],
  'get-services': services,
  'get-service-count': services.length,
  'get-recent-runs': history.map((h, i) => ({ runId: `run-${i}`, targetId: 'task-1', targetName: h.TaskName, status: h.Status === 'Success' ? 'finished' : 'failed', startedAt: h.Timestamp })),
  'get-active-runs': [],
  'get-calendar': (event, from, to) => calendarPayload(from, to),
  'get-next-run': () => iso(45 * 60000),
  'get-cron-description': () => 'A cada dia às 08:00',
  'validate-cron': () => ({ valid: true }),
  'check-schedule-conflicts': () => ({ conflicts: [], suggestions: [] }),
  'get-logs': logs,
  'get-errors': errors,
  'get-audit-logs': audit,
  'get-log-stats': { app: logs.length, errors: errors.length, audit: audit.length },
  'get-retention-profiles': retentionProfiles,
  'analyze-sync-folder': () => ({ ok: true, folderPattern: 'dated-folders', totalFiles: 38, totalBytes: 81234567, folders: [{ rel: 'daily', pattern: 'dated-folders', folderPattern: 'dated-folders', evidence: { understood: [{ rel: 'daily/2026-09-20/erp.7z', source: 'name', date: '2026-09-20', size: 8123456 }, { rel: 'daily/2026-09-21/erp.7z', source: 'name', date: '2026-09-21', size: 8291456 }] } }] }),
  'preview-sync-retention': () => ({ ok: true, delete: [{ rel: 'daily/2025-01-03/erp.7z', folder: 'daily', reason: 'age', date: '2025-01-03T00:00:00.000Z', detail: 'more than 12 months' }], kept: [{ rel: 'daily/2026-09-20/erp.7z', folder: 'daily', reason: 'monthly', date: '2026-09-20T00:00:00.000Z', detail: 'monthly copy' }], rules: [{ type: 'age', kind: 'delete', days: 30 }, { type: 'monthly', kind: 'keep', months: 12 }], minKeep: 5, dateSource: 'names', totalFiles: 38, totalSnapshots: 38, folders: [{ rel: 'daily', folderPattern: 'dated-folders', delete: [{ rel: '2025-01-03/erp.7z', folder: 'daily', reason: 'age', date: '2025-01-03T00:00:00.000Z', detail: 'more than 12 months' }], kept: [{ rel: '2026-09-20/erp.7z', folder: 'daily', reason: 'monthly', date: '2026-09-20T00:00:00.000Z', detail: 'monthly copy' }], rules: [{ type: 'age', kind: 'delete', days: 30 }], minKeep: 5, dateSource: 'names' }] }),
  'preview-sync-plan': () => ({ ok: true, copy: [{ rel: 'notas.txt', size: 1024 }], skipped: [], delete: [], retention: [{ rel: 'antigo.7z', reason: 'age' }], totalSource: 12, totalBytes: 1024 }),
  'get-setting': (event, key, defaultValue) => ({ ProfileName: 'default', NssmPath: 'nssm', Language: 'pt-BR' }[key] ?? defaultValue),
  'get-scheduler-ownership': { owner: 'gui', role: 'gui', healthy: true, lastSeen: iso(-5 * 1000) },
  'get-kyrion-service-status': { installed: false, running: false, healthy: true },
  'get-kyrion-service-health': { installed: false, running: false, healthy: true },
  'get-web-access': { enabled: false, users: [] },
  'get-tray-settings': { closeToTray: true, startMinimized: false, startWithWindows: false },
  'get-scripts-dir': 'C:\\ProgramData\\KyriosChronos\\scripts',
  'get-profiles': [{ Name: 'default' }],
};

function registerIpc() {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8');
  const channels = new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]));
  for (const channel of channels) {
    ipcMain.handle(channel, (event, ...args) => {
      const response = responses[channel];
      if (typeof response === 'function') return response(event, ...args);
      return response === undefined ? null : response;
    });
  }
}

async function capture(win, name, setup) {
  if (setup) await win.webContents.executeJavaScript(`(async () => { ${setup} })()`);
  win.showInactive();
  await wait(650);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, name), image.toPNG());
  process.stdout.write(`${name}\n`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  registerIpc();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: '#0a0a12',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await wait(1400);
  await win.webContents.executeJavaScript("i18n.setLang('pt-BR')");
  await wait(300);

  await capture(win, 'dashboard.png', `document.querySelector('.nav-btn[data-page="dashboard"]').click(); await new Promise(r => setTimeout(r, 400)); await refreshCurrentPage();`);
  await capture(win, 'tarefas.png', `document.querySelector('.nav-btn[data-page="tasks"]').click(); await new Promise(r => setTimeout(r, 400)); await refreshCurrentPage();`);
  await capture(win, 'backups.png', `document.querySelector('.nav-btn[data-page="backup"]').click(); await new Promise(r => setTimeout(r, 400)); await backupPage.load();`);
  await capture(win, 'sincronizacao.png', `document.querySelector('.nav-btn[data-page="sync"]').click(); await new Promise(r => setTimeout(r, 400)); await syncPage.load();`);
  await capture(win, 'retencao.png', `document.querySelector('.nav-btn[data-page="retention"]').click(); await new Promise(r => setTimeout(r, 400)); await retentionPage.load(); retentionPage.folder = 'D:\\\\Backups\\\\Producao'; retentionPage.advanced = false; await retentionPage.analyze(); clearTimeout(retentionPage.previewTimer); await retentionPage.runPreview(); retentionPage.setPreviewView('tree');`);
  await capture(win, 'servicos.png', `document.querySelector('.nav-btn[data-page="services"]').click(); await new Promise(r => setTimeout(r, 400)); await refreshServices({ force: true });`);
  await capture(win, 'historico.png', `document.querySelector('.nav-btn[data-page="history"]').click(); await new Promise(r => setTimeout(r, 400)); await refreshHistory();`);
  await capture(win, 'logs.png', `document.querySelector('.nav-btn[data-page="logs"]').click(); await new Promise(r => setTimeout(r, 400)); await refreshLogs();`);
  await capture(win, 'configuracoes.png', `document.querySelector('.nav-btn[data-page="settings"]').click(); await new Promise(r => setTimeout(r, 400)); await loadSettings();`);
  await capture(win, 'calendario.png', `document.querySelector('.nav-btn[data-page="dashboard"]').click(); await new Promise(r => setTimeout(r, 400)); KyriosCalendar.open('month');`);
  await capture(win, 'wizard-backup.png', `hideModal(); document.querySelector('.nav-btn[data-page="backup"]').click(); await new Promise(r => setTimeout(r, 400)); await backupPage.load(); backupPage.showCreateModal();`);
  await capture(win, 'wizard-sync-retencao.png', `hideModal(); document.querySelector('.nav-btn[data-page="sync"]').click(); await new Promise(r => setTimeout(r, 400)); await syncPage.load(); syncPage.showCreateModal(); syncPage.draft.SourcePath = 'C:\\\\ERP\\\\Documentos'; syncPage.draft.DestPath = 'D:\\\\Espelho\\\\Documentos'; syncPage.draft.Retention.Enabled = true; syncPage.currentStep = 1; syncPage._renderWizard(); await syncPage.runAnalysis(); await syncPage.refreshPreview();`);
  await capture(win, 'retencao-arvore.png', `hideModal(); document.querySelector('.nav-btn[data-page="retention"]').click(); await new Promise(r => setTimeout(r, 400)); await retentionPage.load(); retentionPage.folder = 'D:\\\\Backups\\\\Producao'; await retentionPage.analyze(); clearTimeout(retentionPage.previewTimer); await retentionPage.runPreview(); retentionPage.setPreviewView('tree');`);

  win.destroy();
  app.quit();
}

app.whenReady().then(main).catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
