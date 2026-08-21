// serviceScheduler.js - Standalone Node.js scheduler for Windows Service mode
// This runs WITHOUT Electron - just pure Node.js with cron matching.
// Installed as a native Windows service via node-windows.

const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

// ─── Config paths ───
const APP_NAME = 'KyrionKronou';
const CONFIG_DIR = process.env.KYRION_CONFIG_DIR || path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  APP_NAME, 'config'
);
const LOGS_DIR = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  APP_NAME, 'logs'
);
const TASKS_FILE = path.join(CONFIG_DIR, 'tasks.json');
const BACKUP_PROFILES_FILE = path.join(CONFIG_DIR, 'backup-profiles.json');

// ─── Simple Logger ───
function log(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [SERVICE] [${level}] ${message}\n`;
  
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(LOGS_DIR, `service-${dateStr}.log`);
    fs.appendFileSync(logFile, line);
  } catch (e) {}
  
  if (level === 'ERROR') console.error(line.trim());
  else console.log(line.trim());
}

// ─── Cron Parser (simple 5-field) ───
function shouldRun(cronExpr, lastRun) {
  if (!cronExpr) return false;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const now = new Date();
  const [min, hour, dom, mon, dow] = parts;

  // Skip if last run was less than 55 seconds ago (avoid double-run)
  if (lastRun && (Date.now() - lastRun) < 55000) return false;

  function matchField(field, value) {
    if (field === '*') return true;
    if (field.includes(',')) return field.split(',').some(v => matchField(v.trim(), value));
    if (field.includes('-')) {
      const [a, b] = field.split('-').map(Number);
      return value >= a && value <= b;
    }
    if (field.includes('/')) {
      const [start, step] = field.split('/').map(Number);
      return value % step === (start || 0);
    }
    return parseInt(field) === value;
  }

  return matchField(min, now.getMinutes()) &&
         matchField(hour, now.getHours()) &&
         matchField(dom, now.getDate()) &&
         matchField(mon, now.getMonth() + 1) &&
         matchField(dow, now.getDay());
}

// ─── Task Executor ───
function executeTask(task) {
  const scriptPath = task.ScriptPath;
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    log('ERROR', `Script not found for task "${task.Name}": ${scriptPath}`);
    return;
  }

  log('INFO', `Executing task: ${task.Name} (${scriptPath})`);
  const ext = path.extname(scriptPath).toLowerCase();
  
  let cmd;
  if (ext === '.ps1') {
    cmd = `powershell.exe -ExecutionPolicy Bypass -NoProfile -File "${scriptPath}"`;
  } else if (ext === '.bat' || ext === '.cmd') {
    cmd = `cmd.exe /c "${scriptPath}"`;
  } else {
    cmd = `"${scriptPath}"`;
  }

  exec(cmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    if (error) {
      log('ERROR', `Task "${task.Name}" failed: ${error.message}`);
    } else {
      log('INFO', `Task "${task.Name}" completed successfully`);
    }
    if (stdout) log('INFO', `Task "${task.Name}" stdout: ${stdout.substring(0, 200)}`);
    if (stderr) log('WARN', `Task "${task.Name}" stderr: ${stderr.substring(0, 200)}`);
  });
}

// ─── Backup Executor ───
function executeBackup(profile) {
  log('INFO', `Executing backup: ${profile.Name}`);
  
  // Load mysqldump path
  let mysqldumpPath = findMysqldump();
  if (!mysqldumpPath) {
    log('ERROR', `mysqldump not found for backup "${profile.Name}"`);
    return;
  }

  const databases = profile.Databases && profile.Databases.length > 0 
    ? profile.Databases 
    : ['--all-databases'];

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');

  for (const db of databases) {
    const dbSafe = db === '--all-databases' ? 'all_databases' : db;
    let filename = (profile.NamingPattern || '{database}_{date}_{time}')
      .replace(/{database}/g, dbSafe)
      .replace(/{date}/g, dateStr)
      .replace(/{time}/g, timeStr)
      .replace(/{timestamp}/g, now.getTime().toString());

    const dumpExt = '.sql';
    let finalExt = dumpExt;
    if (profile.Compression === 'zip') finalExt = '.sql.zip';
    else if (profile.Compression === '7z') finalExt = '.sql.7z';

    const backupPath = profile.BackupPath || path.join(CONFIG_DIR, '..', 'backups');
    if (!fs.existsSync(backupPath)) fs.mkdirSync(backupPath, { recursive: true });

    const dumpPath = path.join(backupPath, filename + dumpExt);
    const finalPath = path.join(backupPath, filename + finalExt);

    const args = [
      `"${mysqldumpPath}"`,
      `--host="${profile.Host}"`,
      `--port=${profile.Port || 3306}`,
      `--user="${profile.User}"`,
      `--password="${profile.Password}"`,
    ];
    if (profile.ExtraArgs) args.push(profile.ExtraArgs);
    if (db === '--all-databases') args.push('--all-databases');
    else args.push(`"${db}"`);
    args.push(`--result-file="${dumpPath}"`);

    const cmd = args.join(' ');
    log('INFO', `Backup DB: ${db} -> ${filename}`);

    try {
      execSync(cmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, windowsHide: true });
      log('INFO', `Backup dump OK: ${db} (${fs.statSync(dumpPath).size} bytes)`);
    } catch (err) {
      log('ERROR', `Backup dump failed for ${db}: ${err.message}`);
      continue;
    }

    // Compress
    if (profile.Compression && profile.Compression !== 'none' && fs.existsSync(dumpPath)) {
      try {
        const sevenZip = find7z();
        if (sevenZip && profile.Compression === '7z') {
          execSync(`"${sevenZip}" a -t7z -mx=${profile.CompressionLevel || 5} "${finalPath}" "${dumpPath}"`, { timeout: 300000, windowsHide: true });
        } else if (sevenZip && profile.Compression === 'zip') {
          execSync(`"${sevenZip}" a -tzip -mx=${profile.CompressionLevel || 5} "${finalPath}" "${dumpPath}"`, { timeout: 300000, windowsHide: true });
        } else {
          execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${dumpPath}' -DestinationPath '${finalPath}' -CompressionLevel Optimal"`, { timeout: 300000, windowsHide: true });
        }
        try { fs.unlinkSync(dumpPath); } catch(e) {}
        log('INFO', `Compressed: ${path.basename(finalPath)}`);
      } catch (err) {
        log('ERROR', `Compression failed: ${err.message}`);
      }
    }

    // Upload targets
    if (profile.UploadTargets && profile.UploadTargets.length > 0) {
      const uploadFile = fs.existsSync(finalPath) ? finalPath : dumpPath;
      for (const target of profile.UploadTargets) {
        uploadFileToTarget(uploadFile, target).catch(err => {
          log('ERROR', `Upload failed: ${err.message}`);
        });
      }
    }
  }

  log('INFO', `Backup profile "${profile.Name}" completed`);
}

