// tests/test-service-manager.js
const { expect } = require('chai');
const Logger = require('../src/main/logger');
const ServiceManager = require('../src/main/serviceManager');
const fs = require('fs');
const os = require('os');
const path = require('path');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cronmaster-svc-test-'));
}

describe('ServiceManager', () => {
  let dir, logger, svc;

  beforeEach(() => {
    dir = tempDir();
    logger = new Logger(dir);
    svc = new ServiceManager(logger);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ─── CheckNssm ───
  describe('checkNssm()', () => {
    it('should return not installed for fake path', () => {
      const r = svc.checkNssm('C:\\nonexistent\\nssm.exe');
      expect(r.installed).to.be.false;
    });

    it('should return not installed for nonexistent command', () => {
      const r = svc.checkNssm('nonexistent_nssm_cmd');
      expect(r.installed).to.be.false;
    });
  });

  // ─── Install/Start/Stop without NSSM ───
  describe('service operations without NSSM', () => {
    it('installService should fail gracefully', () => {
      svc.nssmPath = 'nonexistent_nssm';
      const r = svc.installService('test', 'notepad.exe', '', '', 'Automatic');
      expect(r.success).to.be.false;
    });

    it('startService should fail gracefully', () => {
      svc.nssmPath = 'nonexistent_nssm';
      const r = svc.startService('test');
      expect(r.success).to.be.false;
    });

    it('stopService should fail gracefully', () => {
      svc.nssmPath = 'nonexistent_nssm';
      const r = svc.stopService('test');
      expect(r.success).to.be.false;
    });

    it('restartService should fail gracefully', () => {
      svc.nssmPath = 'nonexistent_nssm';
      const r = svc.restartService('test');
      expect(r.success).to.be.false;
    });

    it('uninstallService should fail gracefully', () => {
      svc.nssmPath = 'nonexistent_nssm';
      const r = svc.uninstallService('test');
      expect(r.success).to.be.false;
    });
  });

  // ─── GetAllServices ───
  describe('getAllServices()', () => {
    it('should return empty array without NSSM', () => {
      svc.nssmPath = 'nonexistent_nssm';
      const services = svc.getAllServices();
      expect(services).to.be.an('array').that.is.empty;
    });
  });

  // ─── GetServiceCount ───
  describe('getServiceCount()', () => {
    it('should return 0 without NSSM', () => {
      svc.nssmPath = 'nonexistent_nssm';
      expect(svc.getServiceCount()).to.equal(0);
    });
  });

  // ─── GetServiceInfo ───
  describe('getServiceInfo()', () => {
    it('should return null for non-existent service without NSSM', () => {
      svc.nssmPath = 'nonexistent_nssm';
      const info = svc.getServiceInfo('test');
      // When nssm fails entirely, service doesn't exist → null
      expect(info).to.be.null;
    });

    it('should return null for empty name', () => {
      const info = svc.getServiceInfo('');
      expect(info).to.be.null;
    });

    it('should return null for null name', () => {
      const info = svc.getServiceInfo(null);
      expect(info).to.be.null;
    });
  });
});
