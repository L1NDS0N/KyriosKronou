// nssmInstaller.js - NSSM Installation Manager
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

class NssmInstaller {
  constructor(logger) {
    this.logger = logger;
  }

  // Check if NSSM is already installed and accessible
  checkInstalled(nssmPath) {
    try {
      const result = execSync(`"${nssmPath || 'nssm'}" version`, { encoding: 'utf8', timeout: 5000 });
      if (result.includes('NSSM')) {
        const match = result.match(/NSSM\s+([\d.]+)/);
        return { installed: true, path: nssmPath || 'nssm', version: match ? match[1] : 'unknown', method: 'existing' };
      }
    } catch (e) {}

    // Check common paths
    const commonPaths = [
      'C:\\nssm\\win64\\nssm.exe',
      'C:\\nssm\\win32\\nssm.exe',
      `${process.env.ProgramFiles}\\nssm\\nssm.exe`,
      `${process.env['ProgramFiles(x86)']}\\nssm\\nssm.exe`,
      `${process.env.USERPROFILE}\\nssm\\nssm.exe`,
      `${process.env.LOCALAPPDATA}\\nssm\\nssm.exe`
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        try {
          execSync(`"${p}" version`, { encoding: 'utf8', timeout: 5000 });
          return { installed: true, path: p, version: 'found', method: 'path' };
        } catch (e) {}
      }
    }

    return { installed: false };
  }

  // Check available package managers
  checkPackageManagers() {
    const managers = [];

    // Check winget
    try {
      execSync('winget --version', { encoding: 'utf8', timeout: 5000 });
      managers.push({ name: 'winget', available: true, label: 'Winget (Windows Package Manager)' });
    } catch (e) {
      managers.push({ name: 'winget', available: false, label: 'Winget (Windows Package Manager)' });
    }

    // Check chocolatey
    try {
      execSync('choco --version', { encoding: 'utf8', timeout: 5000 });
      managers.push({ name: 'choco', available: true, label: 'Chocolatey' });
    } catch (e) {
      managers.push({ name: 'choco', available: false, label: 'Chocolatey' });
    }

    // Check scoop
    try {
      execSync('scoop --version', { encoding: 'utf8', timeout: 5000 });
      managers.push({ name: 'scoop', available: true, label: 'Scoop' });
    } catch (e) {
      managers.push({ name: 'scoop', available: false, label: 'Scoop' });
    }

    return managers;
  }

  // Install NSSM via a package manager
  async installVia(manager, installDir) {
    return new Promise((resolve) => {
      let cmd;
      switch (manager) {
        case 'winget':
          cmd = 'winget install nssm --accept-package-agreements --accept-source-agreements';
          break;
        case 'choco':
          cmd = 'choco install nssm -y';
          break;
        case 'scoop':
          cmd = 'scoop install nssm';
          break;
        default:
          return resolve({ success: false, message: `Unknown package manager: ${manager}` });
      }

      this.logger.log('INFO', `Installing NSSM via ${manager}: ${cmd}`);

      exec(cmd, { encoding: 'utf8', timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
          this.logger.log('ERROR', `NSSM install failed: ${error.message}`);
          resolve({ success: false, message: error.message, stdout, stderr });
        } else {
          this.logger.log('INFO', `NSSM installed successfully via ${manager}`);
          // Re-check if installed
          const check = this.checkInstalled('nssm');
          resolve({ success: check.installed, path: check.path, version: check.version, message: stdout || 'Installed' });
        }
      });
    });
  }

  // Download NSSM manually from nssm.cc
  async downloadManual(downloadDir) {
    return new Promise((resolve) => {
      const url = 'https://nssm.cc/release/nssm-2.24.zip';
      const zipPath = path.join(downloadDir, 'nssm.zip');
      this.logger.log('INFO', `Downloading NSSM from ${url}`);

      // Use PowerShell to download
      const psCmd = `powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${zipPath}'"`;

      exec(psCmd, { encoding: 'utf8', timeout: 60000 }, (error) => {
        if (error) {
          resolve({ success: false, message: `Download failed: ${error.message}` });
          return;
        }

        // Extract
        const extractDir = path.join(downloadDir, 'nssm');
        try {
          execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { encoding: 'utf8', timeout: 30000 });

          // Find nssm.exe
          const nssmExe = path.join(extractDir, 'nssm-2.24', 'win64', 'nssm.exe');
          const nssmExe32 = path.join(extractDir, 'nssm-2.24', 'win32', 'nssm.exe');

          let finalPath;
          if (fs.existsSync(nssmExe)) {
            finalPath = nssmExe;
          } else if (fs.existsSync(nssmExe32)) {
            finalPath = nssmExe32;
          } else {
            // Try to find it anywhere in extractDir
            const findResult = execSync(`dir /s /b "${path.join(extractDir, 'nssm.exe')}"`, { encoding: 'utf8', timeout: 5000 }).trim();
            finalPath = findResult.split('\n')[0].trim();
          }

          if (finalPath && fs.existsSync(finalPath)) {
            // Copy to a stable location
            const stablePath = path.join(downloadDir, 'nssm.exe');
            fs.copyFileSync(finalPath, stablePath);
            this.logger.log('INFO', `NSSM extracted to ${stablePath}`);
            resolve({ success: true, path: stablePath, message: `NSSM installed to ${stablePath}` });
          } else {
            resolve({ success: false, message: 'Could not find nssm.exe in downloaded archive' });
          }
        } catch (e) {
          resolve({ success: false, message: `Extraction failed: ${e.message}` });
        }
      });
    });
  }
}

module.exports = NssmInstaller;
