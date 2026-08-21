// tests/test-config-manager.js
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ConfigManager = require('../src/main/configManager');
const Logger = require('../src/main/logger');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cronmaster-test-'));
}

// ═══ ConfigManager ═══
describe('ConfigManager', () => {
  let dir, config;

  beforeEach(() => {
    dir = tempDir();
    config = new ConfigManager(dir, 'test');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should create profiles directory', () => {
    expect(fs.existsSync(path.join(dir, 'profiles'))).to.be.true;
  });

  it('should set and get a setting', () => {
    config.setSetting('NssmPath', 'C:\\nssm\\nssm.exe');
    expect(config.getSetting('NssmPath')).to.equal('C:\\nssm\\nssm.exe');
  });

  it('should return default for missing setting', () => {
    expect(config.getSetting('Missing', 'fallback')).to.equal('fallback');
  });

  it('should return null for missing setting without default', () => {
    expect(config.getSetting('Missing')).to.be.null;
  });

  it('should save and load profile', () => {
    config.setSetting('TestKey', 'TestValue');
    config.save();
    const config2 = new ConfigManager(dir, 'test');
    expect(config2.getSetting('TestKey')).to.equal('TestValue');
  });

  it('should create new profile', () => {
    const r = config.createProfile('production');
    expect(r.success).to.be.true;
    expect(fs.existsSync(path.join(dir, 'profiles', 'production.json'))).to.be.true;
  });

  it('should fail to create duplicate profile', () => {
    config.createProfile('staging');
    const r = config.createProfile('staging');
    expect(r.success).to.be.false;
  });

  it('should list profiles', () => {
    config.createProfile('dev');
    config.createProfile('prod');
    const list = config.getProfileList();
    expect(list).to.include('test');
    expect(list).to.include('dev');
    expect(list).to.include('prod');
  });

  it('should delete a non-default, non-active profile', () => {
    config.createProfile('tempDel');
    config.loadProfile('test'); // Switch back so tempDel is not active
    const r = config.deleteProfile('tempDel');
    expect(r.success).to.be.true;
    expect(fs.existsSync(path.join(dir, 'profiles', 'tempDel.json'))).to.be.false;
  });

  it('should fail to delete default profile', () => {
    const r = config.deleteProfile('default');
    expect(r.success).to.be.false;
  });

  it('should fail to delete active profile', () => {
    const r = config.deleteProfile('test');
    expect(r.success).to.be.false;
  });

  it('should fail to delete non-existent profile', () => {
    const r = config.deleteProfile('nonexistent');
    expect(r.success).to.be.false;
  });

  it('should switch profiles', () => {
    config.createProfile('other');
    config.loadProfile('other');
    expect(config.currentProfile).to.equal('other');
  });

  it('should set default settings for new profile', () => {
    config.createProfile('fresh');
    config.loadProfile('fresh');
    expect(config.getSetting('NssmPath')).to.equal('nssm');
  });
});

// ═══ Logger ═══
describe('Logger', () => {
  let dir, logger;

  beforeEach(() => {
    dir = tempDir();
    logger = new Logger(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should create log directory', () => {
    expect(fs.existsSync(dir)).to.be.true;
  });

  it('should log messages to memory', () => {
    logger.log('INFO', 'Test message');
    const logs = logger.getRecentLogs();
    expect(logs).to.have.length(1);
    expect(logs[0].level).to.equal('INFO');
    expect(logs[0].message).to.equal('Test message');
  });

  it('should log multiple messages', () => {
    logger.log('INFO', 'Msg 1');
    logger.log('WARN', 'Msg 2');
    logger.log('ERROR', 'Msg 3');
    expect(logger.getRecentLogs()).to.have.length(3);
  });

  it('should respect count limit', () => {
    for (let i = 0; i < 10; i++) logger.log('INFO', `Msg ${i}`);
    expect(logger.getRecentLogs(3)).to.have.length(3);
  });

  it('should flush buffer to file', () => {
    logger.log('INFO', 'Flush test');
    logger.flush();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
    expect(files.length).to.be.greaterThan(0);
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    expect(content).to.include('Flush test');
  });

  it('should not flush empty buffer', () => {
    logger.flush(); // No-op, should not throw
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
    expect(files.length).to.equal(0);
  });

  it('should get logs by date', () => {
    logger.log('INFO', 'Today');
    const today = new Date();
    const logs = logger.getLogsFromDate(today);
    expect(logs.length).to.be.greaterThan(0);
  });

  it('should export logs as text', () => {
    logger.log('INFO', 'Export test');
    logger.flush();
    const outFile = path.join(dir, 'export.txt');
    logger.exportLogs(outFile, 'text');
    expect(fs.existsSync(outFile)).to.be.true;
    expect(fs.readFileSync(outFile, 'utf8')).to.include('Export test');
  });

  it('should export logs as CSV', () => {
    logger.log('INFO', 'CSV test');
    logger.flush();
    const outFile = path.join(dir, 'export.csv');
    logger.exportLogs(outFile, 'csv');
    expect(fs.existsSync(outFile)).to.be.true;
    const content = fs.readFileSync(outFile, 'utf8');
    expect(content).to.include('timestamp,level,message');
    expect(content).to.include('CSV test');
  });

  it('should export logs as JSON', () => {
    logger.log('INFO', 'JSON test');
    logger.flush();
    const outFile = path.join(dir, 'export.json');
    logger.exportLogs(outFile, 'json');
    expect(fs.existsSync(outFile)).to.be.true;
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    expect(data).to.be.an('array');
    expect(data[0].message).to.equal('JSON test');
  });
});