async function uploadFileToTarget(filePath, target) {
  const filename = path.basename(filePath);
  
  if (target.type === 'sftp') {
    const Client = require('ssh2-sftp-client');
    const sftp = new Client();
    const remotePath = target.path ? `${target.path}/${filename}` : `/${filename}`;
    
    await sftp.connect({
      host: target.host,
      port: parseInt(target.port) || 22,
      username: target.user,
      password: target.password,
      readyTimeout: 15000,
    });
    if (target.path) await sftp.mkdir(target.path, true);
    await sftp.put(filePath, remotePath);
    await sftp.end();
    log('INFO', `SFTP upload OK: ${filename} -> ${target.host}:${remotePath}`);
  } else if (target.type === 'ftp') {
    // FTP upload via PowerShell
    const port = target.port || 21;
    const remotePath = target.path ? `${target.path}/${filename}` : filename;
    const ps = `$ftp = New-Object System.Net.FtpWebRequest("ftp://${target.host}:${port}/${remotePath}"); $ftp.Credentials = New-Object System.Net.NetworkCredential("${target.user}","${target.password}"); $ftp.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile; $ftp.UseBinary = $true; $content = [System.IO.File]::ReadAllBytes("${filePath}"); $ftp.ContentLength = $content.Length; $reqStream = $ftp.GetRequestStream(); $reqStream.Write($content, 0, $content.Length); $reqStream.Close(); $reqStream.Dispose();`;
    execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 600000, windowsHide: true });
    log('INFO', `FTP upload OK: ${filename} -> ${target.host}:${remotePath}`);
  }
}

