// tests/test-integration.js
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ConfigManager = require('../src/main/configManager');
const Logger = require('../src/main/logger');
const CronParser = require('../src/main/cronParser');
const TaskManager = require('../src/main/taskManager');
const ServiceManager = require('../src/main/serviceManager');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cronmaster-int-test-'));
}

describe('Integration Tests', () => {
  let dir, config, logger, parser, tm, svc;

  beforeEach(() => {
    dir = tempDir();
    config = new ConfigManager(dir, 'test');
    logger = new Logger(dir);
    parser = new CronParser();
    tm = new TaskManager(config, logger, parser);
    svc = new ServiceManager(logger);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ─── Full Task Lifecycle ───
  describe('Full Task Lifecycle', () => {
    it('create → update → execute → delete', async () => {
      // Create
      const createResult = tm.addTask({
        Name: 'Lifecycle Test',
        CronExpression: '0 3 * * *',
        ScriptPath: 'nonexistent.ps1',
        Arguments: '-Param Value',
        WorkingDirectory: dir,
        Description: 'Integration test task',
        Enabled: true
      });
      expect(createResult.success).to.be.true;
      const taskId = createResult.task.Id;

      // Verify created
      let tasks = tm.getAllTasks();
      expect(tasks).to.have.length(1);
      expect(tasks[0].Name).to.equal('Lifecycle Test');

      // Update
      const updateResult = tm.updateTask({
        Id: taskId,
        Name: 'Updated Lifecycle',
        CronExpression: '0 4 * * *',
        ScriptPath: 'nonexistent.ps1',
        Description: 'Updated description',
        Enabled: false
      });
      expect(updateResult.success).to.be.true;

      // Verify updated
      tasks = tm.getAllTasks();
      const task = tasks.find(t => t.Id === taskId);
      expect(task.Name).to.equal('Updated Lifecycle');
      expect(task.CronExpression).to.equal('0 4 * * *');
      expect(task.Enabled).to.be.false;

      // Execute
      const execResult = await tm.executeTask(task);
      expect(execResult.Status).to.equal('Error'); // Script doesn't exist
      expect(execResult.TaskName).to.equal('Updated Lifecycle');

      // Check history
      const history = tm.getHistory();
      expect(history).to.have.length(1);
      expect(history[0].Timestamp).to.be.a('string');

      // Delete
      const deleteResult = tm.deleteTask(taskId);
      expect(deleteResult.success).to.be.true;
      expect(tm.getAllTasks()).to.have.length(0);
    });
  });

  // ─── Import/Export Round Trip ───
  describe('Import/Export Round Trip', () => {
    it('should preserve data through export and import', () => {
      // Create tasks
      tm.addTask({ Name: 'Task A', CronExpression: '0 9 * * 1-5', ScriptPath: 'a.ps1' });
      tm.addTask({ Name: 'Task B', CronExpression: '*/15 * * * *', ScriptPath: 'b.ps1' });

      // Export
      const exportPath = path.join(dir, 'roundtrip.json');
      const exportResult = tm.exportTasks(exportPath);
      expect(exportResult.success).to.be.true;

      // Create new manager and import
      const tm2 = new TaskManager(config, logger, parser);
      const importResult = tm2.importTasks(exportPath);
      expect(importResult.success).to.be.true;
      expect(importResult.count).to.equal(2);

      // Verify
      const tasks = tm2.getAllTasks();
      expect(tasks).to.have.length(2);
      expect(tasks.map(t => t.Name)).to.include('Task A');
      expect(tasks.map(t => t.Name)).to.include('Task B');
    });
  });

  // ─── Profile Management ───
  describe('Profile Management', () => {
    it('should create and switch between profiles', () => {
      config.setSetting('NssmPath', 'custom/path');
      config.save();

      // Create second profile
      config.createProfile('production');
      config.loadProfile('production');
      expect(config.getSetting('NssmPath')).to.equal('nssm'); // Default for new profile

      // Switch back
      config.loadProfile('test');
      expect(config.getSetting('NssmPath')).to.equal('custom/path');
    });

    it('should maintain independent task lists per profile', () => {
      tm.addTask({ Name: 'Test Task', CronExpression: '0 0 * * *', ScriptPath: 'x.ps1' });

      // Use separate config dir for isolation
      const dir2 = tempDir();
      const config2 = new ConfigManager(dir2, 'other');
      const tm2 = new TaskManager(config2, logger, parser);
      expect(tm2.getAllTasks()).to.have.length(0);

      // Add task in other profile
      tm2.addTask({ Name: 'Other Task', CronExpression: '0 1 * * *', ScriptPath: 'y.ps1' });
      expect(tm2.getAllTasks()).to.have.length(1);

      // Original still has its task
      expect(tm.getAllTasks()).to.have.length(1);
      expect(tm.getAllTasks()[0].Name).to.equal('Test Task');

      fs.rmSync(dir2, { recursive: true, force: true });
    });
  });

  // ─── Cron Scheduling Integration ───
  describe('Cron Scheduling Integration', () => {
    it('should correctly identify due tasks', () => {
      tm.addTask({ Name: 'Every Minute', CronExpression: '* * * * *', ScriptPath: 'x.ps1', Enabled: true });
      tm.addTask({ Name: 'Every Hour', CronExpression: '0 * * * *', ScriptPath: 'x.ps1', Enabled: true });
      tm.addTask({ Name: 'Disabled', CronExpression: '* * * * *', ScriptPath: 'x.ps1', Enabled: false });

      const due = tm.getDueTasks();
      expect(due.length).to.be.greaterThan(0);
      expect(due.every(t => t.Enabled)).to.be.true;
    });

    it('should generate correct descriptions', () => {
      expect(parser.getDescription('* * * * *').toLowerCase()).to.include('every minute');
      expect(parser.getDescription('0 2 * * *')).to.include('02');
      expect(parser.getDescription('*/5 * * * *')).to.include('5');
    });

    it('should compute next run times', () => {
      const next = parser.getNextRunTime('0 2 * * *');
      expect(next).to.be.an.instanceOf(Date);
      expect(next.getHours()).to.equal(2);
      expect(next.getMinutes()).to.equal(0);
      expect(next.getTime()).to.be.greaterThan(Date.now());
    });
  });

  // ─── Error Handling ───
  describe('Error Handling', () => {
    it('should handle invalid cron gracefully', () => {
      expect(parser.validate('invalid')).to.be.false;
      expect(parser.getDescription('invalid')).to.include('Invalid');
      expect(parser.getNextRunTime('invalid')).to.be.null;
    });

    it('should handle non-existent task operations', () => {
      expect(tm.getTask('nonexistent')).to.be.null;
      expect(tm.deleteTask('nonexistent').success).to.be.false;
      expect(tm.updateTask({ Id: 'nonexistent', Name: 'X' }).success).to.be.false;
    });

    it('should handle missing script gracefully', async () => {
      tm.addTask({ Name: 'Missing', CronExpression: '0 0 * * *', ScriptPath: '/nonexistent/script.ps1' });
      const result = await tm.executeTask(tm.getAllTasks()[0]);
      expect(result.Status).to.equal('Error');
      expect(result.Message).to.include('not found');
    });
  });

  // ─── Logger Integration ───
  describe('Logger Integration', () => {
    it('should log task lifecycle events', async () => {
      tm.addTask({ Name: 'Log Test', CronExpression: '0 0 * * *', ScriptPath: 'nonexistent.ps1' });
      const task = tm.getAllTasks()[0];
      await tm.executeTask(task);
      tm.deleteTask(task.Id);

      const logs = logger.getRecentLogs();
      const messages = logs.map(l => l.message);
      expect(messages.some(m => m.includes('Task created'))).to.be.true;
      expect(messages.some(m => m.includes('Task deleted'))).to.be.true;
    });
  });
});
