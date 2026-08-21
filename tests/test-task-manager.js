// tests/test-task-manager.js
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ConfigManager = require('../src/main/configManager');
const Logger = require('../src/main/logger');
const CronParser = require('../src/main/cronParser');
const TaskManager = require('../src/main/taskManager');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cronmaster-tm-test-'));
}

describe('TaskManager', () => {
  let dir, config, logger, parser, tm;

  beforeEach(() => {
    dir = tempDir();
    config = new ConfigManager(dir, 'test');
    logger = new Logger(dir);
    parser = new CronParser();
    tm = new TaskManager(config, logger, parser);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ─── Add Task ───
  describe('addTask()', () => {
    it('should add a task', () => {
      const r = tm.addTask({ Name: 'Test', CronExpression: '0 5 * * *', ScriptPath: 'test.ps1' });
      expect(r.success).to.be.true;
      expect(r.task.Name).to.equal('Test');
      expect(r.task.Id).to.be.a('string');
    });

    it('should persist to file', () => {
      tm.addTask({ Name: 'Persist', CronExpression: '* * * * *', ScriptPath: 'x.ps1' });
      const tm2 = new TaskManager(config, logger, parser);
      expect(tm2.getAllTasks()).to.have.length(1);
    });

    it('should add multiple tasks', () => {
      tm.addTask({ Name: 'T1', CronExpression: '* * * * *', ScriptPath: 'a.ps1' });
      tm.addTask({ Name: 'T2', CronExpression: '0 * * * *', ScriptPath: 'b.ps1' });
      expect(tm.getAllTasks()).to.have.length(2);
    });
  });

  // ─── Update Task ───
  describe('updateTask()', () => {
    it('should update an existing task', () => {
      const r = tm.addTask({ Name: 'Original', CronExpression: '0 0 * * *', ScriptPath: 'x.ps1' });
      const id = r.task.Id;
      tm.updateTask({ Id: id, Name: 'Updated', CronExpression: '0 1 * * *', ScriptPath: 'x.ps1' });
      const tasks = tm.getAllTasks();
      const task = tasks.find(t => t.Id === id);
      expect(task.Name).to.equal('Updated');
      expect(task.CronExpression).to.equal('0 1 * * *');
    });

    it('should return error for non-existent task', () => {
      const r = tm.updateTask({ Id: 'fake-id', Name: 'X' });
      expect(r.success).to.be.false;
    });
  });

  // ─── Delete Task ───
  describe('deleteTask()', () => {
    it('should delete a task', () => {
      const r = tm.addTask({ Name: 'ToDelete', CronExpression: '* * * * *', ScriptPath: 'x.ps1' });
      const dr = tm.deleteTask(r.task.Id);
      expect(dr.success).to.be.true;
      expect(tm.getAllTasks()).to.have.length(0);
    });

    it('should return error for non-existent task', () => {
      const r = tm.deleteTask('no-such-id');
      expect(r.success).to.be.false;
    });
  });

  // ─── GetTask ───
  describe('getTask()', () => {
    it('should find existing task', () => {
      const r = tm.addTask({ Name: 'Findable', CronExpression: '0 0 * * *', ScriptPath: 'x.ps1' });
      const task = tm.getTask(r.task.Id);
      expect(task).to.not.be.null;
      expect(task.Name).to.equal('Findable');
    });

    it('should return null for non-existent task', () => {
      expect(tm.getTask('nope')).to.be.null;
    });
  });

  // ─── GetAllTasks ───
  describe('getAllTasks()', () => {
    it('should return empty array initially', () => {
      expect(tm.getAllTasks()).to.be.an('array').that.is.empty;
    });

    it('should return all tasks', () => {
      tm.addTask({ Name: 'A', CronExpression: '0 0 * * *', ScriptPath: 'a.ps1' });
      tm.addTask({ Name: 'B', CronExpression: '0 1 * * *', ScriptPath: 'b.ps1' });
      expect(tm.getAllTasks()).to.have.length(2);
    });
  });

  // ─── Execute Task ───
  describe('executeTask()', () => {
    it('should execute and record in history', async () => {
      tm.addTask({ Name: 'Exec Test', CronExpression: '0 0 * * *', ScriptPath: 'nonexistent.ps1' });
      const task = tm.getAllTasks()[0];
      const result = await tm.executeTask(task);
      expect(result.Status).to.equal('Error'); // Script doesn't exist
      expect(result.TaskName).to.equal('Exec Test');
    });

    it('should record history entry', async () => {
      tm.addTask({ Name: 'Hist Test', CronExpression: '0 0 * * *', ScriptPath: 'nonexistent.ps1' });
      const task = tm.getAllTasks()[0];
      await tm.executeTask(task);
      const history = tm.getHistory();
      expect(history.length).to.be.greaterThan(0);
      expect(history[0].TaskName).to.equal('Hist Test');
    });
  });

  // ─── GetDueTasks ───
  describe('getDueTasks()', () => {
    it('should return tasks matching current time', () => {
      tm.addTask({ Name: 'Always', CronExpression: '* * * * *', ScriptPath: 'x.ps1', Enabled: true });
      const due = tm.getDueTasks();
      expect(due.length).to.equal(1);
    });

    it('should not return disabled tasks', () => {
      tm.addTask({ Name: 'Disabled', CronExpression: '* * * * *', ScriptPath: 'x.ps1', Enabled: false });
      const due = tm.getDueTasks();
      expect(due.length).to.equal(0);
    });
  });

  // ─── Export/Import ───
  describe('exportTasks()', () => {
    it('should export tasks to JSON file', () => {
      tm.addTask({ Name: 'Export Test', CronExpression: '0 0 * * *', ScriptPath: 'x.ps1' });
      const out = path.join(dir, 'export.json');
      const r = tm.exportTasks(out);
      expect(r.success).to.be.true;
      expect(fs.existsSync(out)).to.be.true;
      const data = JSON.parse(fs.readFileSync(out, 'utf8'));
      expect(data.length).to.equal(1);
    });
  });

  describe('importTasks()', () => {
    it('should import tasks from JSON', () => {
      const importFile = path.join(dir, 'import.json');
      fs.writeFileSync(importFile, JSON.stringify([
        { Id: 'imported-1', Name: 'Imported', CronExpression: '*/5 * * * *', ScriptPath: 'imp.ps1' }
      ]));
      const r = tm.importTasks(importFile);
      expect(r.success).to.be.true;
      expect(r.count).to.equal(1);
      expect(tm.getAllTasks()).to.have.length(1);
    });

    it('should not duplicate existing tasks', () => {
      tm.addTask({ Id: 'existing-1', Name: 'Existing', CronExpression: '0 0 * * *', ScriptPath: 'x.ps1' });
      const importFile = path.join(dir, 'import.json');
      fs.writeFileSync(importFile, JSON.stringify([
        { Id: 'existing-1', Name: 'Duplicate', CronExpression: '0 1 * * *', ScriptPath: 'x.ps1' }
      ]));
      tm.importTasks(importFile);
      expect(tm.getAllTasks()).to.have.length(1);
    });
  });

  // ─── Export History ───
  describe('exportHistory()', () => {
    it('should export history as CSV', async () => {
      tm.addTask({ Name: 'CSV Test', CronExpression: '0 0 * * *', ScriptPath: 'nonexistent.ps1' });
      await tm.executeTask(tm.getAllTasks()[0]);
      const csv = path.join(dir, 'history.csv');
      const r = tm.exportHistory(csv);
      expect(r.success).to.be.true;
      expect(fs.existsSync(csv)).to.be.true;
      const content = fs.readFileSync(csv, 'utf8');
      expect(content).to.include('Timestamp');
      expect(content).to.include('CSV Test');
    });
  });

  // ─── Persistence ───
  describe('persistence', () => {
    it('should survive manager recreation', () => {
      tm.addTask({ Name: 'Survivor', CronExpression: '0 0 * * *', ScriptPath: 'x.ps1' });
      const tm2 = new TaskManager(config, logger, parser);
      expect(tm2.getAllTasks()).to.have.length(1);
      expect(tm2.getAllTasks()[0].Name).to.equal('Survivor');
    });

    it('should preserve history after recreation', async () => {
      tm.addTask({ Name: 'Hist', CronExpression: '0 0 * * *', ScriptPath: 'nonexistent.ps1' });
      await tm.executeTask(tm.getAllTasks()[0]);
      const tm2 = new TaskManager(config, logger, parser);
      expect(tm2.getHistory().length).to.be.greaterThan(0);
    });
  });
});
