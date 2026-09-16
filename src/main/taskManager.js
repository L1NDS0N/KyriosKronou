// TaskManager.js - Task CRUD, Execution, Import/Export
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

class TaskManager {
  constructor(config, logger, cronParser) {
    this.config = config;
    this.logger = logger;
    this.cronParser = cronParser;
    this.tasks = [];
    this.history = [];
    this.tasksFile = path.join(config.configDir, 'tasks.json');
    this.historyFile = path.join(config.configDir, 'history.json');
    this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(this.tasksFile)) {
        const data = JSON.parse(fs.readFileSync(this.tasksFile, 'utf8'));
        this.tasks = Array.isArray(data) ? data : [];
      }
    } catch (e) { this.tasks = []; }

    try {
      if (fs.existsSync(this.historyFile)) {
        const data = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
        this.history = Array.isArray(data) ? data : [];
      }
    } catch (e) { this.history = []; }
  }

  saveTasks() {
    fs.writeFileSync(this.tasksFile, JSON.stringify(this.tasks, null, 2), 'utf8');
  }

  saveHistory() {
    fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2), 'utf8');
  }

  addTask(taskData) {
    const task = {
      Id: taskData.Id || require('crypto').randomUUID(),
      Name: taskData.Name,
      CronExpression: taskData.CronExpression,
      ScriptPath: taskData.ScriptPath,
      Arguments: taskData.Arguments || '',
      WorkingDirectory: taskData.WorkingDirectory || '',
      Description: taskData.Description || '',
      ScriptContent: taskData.ScriptContent || '',
      ScriptType: taskData.ScriptType || '',
      ManagementMode: taskData.ManagementMode || 'cronmaster',
      Enabled: taskData.Enabled !== false,
      CreatedAt: taskData.CreatedAt || new Date().toISOString(),
      UpdatedAt: taskData.UpdatedAt || new Date().toISOString()
    };

    this.tasks.push(task);
    this.saveTasks();
    this.logger.log('INFO', `Task created: ${task.Name}`);
    return { success: true, task };
  }

  updateTask(taskData) {
    const index = this.tasks.findIndex(t => t.Id === taskData.Id);
    if (index === -1) return { success: false, message: 'Task not found' };

    this.tasks[index] = { ...this.tasks[index], ...taskData, UpdatedAt: new Date().toISOString() };
    this.saveTasks();
    this.logger.log('INFO', `Task updated: ${this.tasks[index].Name}`);
    return { success: true };
  }

  deleteTask(id) {
    const index = this.tasks.findIndex(t => t.Id === id);
    if (index === -1) return { success: false, message: 'Task not found' };

    const name = this.tasks[index].Name;
    this.tasks.splice(index, 1);
    this.saveTasks();
    this.logger.log('INFO', `Task deleted: ${name}`);
    return { success: true };
  }

  getTask(id) {
    return this.tasks.find(t => t.Id === id) || null;
  }

  getAllTasks() {
    return [...this.tasks];
  }

  getHistory() {
    return [...this.history];
  }

  executeTask(task) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const scriptPath = task.ScriptPath;
      const scriptType = (task.ScriptType || '').toLowerCase();

      if (!fs.existsSync(scriptPath)) {
        const entry = {
          Id: require('crypto').randomUUID(),
          TaskId: task.Id,
          TaskName: task.Name,
          CronExpression: task.CronExpression,
          Timestamp: new Date().toISOString(),
          Status: 'Error',
          Duration: '0s',
          Message: `Script not found: ${scriptPath}`
        };
        this.history.unshift(entry);
        this.saveHistory();
        this.logger.log('ERROR', `Task execution failed: ${task.Name} - ${entry.Message}`);
        resolve(entry);
        return;
      }

      const options = {};
      if (task.WorkingDirectory && fs.existsSync(task.WorkingDirectory)) {
        options.cwd = task.WorkingDirectory;
      }
      options.windowsHide = true;
      options.timeout = 300000; // 5 min timeout

      // Build the correct command based on script type
      const ext = path.extname(scriptPath).toLowerCase();
      let cmd, cmdArgs;

      // execFile quotes each argument itself. Adding our own quotes here made
      // cmd.exe receive a literally-escaped \"C:\path\" and refuse to run it -
      // which meant .bat/.cmd tasks never executed at all. Pass bare values and
      // let execFile do the quoting.
      const userArgs = task.Arguments ? task.Arguments.split(/\s+/).filter(Boolean) : [];

      if (ext === '.ps1' || scriptType === 'ps1') {
        // PowerShell: -File must be followed by the path alone, then arguments.
        cmd = 'powershell.exe';
        cmdArgs = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-NonInteractive', '-File', scriptPath, ...userArgs];
        this.logger.log('INFO', `Executing PowerShell: ${scriptPath}`);
      } else if (ext === '.bat' || ext === '.cmd' || scriptType === 'bat') {
        // Batch: cmd.exe /c <script> [args]
        cmd = 'cmd.exe';
        cmdArgs = ['/c', scriptPath, ...userArgs];
        this.logger.log('INFO', `Executing Batch: ${scriptPath}`);
      } else {
        // Executable or other: run directly
        cmd = scriptPath;
        cmdArgs = userArgs;
        this.logger.log('INFO', `Executing: ${scriptPath}`);
      }

      execFile(cmd, cmdArgs, options, (error, stdout, stderr) => {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
        const logMsg = (stdout || '').trim().substring(0, 500);
        const errMsg = (stderr || '').trim().substring(0, 500);
        const entry = {
          Id: require('crypto').randomUUID(),
          TaskId: task.Id,
          TaskName: task.Name,
          CronExpression: task.CronExpression,
          Timestamp: new Date().toISOString(),
          Status: error ? 'Error' : 'Success',
          Duration: duration,
          Message: error ? (error.message || errMsg || 'Unknown error') : (logMsg || 'Completed'),
          Stdout: logMsg,
          Stderr: errMsg
        };
        this.history.unshift(entry);
        this.saveHistory();
        if (error) {
          this.logger.log('ERROR', `Task ${task.Name} FAILED (${duration}): ${error.message}`);
          if (errMsg) this.logger.log('ERROR', `  stderr: ${errMsg}`);
          if (logMsg) this.logger.log('ERROR', `  stdout: ${logMsg}`);
        } else {
          this.logger.log('INFO', `Task ${task.Name} completed (${duration}): ${logMsg || 'OK'}`);
        }
        resolve(entry);
      });
    });
  }

  getDueTasks() {
    const now = new Date();
    return this.tasks.filter(task => {
      if (!task.Enabled) return false;
      // NSSM-managed tasks run independently as Windows services
      // Kyrion should NOT execute them
      if (task.ManagementMode === 'nssm') return false;
      if (!this.cronParser.shouldRunNow(task.CronExpression)) return false;
      const recentRun = this.history.find(h =>
        h.TaskId === task.Id && new Date(h.Timestamp) > new Date(now.getTime() - 60000)
      );
      return !recentRun;
    });
  }

  exportTasks(filePath) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(this.tasks, null, 2), 'utf8');
      this.logger.log('INFO', `Exported ${this.tasks.length} tasks to ${filePath}`);
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  importTasks(filePath) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const imported = Array.isArray(data) ? data : [data];
      imported.forEach(t => {
        if (!t.Id) t.Id = require('crypto').randomUUID();
        if (!this.tasks.find(existing => existing.Id === t.Id)) {
          this.tasks.push(t);
        }
      });
      this.saveTasks();
      this.logger.log('INFO', `Imported ${imported.length} tasks from ${filePath}`);
      return { success: true, count: imported.length };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  exportHistory(filePath) {
    try {
      let csv = 'Timestamp,TaskName,CronExpression,Status,Duration,Message\n';
      this.history.forEach(h => {
        csv += `"${h.Timestamp}","${h.TaskName}","${h.CronExpression}","${h.Status}","${h.Duration}","${(h.Message || '').replace(/"/g, '""')}"\n`;
      });
      fs.writeFileSync(filePath, csv, 'utf8');
      this.logger.log('INFO', `Exported history to CSV: ${filePath}`);
      return { success: true };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }
}

module.exports = TaskManager;
