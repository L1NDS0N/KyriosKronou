// backupManager.js - MySQL Backup Manager
const { execSync, exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const engines = require('./db');

class BackupManager {
  constructor(config, logger, runRegistry) {
    this.config = config;
    this.logger = logger;
    // Optional: reports live progress for the UI.
    this.runs = runRegistry || null;
    this.profilesFile = path.join(config.configDir, 'backup-profiles.json');
    this.historyFile = path.join(config.configDir, 'backup-history.json');
    this.profiles = this.loadProfiles();
    this.history = this.loadHistory();
    this.mysqldumpPath = this.findMysqldump();
    this._sweepStaleCredentialFiles();
  }

  // ─── Profile Management ───
  loadProfiles() {
    try {
      if (fs.existsSync(this.profilesFile)) {
        return JSON.parse(fs.readFileSync(this.profilesFile, 'utf8'));
      }
    } catch (e) {}
    return [];
  }

  // Re-read profiles from disk. The scheduler calls this every tick so the
  // service picks up changes the GUI made in another process.
  reload() {
    this.profiles = this.loadProfiles();
    return this.profiles;
  }

  saveProfiles() {
    fs.writeFileSync(this.profilesFile, JSON.stringify(this.profiles, null, 2), 'utf8');
  }

  createProfile(data) {
    const profile = {
      Id: data.Id || crypto.randomUUID(),
      Name: data.Name,
      Description: data.Description || '',
      // Connection
      Host: data.Host || 'localhost',
      Port: data.Port || 3306,
      User: data.User || 'root',
      Password: data.Password || '',
      // Databases
      Databases: data.Databases || [], // ['db1', 'db2'] or ['--all-databases']
      // Backup options
      BackupPath: data.BackupPath || path.join(process.env.USERPROFILE || '', 'KyrionBackups'),
      NamingPattern: data.NamingPattern || '{database}_{date}_{time}',
      Compression: data.Compression || 'zip', // none, zip, 7z
      CompressionLevel: data.CompressionLevel || 5, // 1-9
      // Extra mysqldump args
      ExtraArgs: data.ExtraArgs || '--single-transaction --routines --triggers --events',
      // Upload targets
      UploadTargets: data.UploadTargets || [],
      // Local storage
      KeepLocal: data.KeepLocal !== false, // keep file locally after upload
      KeepDays: data.KeepDays || 7, // days to keep local backups
      // Schedule
      CronExpression: data.CronExpression || '0 2 * * *',
      Enabled: data.Enabled !== false,
      // Management mode: 'cronmaster' (default) or 'nssm'
      ManagementMode: data.ManagementMode || 'cronmaster',
      NssmServiceName: data.NssmServiceName || '',
      // Metadata
      CreatedAt: data.CreatedAt || new Date().toISOString(),
      UpdatedAt: data.UpdatedAt || new Date().toISOString(),
      LastRun: null,
      LastStatus: null
    };
    this.profiles.push(profile);
    this.saveProfiles();
    this.logger.audit('BACKUP_PROFILE_CREATED', { targetType: 'backup', target: profile.Id, after: { Name: profile.Name } });
    return profile;
  }

  updateProfile(data) {
    const idx = this.profiles.findIndex(p => p.Id === data.Id);
    if (idx === -1) return null;
    this.profiles[idx] = { ...this.profiles[idx], ...data, UpdatedAt: new Date().toISOString() };
    this.saveProfiles();
    return this.profiles[idx];
  }

  deleteProfile(id) {
    const idx = this.profiles.findIndex(p => p.Id === id);
    if (idx === -1) return false;
    const name = this.profiles[idx].Name;
    this.profiles.splice(idx, 1);
    this.saveProfiles();
    this.logger.audit('BACKUP_PROFILE_DELETED', { targetType: 'backup', target: id, before: { Name: name } });
    return true;
  }

  getProfile(id) {
    return this.profiles.find(p => p.Id === id) || null;
  }

  getAllProfiles() {
    return [...this.profiles];
  }

  // ─── MySQL Driver Detection ───
  /** Kept for the Settings screen; the MySQL engine owns the search itself. */
  findMysqldump() {
    return engines.get('mysql').findTool(this.config);
  }

  setCustomPath(p) {
    if (p && fs.existsSync(p)) {
      this.config.setSetting('MysqldumpPath', p);
      this.config.save();
      this.mysqldumpPath = p;
      return true;
    }
    return false;
  }

  getStatus() {
    return {
      found: !!this.mysqldumpPath,
      path: this.mysqldumpPath,
      customPath: this.config.getSetting('MysqldumpPath', '')
    };
  }

  async downloadMysqldump(targetDir) {
    return new Promise((resolve) => {
      const url = 'https://dev.mysql.com/get/Downloads/MySQL-8.0/mysql-8.0.36-winx64.zip';
      const zipPath = path.join(targetDir, 'mysql-dump.zip');
      const extractDir = path.join(targetDir, 'mysql-dump');

      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

      this.logger.log('INFO', `Downloading MySQL tools from ${url}`);

      const cmd = `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath}'"`;
      exec(cmd, { timeout: 120000, windowsHide: true }, (error) => {
        if (error) {
          resolve({ success: false, message: `Download failed: ${error.message}` });
          return;
        }

        // Extract
        try {
          execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { timeout: 60000, windowsHide: true });

          // Find mysqldump.exe in extracted files
          const findCmd = process.platform === 'win32'
            ? `dir /s /b "${path.join(extractDir, 'mysqldump.exe')}"`
            : `find "${extractDir}" -name mysqldump`;

          try {
            const found = execSync(findCmd, { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
            const mysqldumpPath = found.split('\n')[0].trim();
            if (mysqldumpPath && fs.existsSync(mysqldumpPath)) {
              this.mysqldumpPath = mysqldumpPath;
              this.logger.log('INFO', `mysqldump found at: ${mysqldumpPath}`);
              resolve({ success: true, path: mysqldumpPath });
            } else {
              resolve({ success: false, message: 'mysqldump.exe not found in downloaded archive' });
            }
          } catch (e) {
            resolve({ success: false, message: 'Could not locate mysqldump in downloaded files' });
          }
        } catch (e) {
          resolve({ success: false, message: `Extraction failed: ${e.message}` });
        }
      });
    });
  }  // ─── History ───
  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        return JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      }
    } catch (e) {}
    return [];
  }

  saveHistory() {
    fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2), 'utf8');
  }

  addHistoryEntry(profileId, entry) {
    this.history.unshift({
      Id: crypto.randomUUID(),
      ProfileId: profileId,
      Timestamp: new Date().toISOString(),
      ...entry
    });
    // Keep last 500 entries
    if (this.history.length > 500) this.history = this.history.slice(0, 500);
    this.saveHistory();
  }

  getHistory(profileId) {
    if (profileId) return this.history.filter(h => h.ProfileId === profileId);
    return this.history;
  }

  getHistoryStats(profileId) {
    const entries = profileId ? this.history.filter(h => h.ProfileId === profileId) : this.history;
    const total = entries.length;
    const success = entries.filter(h => h.Status === 'Success').length;
    const failed = entries.filter(h => h.Status === 'Error' || h.Status === 'Partial').length;
    const lastRun = entries.length > 0 ? entries[0].Timestamp : null;
    return { total, success, failed, lastRun };
  }

  // ─── Backup Execution ───
  async executeBackup(profileId) {
    const profile = this.getProfile(profileId);
    if (!profile) return { success: false, message: 'Profile not found' };
    if (!this.mysqldumpPath) return { success: false, message: 'mysqldump not found. Install MySQL or configure the path.' };

    const startTime = Date.now();
    const results = [];

    // Ensure backup directory exists
    if (!fs.existsSync(profile.BackupPath)) {
      fs.mkdirSync(profile.BackupPath, { recursive: true });
    }

    const databases = profile.Databases.length > 0 ? profile.Databases : ['--all-databases'];

    // One step per database, plus upload when there are targets - so the
    // progress bar reflects the actual shape of the work.
    const runs = this.runs;
    const stepLabels = databases.map(db => (db === '--all-databases' ? 'Todos os bancos' : db));
    if (profile.UploadTargets && profile.UploadTargets.length) stepLabels.push('Enviando');
    const runId = runs ? runs.start({
      kind: 'backup', targetId: profileId, name: profile.Name, steps: stepLabels,
    }) : null;

    for (let dbIndex = 0; dbIndex < databases.length; dbIndex++) {
      const db = databases[dbIndex];
      if (runs && runId) runs.setStep(runId, dbIndex, db);
      try {
        const result = await this.backupDatabase(profile, db);
        results.push(result);
        if (runs && runId) {
          if (result.success) {
            runs.appendOutput(runId, `${db}: ${result.sizeHuman || 'concluído'}`, 'stdout');
          } else {
            runs.appendOutput(runId, `${db}: ${result.message || 'falhou'}`, 'stderr');
            runs.failStep(runId, dbIndex, result.message);
          }
        }

        if (result.success && profile.UploadTargets.length > 0) {
          if (runs && runId) runs.setStep(runId, databases.length, 'upload');
          for (const target of profile.UploadTargets) {
            const uploadResult = await this.uploadFile(result.filePath, target, profile);
            result.uploads = result.uploads || [];
            result.uploads.push(uploadResult);
          }

          // Remove local file if KeepLocal is false
          if (!profile.KeepLocal && result.filePath && fs.existsSync(result.filePath)) {
            try { fs.unlinkSync(result.filePath); } catch (e) {}
          }
        }
      } catch (e) {
        results.push({ success: false, database: db, message: e.message });
        if (runs && runId) {
          runs.appendOutput(runId, `${db}: ${e.message}`, 'stderr');
          runs.failStep(runId, dbIndex, e.message);
        }
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
    const success = results.every(r => r.success);
    const totalSize = results.filter(r => r.success && r.size).reduce((sum, r) => sum + r.size, 0);

    // Update profile last run
    this.updateProfile({
      Id: profileId,
      LastRun: new Date().toISOString(),
      LastStatus: success ? 'Success' : 'Partial'
    });

    // Write detailed log file
    let logPath = '';
    try {
      const logsDir = path.join(this.config.configDir, 'backup-logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const logFile = `backup-${profileId.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
      logPath = path.join(logsDir, logFile);
      const logContent = [
        `=== Backup: ${profile.Name} ===`,
        `Time: ${new Date().toISOString()}`,
        `Status: ${success ? 'Success' : 'Error'}`,
        `Duration: ${duration}`,
        `Databases: ${databases.join(', ')}`,
        `---`,
        ...results.map(r => [
          `--- ${r.database} ---`,
          `Status: ${r.success ? 'OK' : 'FAIL'}`,
          `Size: ${r.sizeHuman || '0 B'}`,
          r.message ? `Message: ${r.message}` : '',
          r.stdout ? `Stdout:\n${r.stdout}` : '',
          r.stderr ? `Stderr:\n${r.stderr}` : '',
          r.uploads ? r.uploads.map(u => `Upload ${u.type}: ${u.success ? 'OK' : 'FAIL'} ${u.message || ''}`).join('\n') : ''
        ].filter(Boolean).join('\n'))
      ].join('\n');
      fs.writeFileSync(logPath, logContent, 'utf8');
    } catch (e) { /* log file is best-effort */ }

    // Log history
    this.addHistoryEntry(profileId, {
      ProfileName: profile.Name,
      Status: success ? 'Success' : (results.some(r => r.success) ? 'Partial' : 'Error'),
      Duration: duration,
      Databases: databases.map(db => db === '--all-databases' ? 'all' : db),
      DatabasesCount: databases.length,
      TotalSize: totalSize,
      TotalSizeHuman: this.formatSize(totalSize),
      LogPath: logPath,
      Results: results.map(r => ({
        database: r.database,
        success: r.success,
        size: r.size || 0,
        sizeHuman: r.sizeHuman || '0 B',
        message: r.message || '',
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        uploads: r.uploads || []
      }))
    });

    this.logger.audit('BACKUP_EXECUTED', {
      targetType: 'backup', target: profileId,
      after: { profile: profile.Name, databases: databases.length, success, duration }
    });

    if (runs && runId) {
      runs.finish(runId, {
        success,
        message: success ? `${databases.length} banco(s) em ${duration}` : 'Um ou mais bancos falharam',
      });
    }

    return { success, duration, results };
  }

  /**
   * Write a short-lived MySQL defaults file holding the connection details.
   * Written as UTF-8 because mysqldump reads the file as raw bytes - that is
   * what makes a non-ASCII password survive intact.
   */
  // One implementation, owned by the MySQL engine. Kept here as a thin
  // delegate because the credential tests and older callers use these names.
  _writeCredentialsFile(profile) {
    return engines.get('mysql').writeCredentialsFile(profile);
  }

  _removeCredentialsFile(file) {
    return engines.get('mysql').removeCredentialsFile(file);
  }

  _sweepStaleCredentialFiles() {
    return engines.get('mysql').sweepStaleCredentialFiles();
  }

  async backupDatabase(profile, database) {
    const engine = engines.forProfile(profile);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');

    const filename = (profile.NamingPattern || '{database}_{date}_{time}')
      .replace(/{database}/g, database === '--all-databases' ? 'all_databases' : database)
      .replace(/{date}/g, dateStr)
      .replace(/{time}/g, timeStr)
      .replace(/{timestamp}/g, now.getTime().toString());

    // The extension comes from the engine (and, for SQL Server, the chosen
    // format), not from a hard-coded '.sql'.
    const dumpExt = engines.extensionFor(profile);
    let finalExt = dumpExt;
    if (profile.Compression === 'zip') finalExt = dumpExt + '.zip';
    else if (profile.Compression === '7z') finalExt = dumpExt + '.7z';

    const dumpPath = path.join(profile.BackupPath, filename + dumpExt);
    const finalPath = path.join(profile.BackupPath, filename + finalExt);

    this.logger.log('INFO', `Backing up ${engine.label} database: ${database}`);

    const result = await engine.backup(profile, database, dumpPath, {
      config: this.config,
      toolPath: engine.id === 'mysql' ? this.mysqldumpPath : undefined,
    });

    if (!result.success) {
      this.logger.log('ERROR', `Backup failed for ${database}: ${String(result.message).substring(0, 500)}`);
      return {
        success: false, database,
        message: String(result.message || '').substring(0, 2000),
        stdout: result.stdout || '', stderr: result.stderr || '',
      };
    }

    // SQL Server native backups are written on the database host. When that is
    // not this machine there is no local file to compress or upload, and
    // pretending otherwise would produce a confusing failure.
    if (result.remoteOnly || !fs.existsSync(dumpPath)) {
      if (engines.writesOnServer(profile)) {
        return {
          success: true, database, filePath: dumpPath, remoteOnly: true,
          size: 0, sizeHuman: 'no servidor',
          message: result.message || 'Backup gravado no host do banco de dados',
          stdout: result.stdout || '', stderr: result.stderr || '',
        };
      }
      return { success: false, database, message: 'O backup terminou sem erro, mas o arquivo não foi criado.', stdout: result.stdout || '', stderr: result.stderr || '' };
    }

    // Compress
    if (profile.Compression && profile.Compression !== 'none' && fs.existsSync(dumpPath)) {
      try {
        await this.compressFile(dumpPath, finalPath, profile.Compression, profile.CompressionLevel);
        try { fs.unlinkSync(dumpPath); } catch (e) {}
      } catch (e) {
        return { success: false, database, message: `Compression failed: ${e.message}` };
      }
    }

    const filePath = (profile.Compression && profile.Compression !== 'none') ? finalPath : dumpPath;
    const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

    return {
      success: true, database, filePath,
      size: stats ? stats.size : 0,
      sizeHuman: this.formatSize(stats ? stats.size : 0),
      message: 'Completed',
      stdout: result.stdout || '', stderr: result.stderr || '',
    };
  }

  async compressFile(inputPath, outputPath, method, level) {
    return new Promise((resolve, reject) => {
      if (method === 'zip') {
        const has7z = this.find7z();
        if (has7z) {
          const args = ['a', '-tzip', `-mx=${level}`, outputPath, inputPath];
          const { execFile } = require('child_process');
          execFile(has7z, args, { timeout: 300000, windowsHide: true }, (err) => {
            if (err && err.code !== 0) reject(err); else resolve();
          });
        } else {
          const cmd = `powershell -NoProfile -Command "Compress-Archive -Path '${inputPath}' -DestinationPath '${outputPath}' -CompressionLevel Optimal"`;
          exec(cmd, { timeout: 300000, windowsHide: true }, (err) => {
            if (err) reject(err); else resolve();
          });
        }
      } else if (method === '7z') {
        const has7z = this.find7z();
        if (has7z) {
          const args = ['a', '-t7z', `-mx=${level}`, outputPath, inputPath];
          this.logger.log('INFO', `Compressing: ${path.basename(inputPath)} with 7z (level ${level})`);
          const { execFile } = require('child_process');
          execFile(has7z, args, { timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
            if (err && err.code !== 0) {
              this.logger.log('ERROR', `7z compression failed: ${err.message}`);
              reject(err);
            } else {
              this.logger.log('INFO', `7z compression OK: ${path.basename(outputPath)}`);
              resolve();
            }
          });
        } else {
          reject(new Error('7z not found. Install 7-Zip or use zip compression.'));
        }
      } else {
        resolve();
      }
    });
  }

  find7z() {
    // Check user-configured path first
    const customPath = this.config.getSetting('7zPath', '');
    if (customPath && fs.existsSync(customPath)) return customPath;

    const candidates = [
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe',
      'C:\\7-Zip\\7z.exe',
      'C:\\tools\\7z\\7z.exe',
      process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, '7-Zip', '7z.exe') : '',
      process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], '7-Zip', '7z.exe') : '',
      '/usr/bin/7z',
      '/usr/local/bin/7z'
    ].filter(Boolean);

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    try {
      const result = execSync('where 7z 2>nul', { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
      if (result) {
        const firstLine = result.split('\n')[0].trim();
        if (fs.existsSync(firstLine)) return firstLine;
      }
    } catch (e) {}

    // Also scan Chocolatey
    try {
      const chocoBin = path.join(process.env.CHOCOLATEYINSTALL || 'C:\\ProgramData\\chocolatey', 'bin', '7z.exe');
      if (fs.existsSync(chocoBin)) return chocoBin;
    } catch (e) {}

    // Scan PATH via PowerShell
    try {
      const psResult = execSync('powershell -NoProfile -Command "(Get-Command 7z -ErrorAction SilentlyContinue).Source"', { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
      if (psResult && fs.existsSync(psResult)) return psResult;
    } catch (e) {}

    return null;
  }

  // ─── Upload ───
  async uploadFile(filePath, target, profile) {
    switch (target.type) {
      case 'ftp': return this.uploadFTP(filePath, target);
      case 'sftp': return this.uploadSFTP(filePath, target);
      case 'smb':
      case 'nas':
      case 'network': return this.uploadSMB(filePath, target);
      default: return { success: false, message: `Unknown upload type: ${target.type}` };
    }
  }

  async uploadFTP(filePath, target) {
    return new Promise((resolve) => {
      const filename = path.basename(filePath);
      const remotePath = target.path ? `${target.path}/${filename}` : filename;
      const port = target.port || 21;
      const ftpUrl = target.url || `ftp://${target.host}:${port}`;

      // Use PowerShell FTP
      const cmd = `powershell -NoProfile -Command "
        $ftp = New-Object System.Net.FtpWebRequest('${ftpUrl}/${remotePath}');
        $ftp.Method = [System.Net.WebRequestMethods+Ftp]::UploadFile;
        $ftp.Credentials = New-Object System.Net.NetworkCredential('${target.user || ''}', '${target.password || ''}');
        $ftp.UseBinary = $true;
        $ftp.ContentLength = (Get-Item '${filePath}').Length;
        $reader = [System.IO.File]::OpenRead('${filePath}');
        $buffer = New-Object byte[] 4096;
        $stream = $ftp.GetRequestStream();
        $count = $reader.Read($buffer, 0, $buffer.Length);
        while ($count -gt 0) { $stream.Write($buffer, 0, $count); $count = $reader.Read($buffer, 0, $buffer.Length) }
        $stream.Close(); $reader.Close();
        Write-Output 'OK';
      "`;

      exec(cmd, { timeout: 600000, windowsHide: true }, (error, stdout) => {
        if (error) {
          this.logger.log('ERROR', `FTP upload failed: ${error.message}`);
          resolve({ success: false, type: 'ftp', message: error.message });
        } else {
          this.logger.log('INFO', `FTP upload OK: ${filename} → ${target.url}`);
          resolve({ success: true, type: 'ftp', remotePath });
        }
      });
    });
  }

  async uploadSFTP(filePath, target) {
    const Client = require('ssh2-sftp-client');
    const sftp = new Client();
    const filename = path.basename(filePath);
    const remotePath = target.path ? `${target.path}/${filename}` : `/${filename}`;
    try {
      this.logger.log('INFO', `SFTP connecting to ${target.host}:${target.port || 22} as ${target.user}`);
      await sftp.connect({
        host: target.host,
        port: parseInt(target.port) || 22,
        username: target.user,
        password: target.password,
        readyTimeout: 15000,
        algorithms: { kex: ['ecdh-sha2-nistp256','ecdh-sha2-nistp384','ecdh-sha2-nistp521','diffie-hellman-group-exchange-sha256','diffie-hellman-group14-sha256','diffie-hellman-group14-sha1'] }
      });
      this.logger.log('INFO', `SFTP connected, ensuring remote directory exists: ${target.path || '/'}`);
      // Ensure remote directory exists
      if (target.path) {
        await sftp.mkdir(target.path, true);
      }
      this.logger.log('INFO', `SFTP uploading ${filePath} -> ${remotePath}`);
      await sftp.put(filePath, remotePath);
      const stat = await sftp.stat(remotePath);
      this.logger.log('INFO', `SFTP upload OK: ${filename} (${stat.size} bytes)`);
      await sftp.end();
      return { success: true, type: 'sftp', remotePath };
    } catch (err) {
      this.logger.log('ERROR', `SFTP upload failed: ${err.message}`);
      try { await sftp.end(); } catch(e) {}
      return { success: false, type: 'sftp', message: err.message };
    }
  }

  async uploadSMB(filePath, target) {
    return new Promise((resolve) => {
      const filename = path.basename(filePath);
      const networkPath = target.path || target.url; // \\server\share\folder
      const destPath = networkPath + (networkPath.endsWith('\\') ? '' : '\\') + filename;
      const host = target.host || '';
      const user = target.user || '';
      const pass = target.password || '';

      // If auth provided, use net use first
      if (user && host) {
        const netUse = `net use "\\${host}" "${pass}" /user:"${user}" /persistent:no`;
        exec(netUse, { timeout: 30000, windowsHide: true }, (err) => {
          if (err && !err.message?.includes('already')) {
            this.logger.log('ERROR', `SMB auth failed for ${host}: ${err.message}`);
            resolve({ success: false, type: 'smb', message: `Authentication failed: ${err.message}` });
            return;
          }
          this._smbCopy(filePath, destPath, networkPath, host, resolve);
        });
      } else {
        this._smbCopy(filePath, destPath, networkPath, host, resolve);
      }
    });
  }

  _smbCopy(filePath, destPath, networkPath, host, resolve) {
    // Use robocopy for reliable network copies (handles retries, long paths)
    const dir = path.dirname(destPath);
    const robocopy = `robocopy "${path.dirname(filePath)}" "${dir}" "${path.basename(filePath)}" /R:2 /W:3 /NP /NFL /NDL /NJH /NJS`;
    exec(robocopy, { timeout: 600000, windowsHide: true }, (error) => {
      // robocopy returns non-zero for certain conditions that aren't errors
      const exitCode = error ? error.code : 0;
      const isRealError = exitCode > 7;
      if (isRealError) {
        // Fallback to xcopy
        const xcopy = `echo F| xcopy "${filePath}" "${destPath}" /Y /Q`;
        exec(xcopy, { timeout: 600000, windowsHide: true }, (err2) => {
          if (err2) {
            this.logger.log('ERROR', `SMB copy failed: ${err2.message}`);
            resolve({ success: false, type: 'smb', message: err2.message });
          } else {
            this.logger.log('INFO', `SMB copy OK (xcopy): ${path.basename(filePath)} → ${networkPath}`);
            resolve({ success: true, type: 'smb', remotePath: destPath });
          }
        });
      } else {
        this.logger.log('INFO', `SMB copy OK: ${path.basename(filePath)} → ${networkPath}`);
        resolve({ success: true, type: 'smb', remotePath: destPath });
      }
    });
  }

  // ─── Cleanup ───
  cleanupOldBackups(profile) {
    if (!profile.KeepDays || profile.KeepDays <= 0) return 0;
    const cutoff = new Date(Date.now() - profile.KeepDays * 86400000);
    let removed = 0;
    try {
      const files = fs.readdirSync(profile.BackupPath);
      for (const file of files) {
        if (file.startsWith(path.basename(profile.NamingPattern).split('{')[0])) {
          const fp = path.join(profile.BackupPath, file);
          const stat = fs.statSync(fp);
          if (stat.mtime < cutoff) {
            fs.unlinkSync(fp);
            removed++;
          }
        }
      }
    } catch (e) {}
    return removed;
  }

  // ─── Test Connection (uses mysql2 driver, not mysqldump) ───
  /**
   * Test a connection. Accepts either a profile object or the older
   * (host, port, user, password) argument list, so existing callers keep
   * working while new ones can pass an engine.
   */
  testConnection(hostOrProfile, port, user, password) {
    const profile = this._asProfile(hostOrProfile, port, user, password);
    const engine = engines.forProfile(profile);
    return Promise.resolve(engine.testConnection(profile));
  }

  listDatabases(hostOrProfile, port, user, password) {
    const profile = this._asProfile(hostOrProfile, port, user, password);
    const engine = engines.forProfile(profile);
    if (!engine.capabilities.listDatabases) {
      return Promise.resolve({ success: false, databases: [], message: `${engine.label} does not support listing databases` });
    }
    return Promise.resolve(engine.listDatabases(profile));
  }

  /** Normalise the two calling conventions into one profile shape. */
  _asProfile(hostOrProfile, port, user, password) {
    if (hostOrProfile && typeof hostOrProfile === 'object') {
      return Object.assign({ Engine: engines.DEFAULT_ENGINE }, hostOrProfile);
    }
    return {
      Engine: engines.DEFAULT_ENGINE,
      Host: hostOrProfile || 'localhost',
      Port: parseInt(port, 10) || 3306,
      User: user || 'root',
      Password: password || '',
    };
  }

  _cleanMysqlError(raw) {
    if (!raw) return 'Unknown error';
    // Remove SQL query fragments (lines starting with SELECT, SHOW, etc.)
    let msg = raw.split('\n')
      .filter(l => !/^(SELECT|SHOW|INSERT|CREATE|DROP|ALTER|USE|LOCK|UNLOCK)\s/i.test(l.trim()))
      .join('\n').trim();
    // Remove lines that look like SQL (contain semicolons in odd places)
    msg = msg.split('\n').filter(l => !l.includes('-- ') || l.includes('error') || l.includes('Error')).join('\n').trim();
    // Extract just the error part if mysqldump format: 'mysqldump: Got error: ...'
    const errMatch = msg.match(/(Error:\s*.+?)(?:\n|$)/i) || msg.match(/(Access denied.+?)(?:\n|$)/i) || msg.match(/(Can't connect.+?)(?:\n|$)/i);
    if (errMatch) return errMatch[1].trim();
    // Fallback: return first meaningful line
    const firstLine = msg.split('\n').find(l => l.trim().length > 0) || msg;
    return firstLine.substring(0, 200);
  }

  // ─── SMB Test Connection ───
  testSmbConnection(target) {
    return new Promise((resolve) => {
      const host = target.host || '';
      const user = target.user || '';
      const pass = target.password || '';
      const smbPath = target.path || `\\\\${host}`;

      // If auth provided, try net use first
      if (user && host) {
        const netUse = `net use "\\${host}" "${pass}" /user:"${user}" /persistent:no`;
        exec(netUse, { timeout: 15000, windowsHide: true }, (err) => {
          if (err && !err.message?.includes('already')) {
            resolve({ success: false, message: `Authentication failed: ${err.message}` });
            return;
          }
          // Try to list the path
          this._testSmbPath(smbPath, resolve);
        });
      } else {
        // Try anonymous access
        this._testSmbPath(smbPath, resolve);
      }
    });
  }

  _testSmbPath(smbPath, resolve) {
    // Try dir on the UNC path
    const cmd = `dir "${smbPath}" /B 2>&1`;
    exec(cmd, { timeout: 15000, windowsHide: true }, (error, stdout) => {
      if (error && error.code !== 0) {
        // Try PowerShell
        const psCmd = `powershell -NoProfile -Command "Test-Path '${smbPath}'"`;
        exec(psCmd, { timeout: 15000, windowsHide: true }, (err2, out2) => {
          if (err2) {
            resolve({ success: false, message: `Cannot access: ${err2.message}` });
          } else if (out2.trim() === 'True') {
            resolve({ success: true, message: 'Path accessible' });
          } else {
            resolve({ success: false, message: 'Path not found or inaccessible' });
          }
        });
      } else {
        resolve({ success: true, message: 'Path accessible' });
      }
    });
  }

  // ─── NSSM Wrapper Generation ───
  generateBackupWrapper(profile) {
    const cronExpr = profile.CronExpression || '0 2 * * *';

    const cronParts = cronExpr.trim().split(/\s+/);
    const cronMinute = cronParts[0] || '0';
    const cronHour = cronParts[1] || '*';
    const cronDay = cronParts[2] || '*';
    const cronMonth = cronParts[3] || '*';
    const cronDow = cronParts[4] || '*';

    // Save profile config as JSON so the wrapper reads it at runtime
    // (avoids PowerShell 5.1 Unicode encoding issues when embedding paths)
    const configJson = {
      Name: profile.Name || 'Backup',
      Host: profile.Host || 'localhost',
      Port: profile.Port || 3306,
      User: profile.User || 'root',
      Password: profile.Password || '',
      MysqldumpPath: this.mysqldumpPath || 'mysqldump',
      BackupPath: profile.BackupPath || 'C:\\Backups',
      NamingPattern: profile.NamingPattern || '{database}_{date}_{time}',
      Compression: profile.Compression || 'none',
      CompressionLevel: profile.CompressionLevel || 5,
      ExtraArgs: profile.ExtraArgs || '',
      Databases: profile.Databases && profile.Databases.length > 0 ? profile.Databases : []
    };
    // Write JSON config next to the wrapper
    const profileId = profile.Id;
    const wrapperDir = this.wrappersDir;
    // The caller (main.js deploy handler) will write this JSON file
    // We store it on the instance so main.js can access it
    this._lastGeneratedConfig = { profileId, configJson };

    const wrapper = [
      '# ============================================================',
      '# Kyrios Chronos - Backup NSSM Wrapper',
      '# Profile: ' + (profile.Name || 'Backup'),
      '# Cron: ' + cronExpr,
      '# Generated: ' + new Date().toISOString(),
      '# ============================================================',
      '',
      '$ErrorActionPreference = "Continue"',
      '$OutputEncoding = [System.Text.Encoding]::UTF8',
      '',
      '# --- Load config from JSON (handles Unicode paths) ---',
      '$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path',
      '$ConfigPath = Join-Path $ScriptDir ("backup-profile-" + "' + profileId + '" + ".json")',
      'if (Test-Path $ConfigPath) {',
      '    $cfg = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json',
      '} else {',
      '    Write-Host "Config not found: $ConfigPath"',
      '    exit 1',
      '}',
      '',
      '$ProfileName = $cfg.Name',
      '$MysqldumpPath = $cfg.MysqldumpPath',
      '$Host_ = $cfg.Host',
      '$Port = $cfg.Port',
      '$User = $cfg.User',
      '$Password = $cfg.Password',
      '$BackupPath = $cfg.BackupPath',
      '$NamingPattern = $cfg.NamingPattern',
      '$Compress = $cfg.Compression',
      '$CompressLevel = $cfg.CompressionLevel',
      '$Databases = @($cfg.Databases)',
      '$LogFile = Join-Path $ScriptDir ("backup-" + $ProfileName + ".log")',
      '',
      '# Extra args (split into array)',
      'if ($cfg.ExtraArgs) {',
      '    $ExtraArgs = $cfg.ExtraArgs.Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)',
      '} else {',
      '    $ExtraArgs = @()',
      '}',
      '',
      '# Cron fields',
      '$CronMinute = "' + cronMinute + '"',
      '$CronHour = "' + cronHour + '"',
      '$CronDay = "' + cronDay + '"',
      '$CronMonth = "' + cronMonth + '"',
      '$CronDow = "' + cronDow + '"',
      '',
      '# --- Logging ---',
      'function Write-BackupLog {',
      '    param([string]$Level, [string]$Message)',
      '    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
      '    $entry = "[$timestamp] [$Level] $Message"',
      '    try { Add-Content -Path $LogFile -Value $entry -ErrorAction SilentlyContinue } catch {}',
      '}',
      '',
      '# --- Cron Matching ---',
      'function Test-CronMatch {',
      '    param([string]$Field, [int]$CurrentValue)',
      '    if ($Field -eq "*") { return $true }',
      '    if ($Field -match "^\\*/(\\d+)$") {',
      '        $step = [int]$Matches[1]',
      '        if ($step -eq 0) { return $false }',
      '        return ($CurrentValue % $step -eq 0)',
      '    }',
      '    if ($Field -match "^(\\d+)-(\\d+)$") {',
      '        return ($CurrentValue -ge [int]$Matches[1] -and $CurrentValue -le [int]$Matches[2])',
      '    }',
      '    if ($Field -match ",") {',
      '        $values = $Field -split "," | ForEach-Object { [int]$_.Trim() }',
      '        return ($values -contains $CurrentValue)',
      '    }',
      '    try { return ($CurrentValue -eq [int]$Field) } catch { return $false }',
      '}',
      '',
      'function Test-ShouldRun {',
      '    $now = Get-Date',
      '    $result = $true',
      '    $result = $result -and (Test-CronMatch -Field $CronMinute -CurrentValue $now.Minute)',
      '    $result = $result -and (Test-CronMatch -Field $CronHour -CurrentValue $now.Hour)',
      '    $result = $result -and (Test-CronMatch -Field $CronDay -CurrentValue $now.Day)',
      '    $result = $result -and (Test-CronMatch -Field $CronMonth -CurrentValue $now.Month)',
      '    $dow = [int]$now.DayOfWeek',
      '    $result = $result -and (Test-CronMatch -Field $CronDow -CurrentValue $dow)',
      '    return $result',
      '}',
      '',
      '# --- Run Backup ---',
      'function Invoke-Backup {',
      '    $startTime = Get-Date',
      '    Write-BackupLog "INFO" "=== Starting backup: $ProfileName ==="',
      '    Write-BackupLog "INFO" ("Host: ${Host_}:${Port}  User: ${User}  Compress: ${Compress} L${CompressLevel}")',
      '',
      '    if (-not (Test-Path $BackupPath)) {',
      '        New-Item -ItemType Directory -Path $BackupPath -Force | Out-Null',
      '    }',
      '',
      '    # Determine databases to backup',
      '    if ($Databases.Count -eq 0) { $dbList = @("--all-databases") } else { $dbList = $Databases }',
      '',
      '    $successCount = 0',
      '    $failCount = 0',
      '    $totalSize = 0',
      '',
      '    foreach ($db in $dbList) {',
      '        $dbStart = Get-Date',
      '        $dateStr = Get-Date -Format "yyyyMMdd"',
      '        $timeStr = Get-Date -Format "HHmmss"',
      '        $safeName = $db.Replace("--all-databases", "all_databases")',
      '        $filename = $NamingPattern.Replace("{database}", $safeName).Replace("{date}", $dateStr).Replace("{time}", $timeStr)',
      '        $ext = ".sql"',
      '        $dumpPath = Join-Path $BackupPath ($filename + $ext)',
      '',
      '        # Credentials go in a UTF-8 defaults file, never on the command',
      '        # line: mysqldump converts a --password argument through the ANSI',
      '        # code page on Windows, which corrupts any non-ASCII password and',
      '        # returns "1045 Access denied" for a perfectly valid one.',
      '        $credFile = Join-Path $env:TEMP ("kyrios-cred-" + [guid]::NewGuid().ToString("N") + ".cnf")',
      '        $credLines = @()',
      '        $credLines += "[client]"',
      '        $credLines += "host=" + $Host_',
      '        $credLines += "port=" + $Port',
      '        $credLines += "user=" + $User',
      '        $credLines += "password=" + $Password',
      '        [System.IO.File]::WriteAllLines($credFile, $credLines, (New-Object System.Text.UTF8Encoding $false))',
      '',
      '        # Build mysqldump args (--defaults-file must come first)',
      '        $mArgs = @()',
      '        $mArgs += "--defaults-file=\"" + $credFile + "\""',
      '        foreach ($ea in $ExtraArgs) { if ($ea) { $mArgs += $ea } }',
      '        $mArgs += "--result-file=\"" + $dumpPath + "\""',
      '        if ($db -eq "--all-databases") {',
      '            $mArgs += "--all-databases"',
      '        } else {',
      '            $mArgs += "--databases"',
      '            $mArgs += $db',
      '        }',
      '',
      '        Write-BackupLog "INFO" "Dumping: $db -> $filename"',
      '',
      '        try {',
      '            $pinfo = New-Object System.Diagnostics.ProcessStartInfo',
      '            $pinfo.FileName = $MysqldumpPath',
      '            $pinfo.Arguments = $mArgs -join " "',
      '            $pinfo.UseShellExecute = $false',
      '            $pinfo.RedirectStandardOutput = $true',
      '            $pinfo.RedirectStandardError = $true',
      '            $pinfo.CreateNoWindow = $true',
      '',
      '            $proc = [System.Diagnostics.Process]::Start($pinfo)',
      '            $stdoutTask = $proc.StandardOutput.ReadToEndAsync()',
      '            $stderrTask = $proc.StandardError.ReadToEndAsync()',
      '            $proc.WaitForExit()',
      '',
      '            $stdout = $stdoutTask.Result',
      '            $stderr = $stderrTask.Result',
      '            $dbDuration = ((Get-Date) - $dbStart).TotalSeconds',
      '',
      '            # The credentials file has served its purpose - remove it.',
      '            Remove-Item $credFile -Force -ErrorAction SilentlyContinue',
      '',
      '            if ($proc.ExitCode -eq 0 -and (Test-Path $dumpPath)) {',
      '                $fileSize = (Get-Item $dumpPath).Length',
      '                $totalSize += $fileSize',
      '',
      '                # Compress',
      '                $finalPath = $dumpPath',
      '                if ($Compress -eq "zip") {',
      '                    $zipPath = $dumpPath + ".zip"',
      '                    Compress-Archive -Path $dumpPath -DestinationPath $zipPath -CompressionLevel Optimal -ErrorAction SilentlyContinue',
      '                    if (Test-Path $zipPath) { $finalPath = $zipPath; Remove-Item $dumpPath -Force }',
      '                } elseif ($Compress -eq "7z") {',
      '                    $7zPath = $null',
      '                    $7zCandidates = @("C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe")',
      '                    foreach ($c in $7zCandidates) { if (Test-Path $c) { $7zPath = $c; break } }',
      '                    if ($7zPath) {',
      '                        $7zOut = $dumpPath + ".7z"',
      '                        & $7zPath a -t7z -mx=$CompressLevel $7zOut $dumpPath 2>$null',
      '                        if (Test-Path $7zOut) { $finalPath = $7zOut; Remove-Item $dumpPath -Force }',
      '                    }',
      '                }',
      '',
      '                $finalSize = (Get-Item $finalPath).Length',
      '                Write-BackupLog "INFO" "OK: $db - $([math]::Round($finalSize/1MB, 1)) MB in ${dbDuration}s"',
      '                $successCount++',
      '            } else {',
      '                Write-BackupLog "ERROR" "FAILED: $db (exit $($proc.ExitCode)) in ${dbDuration}s"',
      '                if ($stderr -and $stderr.Trim().Length -gt 0) {',
      '                    $truncated = if ($stderr.Length -gt 500) { $stderr.Substring(0, 500) + "..." } else { $stderr }',
      '                    Write-BackupLog "ERROR" "stderr: $truncated"',
      '                }',
      '                $failCount++',
      '            }',
      '        } catch {',
      '            Write-BackupLog "ERROR" ("Exception for ${db}: $($_.Exception.Message)")',
      '            $failCount++',
      '        }',
      '    }',
      '',
      '    $totalDuration = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)',
      '    $totalSizeMB = [math]::Round($totalSize / 1MB, 1)',
      '    Write-BackupLog "INFO" ("=== Backup finished: {0} ok, {1} failed, {2} MB, {3}s ===" -f $successCount, $failCount, $totalSizeMB, $totalDuration)',
      '}',
      '',
      '# ============================================================',
      '# MAIN SERVICE LOOP',
      '# NSSM keeps this process alive. We check the cron schedule',
      '# every 15 seconds and run backup when due.',
      '# ============================================================',
      '# Ensure log directory exists',
      '$logDir = [System.IO.Path]::GetDirectoryName($LogFile)',
      'if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }',
      '',
      'Write-BackupLog "INFO" "========================================="',
      'Write-BackupLog "INFO" ("NSSM Backup Service STARTED: $ProfileName")',
      'Write-BackupLog "INFO" ("PID: " + $PID)',
      'Write-BackupLog "INFO" ("Cron: $CronMinute $CronHour $CronDay $CronMonth $CronDow")',
      'Write-BackupLog "INFO" ("Databases: " + ($Databases -join ", "))',
      'Write-BackupLog "INFO" "Mode: NSSM Service (wrapper stays alive)"',
      'Write-BackupLog "INFO" "========================================="',
      '',
      '$lastRunMinute = -1',
      '$checkCount = 0',
      '$checkInterval = 15',
      '',
      'try {',
      '    while ($true) {',
      '        $checkCount++',
      '        $now = Get-Date',
      '',
      '        # Only match once per minute to avoid double-runs',
      '        if ($now.Minute -ne $lastRunMinute) {',
      '            if (Test-ShouldRun) {',
      '                Write-BackupLog "INFO" ("Cron matched at " + $now.ToString("HH:mm:ss") + " -- running backup...")',
      '                Invoke-Backup',
      '                $lastRunMinute = $now.Minute',
      '            }',
      '        }',
      '',
      '        Start-Sleep -Seconds $checkInterval',
      '    }',
      '} catch {',
      '    Write-BackupLog "ERROR" ("Main loop crashed: " + $_.Exception.Message)',
      '    Write-BackupLog "ERROR" ("Stack: " + $_.ScriptStackTrace)',
      '} finally {',
      '    Write-BackupLog "INFO" ("NSSM Backup Service STOPPED: $ProfileName (PID: " + $PID + ", ran $checkCount checks)")',
      '}',
    ].join('\r\n');

    return wrapper;
  }

  // ─── Export/Import Profiles ───
  exportProfile(id, filePath) {
    const profile = this.getProfile(id);
    if (!profile) return { success: false, message: 'Profile not found' };
    const exportData = { ...profile, Password: '***' }; // Mask password
    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2), 'utf8');
    return { success: true };
  }

  importProfile(filePath) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      data.Id = crypto.randomUUID();
      data.Name = data.Name + ' (imported)';
      data.CreatedAt = new Date().toISOString();
      data.UpdatedAt = new Date().toISOString();
      this.profiles.push(data);
      this.saveProfiles();
      return { success: true, profile: data };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(1) + ' GB';
  }
}

module.exports = BackupManager;
