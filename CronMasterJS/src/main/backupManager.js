// backupManager.js - MySQL Backup Manager
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class BackupManager {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.profilesFile = path.join(config.configDir, 'backup-profiles.json');
    this.profiles = this.loadProfiles();
    this.mysqldumpPath = this.findMysqldump();
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
      BackupPath: data.BackupPath || path.join(process.env.USERPROFILE || '', 'CronMasterBackups'),
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
  findMysqldump() {
    // Check user-configured path first
    const customPath = this.config.getSetting('MysqldumpPath', '');
    if (customPath && fs.existsSync(customPath)) return customPath;

    const candidates = [
      // MySQL Server (various versions)
      'C:\\Program Files\\MySQL\\MySQL Server 9.0\\bin\\mysqldump.exe',
      'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqldump.exe',
      'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
      'C:\\Program Files\\MySQL\\MySQL Server 5.7\\bin\\mysqldump.exe',
      'C:\\Program Files\\MySQL\\MySQL Server 5.6\\bin\\mysqldump.exe',
      'C:\\Program Files (x86)\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
      // MariaDB
      'C:\\Program Files\\MariaDB 11.0\\bin\\mysqldump.exe',
      'C:\\Program Files\\MariaDB 10.6\\bin\\mysqldump.exe',
      'C:\\Program Files\\MariaDB 10.5\\bin\\mysqldump.exe',
      'C:\\Program Files\\MariaDB 10.4\\bin\\mysqldump.exe',
      'C:\\Program Files (x86)\\MariaDB 10.4\\bin\\mysqldump.exe',
      // XAMPP
      'C:\\xampp\\mysql\\bin\\mysqldump.exe',
      // WampServer
      'C:\\wamp64\\bin\\mysql\\mysql8.0.31\\bin\\mysqldump.exe',
      'C:\\wamp64\\bin\\mysql\\mysql8.2.0\\bin\\mysqldump.exe',
      'C:\\wamp64\\bin\\mysql\\mariadb-10.6.12\\bin\\mysqldump.exe',
      'C:\\wamp\\bin\\mysql\\mysql8.0.31\\bin\\mysqldump.exe',
      // Laragon
      'C:\\laragon\\bin\\mysql\\mysql-8.0.30\\bin\\mysqldump.exe',
      'C:\\laragon\\bin\\mysql\\mariadb-10.6.9\\bin\\mysqldump.exe',
      // Docker Desktop volumes
      'C:\\ProgramData\\DockerDesktop\\version-bin\\mysqldump.exe',
      // Chocolatey
      'C:\\ProgramData\\chocolatey\\bin\\mysqldump.exe',
      'C:\\tools\\mysql\\bin\\mysqldump.exe',
      'C:\\tools\\mysql\\mysql-8.0.36\\bin\\mysqldump.exe',
      'C:\\tools\\mysql\\mysql-8.4.0\\bin\\mysqldump.exe',
      // Standalone installer paths
      'C:\\MySQL\\bin\\mysqldump.exe',
      'C:\\mysql\\bin\\mysqldump.exe',
      // Linux/Mac
      '/usr/bin/mysqldump',
      '/usr/local/bin/mysqldump',
      '/usr/local/mysql/bin/mysqldump',
      '/opt/homebrew/bin/mysqldump',
      '/opt/homebrew/opt/mysql-client/bin/mysqldump',
      '/snap/bin/mysqldump'
    ];

    // Check PATH first
    try {
      const cmd = process.platform === 'win32' ? 'where mysqldump 2>nul' : 'which mysqldump 2>/dev/null';
      const result = execSync(cmd, { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
      if (result) {
        const firstLine = result.split('\n')[0].trim();
        if (fs.existsSync(firstLine)) return firstLine;
      }
    } catch (e) {}

    // Check common paths
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    // Check environment variables
    const envVars = ['MYSQL_HOME', 'MYSQL_DIR', 'MYSQLPATH', 'MARIADB_HOME'];
    for (const env of envVars) {
      if (process.env[env]) {
        const p = path.join(process.env[env], 'bin', 'mysqldump.exe');
        if (fs.existsSync(p)) return p;
        const p2 = path.join(process.env[env], 'bin', 'mysqldump');
        if (fs.existsSync(p2)) return p2;
      }
    }

    // Scan C:\tools\mysql (Chocolatey default)
    try {
      if (fs.existsSync('C:\\tools\\mysql')) {
        const subDirs = fs.readdirSync('C:\\tools\\mysql');
        for (const d of subDirs) {
          const binDir = path.join('C:\\tools\\mysql', d, 'bin');
          if (fs.existsSync(binDir)) {
            const found = fs.readdirSync(binDir).find(f => f.toLowerCase() === 'mysqldump.exe');
            if (found) return path.join(binDir, found);
          }
        }
        // Also check C:\tools\mysql\bin directly
        const directBin = path.join('C:\\tools\\mysql', 'bin');
        if (fs.existsSync(directBin)) {
          const found = fs.readdirSync(directBin).find(f => f.toLowerCase() === 'mysqldump.exe');
          if (found) return path.join(directBin, found);
        }
      }
    } catch (e) {}

    // Scan Program Files for any MySQL/MariaDB installation
    try {
      const pf = process.env.ProgramFiles || 'C:\\Program Files';
      const dirs = fs.readdirSync(pf).filter(d => /mysql|mariadb/i.test(d));
      for (const d of dirs) {
        const binDir = path.join(pf, d, 'bin');
        if (fs.existsSync(binDir)) {
          const found = fs.readdirSync(binDir).find(f => f.toLowerCase() === 'mysqldump.exe');
          if (found) return path.join(binDir, found);
        }
      }
    } catch (e) {}

    return null;
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

    for (const db of databases) {
      try {
        const result = await this.backupDatabase(profile, db);
        results.push(result);

        if (result.success && profile.UploadTargets.length > 0) {
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
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
    const success = results.every(r => r.success);

    // Update profile last run
    this.updateProfile({
      Id: profileId,
      LastRun: new Date().toISOString(),
      LastStatus: success ? 'Success' : 'Partial'
    });

    this.logger.audit('BACKUP_EXECUTED', {
      targetType: 'backup',
      target: profileId,
      after: { profile: profile.Name, databases: databases.length, success, duration }
    });

    return { success, duration, results };
  }

  async backupDatabase(profile, database) {
    return new Promise((resolve) => {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
      const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');

      let filename = profile.NamingPattern
        .replace(/{database}/g, database === '--all-databases' ? 'all_databases' : database)
        .replace(/{date}/g, dateStr)
        .replace(/{time}/g, timeStr)
        .replace(/{timestamp}/g, now.getTime().toString());

      // Add extension based on compression
      const dumpExt = '.sql';
      let finalExt = dumpExt;
      if (profile.Compression === 'zip') finalExt = '.sql.zip';
      else if (profile.Compression === '7z') finalExt = '.sql.7z';

      const dumpPath = path.join(profile.BackupPath, filename + dumpExt);
      const finalPath = path.join(profile.BackupPath, filename + finalExt);

      // Build mysqldump command
      const args = [
        `"${this.mysqldumpPath}"`,
        `--host="${profile.Host}"`,
        `--port=${profile.Port}`,
        `--user="${profile.User}"`,
        `--password="${profile.Password}"`,
      ];

      if (profile.ExtraArgs) args.push(profile.ExtraArgs);

      if (database === '--all-databases') {
        args.push('--all-databases');
      } else {
        args.push(`"${database}"`);
      }

      args.push(`--result-file="${dumpPath}"`);

      const cmd = args.join(' ');
      this.logger.log('INFO', `Backing up database: ${database}`);

      exec(cmd, { timeout: 600000, maxBuffer: 50 * 1024 * 1024, windowsHide: true }, async (error) => {
        if (error) {
          resolve({ success: false, database, message: error.message });
          return;
        }

        // Compress
        if (profile.Compression !== 'none' && fs.existsSync(dumpPath)) {
          try {
            await this.compressFile(dumpPath, finalPath, profile.Compression, profile.CompressionLevel);
            // Remove uncompressed dump
            try { fs.unlinkSync(dumpPath); } catch (e) {}
          } catch (e) {
            resolve({ success: false, database, message: `Compression failed: ${e.message}` });
            return;
          }
        }

        const filePath = profile.Compression !== 'none' ? finalPath : dumpPath;
        const stats = fs.existsSync(filePath) ? fs.statSync(filePath) : null;

        resolve({
          success: true,
          database,
          filePath,
          size: stats ? stats.size : 0,
          sizeHuman: stats ? this.formatSize(stats.size) : '0 B'
        });
      });
    });
  }

  // ─── Compression ───
  async compressFile(inputPath, outputPath, method, level) {
    return new Promise((resolve, reject) => {
      if (method === 'zip') {
        // Try 7z first (better compression), fallback to PowerShell
        const has7z = this.find7z();
        if (has7z) {
          const cmd = `"${has7z}" a -tzip -mx=${level} "${outputPath}" "${inputPath}"`;
          exec(cmd, { timeout: 300000, windowsHide: true }, (err) => {
            if (err) reject(err); else resolve();
          });
        } else {
          // PowerShell compression
          const dir = path.dirname(inputPath);
          const name = path.basename(inputPath);
          const cmd = `powershell -NoProfile -Command "Compress-Archive -Path '${inputPath}' -DestinationPath '${outputPath}' -CompressionLevel Optimal"`;
          exec(cmd, { timeout: 300000, windowsHide: true }, (err) => {
            if (err) reject(err); else resolve();
          });
        }
      } else if (method === '7z') {
        const has7z = this.find7z();
        if (has7z) {
          const cmd = `"${has7z}" a -t7z -mx=${level} "${outputPath}" "${inputPath}"`;
          exec(cmd, { timeout: 300000, windowsHide: true }, (err) => {
            if (err) reject(err); else resolve();
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
    const candidates = [
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe',
      '/usr/bin/7z',
      '/usr/local/bin/7z'
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    try {
      return execSync('where 7z 2>nul || which 7z 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
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

      // Use PowerShell FTP
      const cmd = `powershell -NoProfile -Command "
        $ftp = New-Object System.Net.FtpWebRequest('${target.url}/${remotePath}');
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
    return new Promise((resolve) => {
      const filename = path.basename(filePath);
      const remotePath = target.path ? `${target.path}/${filename}` : `/${filename}`;

      // Try WinSCP, then psftp, then ssh
      const hasWinSCP = fs.existsSync('C:\\Program Files (x86)\\WinSCP\\WinSCP.com');
      const hasPscp = fs.existsSync('C:\\Program Files (x86)\\PuTTY\\pscp.exe');

      if (hasWinSCP) {
        const cmd = `"C:\\Program Files (x86)\\WinSCP\\WinSCP.com" /ini=nul /command "open sftp://${target.user}:${target.password}@${target.host}:${target.port || 22}/ -hostkey=*" "put "${filePath}" "${remotePath}"" "exit"`;
        exec(cmd, { timeout: 600000, windowsHide: true }, (error) => {
          if (error) resolve({ success: false, type: 'sftp', message: error.message });
          else resolve({ success: true, type: 'sftp', remotePath });
        });
      } else {
        // Fallback: try ssh/sftp from Git Bash or WSL
        const cmd = `sftp -o StrictHostKeyChecking=no -P ${target.port || 22} ${target.user}@${target.host} <<< "put ${filePath} ${remotePath}"`;
        exec(cmd, { timeout: 600000, windowsHide: true }, (error) => {
          if (error) resolve({ success: false, type: 'sftp', message: error.message });
          else resolve({ success: true, type: 'sftp', remotePath });
        });
      }
    });
  }

  async uploadSMB(filePath, target) {
    return new Promise((resolve) => {
      const filename = path.basename(filePath);
      const uncPath = target.path || target.url; // \\server\share\folder

      // Copy via network path
      const destPath = path.join(uncPath, filename);

      const cmd = `copy "${filePath}" "${destPath}" /Y`;
      exec(cmd, { timeout: 600000, windowsHide: true }, (error) => {
        if (error) {
          // Try PowerShell Copy-Item for network paths
          const psCmd = `powershell -NoProfile -Command "Copy-Item -Path '${filePath}' -Destination '${destPath}' -Force"`;
          exec(psCmd, { timeout: 600000 }, (err2) => {
            if (err2) resolve({ success: false, type: 'smb', message: err2.message });
            else resolve({ success: true, type: 'smb', remotePath: destPath });
          });
        } else {
          resolve({ success: true, type: 'smb', remotePath: destPath });
        }
      });
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
  testConnection(host, port, user, password) {
    return new Promise((resolve) => {
      let mysql;
      try { mysql = require('mysql2/promise'); } catch (e) {
        resolve({ success: false, message: 'mysql2 driver not installed. Run: npm install mysql2' });
        return;
      }
      const conn = mysql.createConnection({
        host: host || 'localhost',
        port: parseInt(port) || 3306,
        user: user || 'root',
        password: password || '',
        connectTimeout: 10000
      });
      conn.then(connection => {
        connection.query('SELECT 1 AS ok').then(() => {
          connection.end();
          resolve({ success: true, message: 'Connection successful' });
        }).catch(err => {
          connection.end().catch(() => {});
          resolve({ success: false, message: err.message });
        });
      }).catch(err => {
        resolve({ success: false, message: err.message });
      });
    });
  }

  // List databases (uses mysql2 driver, not mysqldump)
  listDatabases(host, port, user, password) {
    return new Promise((resolve) => {
      let mysql;
      try { mysql = require('mysql2/promise'); } catch (e) {
        resolve({ success: false, databases: [], message: 'mysql2 driver not installed' });
        return;
      }
      const conn = mysql.createConnection({
        host: host || 'localhost',
        port: parseInt(port) || 3306,
        user: user || 'root',
        password: password || '',
        connectTimeout: 10000
      });
      conn.then(connection => {
        connection.query('SHOW DATABASES').then(([rows]) => {
          connection.end();
          const dbs = rows.map(r => r.Database).filter(d => d && !['information_schema', 'performance_schema'].includes(d));
          resolve({ success: true, databases: dbs });
        }).catch(err => {
          connection.end().catch(() => {});
          resolve({ success: false, databases: [], message: err.message });
        });
      }).catch(err => {
        resolve({ success: false, databases: [], message: err.message });
      });
    });
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
