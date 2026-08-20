// ServiceManager.js - NSSM Service Management
const { execSync } = require('child_process');
const fs = require('fs');

class ServiceManager {
  constructor(logger) {
    this.logger = logger;
    this.nssmPath = 'nssm';
  }

  checkNssm(nssmPath) {
    try {
      const output = execSync(`"${nssmPath || this.nssmPath}" version`, { encoding: 'utf8', timeout: 5000 });
      if (output.includes('NSSM')) {
        const match = output.match(/NSSM\s+([\d.]+)/);
        return { installed: true, path: nssmPath || this.nssmPath, version: match ? match[1] : 'unknown' };
      }
    } catch (e) {}

    const commonPaths = [
      'C:\\nssm\\win64\\nssm.exe',
      'C:\\nssm\\win32\\nssm.exe',
      `${process.env.ProgramFiles}\\nssm\\nssm.exe`,
      `${process.env['ProgramFiles(x86)']}\\nssm\\nssm.exe`,
      `${process.env.USERPROFILE}\\nssm\\nssm.exe`
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        try {
          execSync(`"${p}" version`, { encoding: 'utf8', timeout: 5000 });
          this.nssmPath = p;
          return { installed: true, path: p, version: 'found' };
        } catch (e) {}
      }
    }

    return { installed: false, path: '', version: '' };
  }

  _runNssm(...args) {
    try {
      const cmd = `"${this.nssmPath}" ${args.join(' ')}`;
      // Write commands need elevation (start, stop, install, remove, set)
      const writeCmds = ['start', 'stop', 'install', 'remove', 'set', 'restart'];
      const needsElevation = writeCmds.includes(args[0]);

      if (needsElevation) {
        // Elevate via PowerShell Start-Process -Verb RunAs
        const psCmd = `powershell -NoProfile -NonInteractive -Command "Start-Process -FilePath '${this.nssmPath}' -ArgumentList '${args.join(' ').replace(/'/g, "''")}' -Verb RunAs -Wait -WindowStyle Hidden"`;
        try {
          execSync(psCmd, { encoding: 'utf8', timeout: 15000, windowsHide: true });
          return { success: true, output: '' };
        } catch (elevErr) {
          // If elevation was denied or failed, fall back to non-elevated
          const output = execSync(cmd, { encoding: 'utf8', timeout: 10000, windowsHide: true });
          return { success: true, output };
        }
      }

      const output = execSync(cmd, { encoding: 'utf8', timeout: 10000, windowsHide: true });
      return { success: true, output };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  getAllServices() {
    const services = [];
    const seen = new Set();

    // Method 1: nssm list — output is just service names, one per line
    // (e.g. "nginx\nphpcgi\nphpfpm")
    try {
      const output = execSync(`"${this.nssmPath}" list`, { encoding: 'utf8', timeout: 10000 });
      const lines = output.split('\n').map(l => l.replace(/\r/g, '').trim()).filter(Boolean);
      for (const name of lines) {
        // Skip if it looks like a registry path (old format) or is empty
        if (name.startsWith('HKLM') || name.startsWith('HKCU')) continue;
        if (!seen.has(name)) {
          seen.add(name);
          const info = this.getServiceInfo(name);
          if (info) services.push(info);
        }
      }
    } catch (e) { /* nssm list failed */ }

    // Method 2: PowerShell Get-Service for any CronMaster-* services
    // (catches services installed but maybe not from current nssm list)
    try {
      const psOut = execSync(
        'powershell -NoProfile -Command "Get-Service | Where-Object { $_.Name -like \'CronMaster*\' } | ForEach-Object { Write-Output $_.Name }"',
        { encoding: 'utf8', timeout: 10000 }
      );
      for (const name of psOut.split('\n').map(s => s.replace(/\r/g, '').trim()).filter(Boolean)) {
        if (!seen.has(name)) {
          seen.add(name);
          const info = this.getServiceInfo(name);
          if (info) services.push(info);
        }
      }
    } catch (e) { /* PowerShell query failed */ }

    return services;
  }

  getServiceInfo(name) {
    if (!name || !name.trim()) return null;
    try {
      const status = this._runNssm('status', name);

      // If nssm status failed entirely, the service doesn't exist
      if (!status.success && (!status.output || status.output.includes('cannot find the file'))) {
        return null;
      }

      let statusText = 'Unknown';
      if (status.output) {
        if (status.output.includes('SERVICE_RUNNING')) statusText = 'Running';
        else if (status.output.includes('SERVICE_STOPPED')) statusText = 'Stopped';
        else if (status.output.includes('SERVICE_PAUSED')) statusText = 'Paused';
        else if (status.output.includes('SERVICE_START_PENDING')) statusText = 'Starting';
        else if (status.output.includes('SERVICE_STOP_PENDING')) statusText = 'Stopping';
      } else if (!status.success) {
        return null; // No output + failed = service doesn't exist
      }

      const app = this._runNssm('get', name, 'Application');
      const startup = this._runNssm('get', name, 'Start');
      let startupType = 'Automatic';
      if (startup.output && startup.output.includes('SERVICE_DEMAND_START')) startupType = 'Manual';
      else if (startup.output && startup.output.includes('SERVICE_DISABLED')) startupType = 'Disabled';

      return { Name: name, Status: statusText, StartupType: startupType, Application: (app.output || '').trim(), ProcessId: 0 };
    } catch (e) {
      return null;
    }
  }

  getServiceCount() {
    try {
      const output = execSync(`"${this.nssmPath}" list`, { encoding: 'utf8', timeout: 10000 });
      return (output.match(/HKLM\\/g) || []).length;
    } catch (e) {
      return 0;
    }
  }

  installService(name, appPath, args, workDir, startupType) {
    try {
      // nssm install <name> <app> [args]
      // Don't double-quote — _runNssm builds the shell command
      const installArgs = ['install', name, appPath];
      if (args) installArgs.push(args);
      const result = this._runNssm(...installArgs);
      if (!result.success) return { success: false, message: result.message };

      if (workDir && fs.existsSync(workDir)) {
        this._runNssm('set', name, 'AppDirectory', workDir);
      }

      const startupMap = { 'Automatic': 'SERVICE_AUTO_START', 'Manual': 'SERVICE_DEMAND_START', 'Disabled': 'SERVICE_DISABLED' };
      if (startupMap[startupType]) {
        this._runNssm('set', name, 'Start', startupMap[startupType]);
      }

      this.logger.log('INFO', `Service '${name}' installed`);
      return { success: true, message: 'Service installed' };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  startService(name) {
    const r = this._runNssm('start', name);
    if (r.success) this.logger.log('INFO', `Service '${name}' started`);
    return { success: r.success, message: r.success ? 'Started' : r.message };
  }

  stopService(name) {
    const r = this._runNssm('stop', name);
    if (r.success) this.logger.log('INFO', `Service '${name}' stopped`);
    return { success: r.success, message: r.success ? 'Stopped' : r.message };
  }

  restartService(name) {
    const r = this._runNssm('restart', name);
    if (r.success) this.logger.log('INFO', `Service '${name}' restarted`);
    return { success: r.success, message: r.success ? 'Restarted' : r.message };
  }

  uninstallService(name) {
    const r = this._runNssm('remove', name, 'confirm');
    if (r.success) this.logger.log('INFO', `Service '${name}' uninstalled`);
    return { success: r.success, message: r.success ? 'Uninstalled' : r.message };
  }
}

module.exports = ServiceManager;