// ─── Find tools ───
function findMysqldump() {
  const paths = [
    'C:\\tools\\mysql\\bin\\mysqldump.exe',
    'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
    'C:\\Program Files\\MySQL\\MySQL Server 5.7\\bin\\mysqldump.exe',
    'C:\\xampp\\mysql\\bin\\mysqldump.exe',
    'C:\\wamp64\\bin\\mysql\\mysql8.0.31\\bin\\mysqldump.exe',
    'C:\\ProgramData\\chocolatey\\bin\\mysqldump.exe',
  ];
  for (const p of paths) { if (fs.existsSync(p)) return p; }
  // Try PATH
  try { return execSync('where mysqldump', { encoding: 'utf8', windowsHide: true }).trim().split('\n')[0]; } catch(e) {}
  // Try config
  try {
    const settingsFile = path.join(CONFIG_DIR, 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (settings.MysqldumpPath && fs.existsSync(settings.MysqldumpPath)) return settings.MysqldumpPath;
    }
  } catch(e) {}
  return null;
}

function find7z() {
  const paths = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    'C:\\ProgramData\\chocolatey\\bin\\7z.exe',
  ];
  for (const p of paths) { if (fs.existsSync(p)) return p; }
  try { return execSync('where 7z', { encoding: 'utf8', windowsHide: true }).trim().split('\n')[0]; } catch(e) {}
  return null;
}

// ─── File watchers ───
let lastTaskRun = {}; // { taskId: timestamp }

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log('ERROR', `Failed to load ${file}: ${e.message}`);
  }
  return fallback;
}

// ─── Main Scheduler Loop ───
function startScheduler() {
  log('INFO', '=== Kyrion Kronou Service Scheduler started ===');
  log('INFO', `Config dir: ${CONFIG_DIR}`);
  log('INFO', `Poll interval: 15 seconds`);

  // Write PID file
  try {
    const pidFile = path.join(CONFIG_DIR, 'service.pid');
    fs.writeFileSync(pidFile, process.pid.toString());
  } catch(e) {}

  setInterval(() => {
    try {
      // ── Tasks ──
      const tasks = loadJson(TASKS_FILE, []);
      const enabledTasks = Array.isArray(tasks) ? tasks.filter(t => t.Enabled !== false) : [];
      
      for (const task of enabledTasks) {
        if (shouldRun(task.CronExpression, lastTaskRun[task.Id])) {
          lastTaskRun[task.Id] = Date.now();
          executeTask(task);
        }
      }

      // ── Backups ──
      const profiles = loadJson(BACKUP_PROFILES_FILE, []);
      const enabledProfiles = Array.isArray(profiles) ? profiles.filter(p => p.Enabled && p.CronExpression) : [];
      
      for (const profile of enabledProfiles) {
        if (shouldRun(profile.CronExpression, lastTaskRun['backup_' + profile.Id])) {
          lastTaskRun['backup_' + profile.Id] = Date.now();
          executeBackup(profile);
        }
      }
    } catch (err) {
      log('ERROR', `Scheduler error: ${err.message}`);
    }
  }, 15000); // Poll every 15 seconds
}

// ─── Start ───
log('INFO', `Starting in service mode (PID: ${process.pid})`);
log('INFO', `Node version: ${process.version}`);
startScheduler();
