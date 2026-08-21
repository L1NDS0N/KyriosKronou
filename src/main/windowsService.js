// windowsService.js - Native Windows Service Installer (no NSSM)
const { Service } = require('node-windows');
const path = require('path');
const { exec } = require('child_process');

const SERVICE_NAME = 'KyrionKronou';

class WindowsServiceInstaller {
  constructor(logger) {
    this.logger = logger;
    this._service = null;
  }

  /**
   * Get the path to the standalone scheduler script.
   * This is a pure Node.js script (no Electron) that runs as a Windows service.
   */
  _getSchedulerPath() {
    // When running from source (dev):
    if (path.basename(process.execPath) === 'electron.exe') {
      return path.join(__dirname, 'serviceScheduler.js');
    }
    // When running from packaged app:
    const appDir = path.dirname(process.execPath);
    return path.join(appDir, 'resources', 'app', 'src', 'main', 'serviceScheduler.js');
  }

  /**
   * Install the Kyrion service as a native Windows service.
   * Returns { success, message, serviceName }
   */
  install() {
    return new Promise((resolve) => {
      try {
        const scriptPath = this._getLauncherPath();
        this.logger.log('INFO', `Installing Windows service from: ${scriptPath}`);

        this._service = new Service({
          name: 'Kyrion Kronou Scheduler',
          description: 'Kyrion Kronou - Task Scheduler & MySQL Backup Service',
          script: this._getSchedulerPath(),
          nodeOptions: ['--max-old-space-size=256'],
          env: [
            { name: 'KYRION_SERVICE_MODE', value: '1' },
            { name: 'NODE_ENV', value: 'production' }
          ],
          wait: 5,
          grow: 0.5,
          maxRestarts: 10,
        });

        this._service.on('install', () => {
          this.logger.log('INFO', 'Windows service installed successfully');
          // Start it immediately after install
          this._service.start();
        });

        this._service.on('start', () => {
          this.logger.log('INFO', 'Windows service started');
          this.logger.audit('SERVICE_INSTALLED', { service: SERVICE_NAME });
          resolve({ success: true, message: 'Service installed and started', serviceName: SERVICE_NAME });
        });

        this._service.on('alreadyinstalled', () => {
          this.logger.log('WARN', 'Windows service already installed, restarting...');
          this._service.start();
        });

        this._service.on('startfailed', (err) => {
          this.logger.log('ERROR', `Service start failed: ${err.message || err}`);
          resolve({ success: false, message: `Service install OK but start failed: ${err.message || err}` });
        });

        this._service.on('invalidinstallation', () => {
          this.logger.log('ERROR', 'Invalid installation detected');
          resolve({ success: false, message: 'Invalid installation - check Node.js is accessible' });
        });

        this._service.on('error', (err) => {
          this.logger.log('ERROR', `Service error: ${err.message || err}`);
          resolve({ success: false, message: err.message || 'Service error' });
        });

        // Trigger install
        this._service.install();

      } catch (err) {
        this.logger.error('Failed to install Windows service', err);
        resolve({ success: false, message: `Install failed: ${err.message}` });
      }
    });
  }

  /**
   * Uninstall the Kyrion Windows service.
   */
  uninstall() {
    return new Promise((resolve) => {
      try {
        this._service = new Service({
          name: 'Kyrion Kronou Scheduler',
          script: this._getSchedulerPath(),
        });

        this._service.on('uninstall', () => {
          this.logger.log('INFO', 'Windows service uninstalled');
          this.logger.audit('SERVICE_UNINSTALLED', { service: SERVICE_NAME });
          resolve({ success: true, message: 'Service uninstalled' });
        });

        this._service.on('error', (err) => {
          this.logger.log('ERROR', `Service uninstall error: ${err.message || err}`);
          resolve({ success: false, message: err.message || 'Uninstall error' });
        });

        this._service.on('notinstalled', () => {
          resolve({ success: true, message: 'Service was not installed' });
        });

        this._service.uninstall();

      } catch (err) {
        this.logger.error('Failed to uninstall Windows service', err);
        resolve({ success: false, message: `Uninstall failed: ${err.message}` });
      }
    });
  }

  /**
   * Check if the service is installed and get its status.
   * Uses `sc query` for reliable status checking.
   */
  getStatus() {
    return new Promise((resolve) => {
      const scName = SERVICE_NAME;
      exec(`sc query "${scName}"`, { timeout: 10000, windowsHide: true }, (error, stdout) => {
        if (error) {
          // Service not found
          resolve({ installed: false, status: null, running: false });
          return;
        }

        const running = stdout.includes('RUNNING');
        const stopped = stdout.includes('STOPPED');
        const paused = stdout.includes('PAUSED');

        let status = 'Unknown';
        if (running) status = 'Running';
        else if (stopped) status = 'Stopped';
        else if (paused) status = 'Paused';

        // Get additional info
        exec(`sc qc "${scName}"`, { timeout: 10000, windowsHide: true }, (err2, stdout2) => {
          let startType = 'Unknown';
          if (stdout2) {
            if (stdout2.includes('AUTO_START')) startType = 'Automatic';
            else if (stdout2.includes('DEMAND_START')) startType = 'Manual';
            else if (stdout2.includes('DISABLED')) startType = 'Disabled';
          }

          resolve({
            installed: true,
            status,
            running,
            startType,
            serviceName: SERVICE_NAME
          });
        });
      });
    });
  }

  /**
   * Start the Windows service.
   */
  start() {
    return new Promise((resolve) => {
      exec(`net start "${SERVICE_NAME}"`, { timeout: 30000, windowsHide: true }, (error, stdout, stderr) => {
        if (error && !stdout.includes('already started')) {
          resolve({ success: false, message: stderr || error.message });
        } else {
          this.logger.audit('SERVICE_STARTED', { service: SERVICE_NAME });
          resolve({ success: true, message: 'Service started' });
        }
      });
    });
  }

  /**
   * Stop the Windows service.
   */
  stop() {
    return new Promise((resolve) => {
      exec(`net stop "${SERVICE_NAME}"`, { timeout: 30000, windowsHide: true }, (error, stdout, stderr) => {
        if (error && !stdout.includes('not started')) {
          resolve({ success: false, message: stderr || error.message });
        } else {
          this.logger.audit('SERVICE_STOPPED', { service: SERVICE_NAME });
          resolve({ success: true, message: 'Service stopped' });
        }
      });
    });
  }

  /**
   * Restart the service.
   */
  async restart() {
    await this.stop();
    await new Promise(r => setTimeout(r, 2000));
    return this.start();
  }
}

module.exports = WindowsServiceInstaller;
