// tests/test-cron-parser.js
const { expect } = require('chai');
const CronParser = require('../src/main/cronParser');

describe('CronParser', () => {
  let parser;

  beforeEach(() => { parser = new CronParser(); });

  // ─── Validate ───
  describe('validate()', () => {
    it('should accept valid expression: * * * * *', () => {
      expect(parser.validate('* * * * *')).to.be.true;
    });
    it('should accept: 0 2 * * *', () => {
      expect(parser.validate('0 2 * * *')).to.be.true;
    });
    it('should accept: */15 * * * *', () => {
      expect(parser.validate('*/15 * * * *')).to.be.true;
    });
    it('should accept: 0 9-17 * * 1-5', () => {
      expect(parser.validate('0 9-17 * * 1-5')).to.be.true;
    });
    it('should accept: 1,15,30 * * * *', () => {
      expect(parser.validate('1,15,30 * * * *')).to.be.true;
    });
    it('should accept: 30 4 * * 0', () => {
      expect(parser.validate('30 4 * * 0')).to.be.true;
    });
    it('should reject: empty string', () => {
      expect(parser.validate('')).to.be.false;
    });
    it('should reject: null', () => {
      expect(parser.validate(null)).to.be.false;
    });
    it('should reject: too few parts', () => {
      expect(parser.validate('* * *')).to.be.false;
    });
    it('should reject: too many parts', () => {
      expect(parser.validate('* * * * * *')).to.be.false;
    });
    it('should reject: minute 60', () => {
      expect(parser.validate('60 * * * *')).to.be.false;
    });
    it('should reject: hour 25', () => {
      expect(parser.validate('0 25 * * *')).to.be.false;
    });
    it('should reject: month 13', () => {
      expect(parser.validate('0 0 * 13 *')).to.be.false;
    });
    it('should reject: day 0', () => {
      expect(parser.validate('0 0 0 * *')).to.be.false;
    });
    it('should reject: text in numeric field', () => {
      expect(parser.validate('abc * * * *')).to.be.false;
    });
  });

  // ─── validateField ───
  describe('validateField()', () => {
    it('should accept *', () => {
      expect(parser.validateField('*', 0, 59)).to.be.true;
    });
    it('should accept single value in range', () => {
      expect(parser.validateField('30', 0, 59)).to.be.true;
    });
    it('should reject single value out of range', () => {
      expect(parser.validateField('99', 0, 59)).to.be.false;
    });
    it('should accept range', () => {
      expect(parser.validateField('1-5', 0, 59)).to.be.true;
    });
    it('should reject inverted range', () => {
      expect(parser.validateField('5-1', 0, 59)).to.be.false;
    });
    it('should accept step', () => {
      expect(parser.validateField('*/15', 0, 59)).to.be.true;
    });
    it('should reject step 0', () => {
      expect(parser.validateField('*/0', 0, 59)).to.be.false;
    });
    it('should accept list', () => {
      expect(parser.validateField('1,15,30', 0, 59)).to.be.true;
    });
    it('should reject list with invalid value', () => {
      expect(parser.validateField('1,15,99', 0, 59)).to.be.false;
    });
  });

  // ─── parseValue ───
  describe('parseValue()', () => {
    it('should parse numeric value', () => {
      expect(parser.parseValue('30', 0, 59)).to.equal(30);
    });
    it('should parse month name (jan)', () => {
      expect(parser.parseValue('jan', 1, 12)).to.equal(1);
    });
    it('should parse month name case-insensitive (MAR)', () => {
      expect(parser.parseValue('MAR', 1, 12)).to.equal(3);
    });
    it('should parse day name (mon)', () => {
      expect(parser.parseValue('mon', 0, 7)).to.equal(1);
    });
    it('should return -1 for out of range', () => {
      expect(parser.parseValue('99', 0, 59)).to.equal(-1);
    });
    it('should return -1 for non-numeric', () => {
      expect(parser.parseValue('xyz', 0, 59)).to.equal(-1);
    });
  });

  // ─── shouldRunAt ───
  describe('shouldRunAt()', () => {
    it('should match: * * * * * (always)', () => {
      const date = new Date(2026, 0, 15, 10, 30, 0);
      expect(parser.shouldRunAt('* * * * *', date)).to.be.true;
    });
    it('should match: 30 10 * * *', () => {
      const date = new Date(2026, 0, 15, 10, 30, 0);
      expect(parser.shouldRunAt('30 10 * * *', date)).to.be.true;
    });
    it('should not match: 30 10 * * * at wrong time', () => {
      const date = new Date(2026, 0, 15, 10, 31, 0);
      expect(parser.shouldRunAt('30 10 * * *', date)).to.be.false;
    });
    it('should match range: 0 9-17 * * 1-5 (weekday)', () => {
      const date = new Date(2026, 0, 19, 12, 0, 0); // Monday
      expect(parser.shouldRunAt('0 9-17 * * 1-5', date)).to.be.true;
    });
    it('should not match range: 0 9-17 * * 1-5 (Sunday)', () => {
      const date = new Date(2026, 0, 18, 12, 0, 0); // Sunday
      expect(parser.shouldRunAt('0 9-17 * * 1-5', date)).to.be.false;
    });
    it('should match step: */15 * * * *', () => {
      const date = new Date(2026, 0, 15, 10, 45, 0);
      expect(parser.shouldRunAt('*/15 * * * *', date)).to.be.true;
    });
    it('should not match step: */15 * * * *', () => {
      const date = new Date(2026, 0, 15, 10, 47, 0);
      expect(parser.shouldRunAt('*/15 * * * *', date)).to.be.false;
    });
    it('should match list: 0 0 * * 0,6 (weekend)', () => {
      const date = new Date(2026, 0, 18, 0, 0, 0); // Sunday
      expect(parser.shouldRunAt('0 0 * * 0,6', date)).to.be.true;
    });
  });

  // ─── shouldRunNow ───
  describe('shouldRunNow()', () => {
    it('should return true for * * * * *', () => {
      expect(parser.shouldRunNow('* * * * *')).to.be.true;
    });
  });

  // ─── getNextRunTime ───
  describe('getNextRunTime()', () => {
    it('should return a future date for * * * * *', () => {
      const next = parser.getNextRunTime('* * * * *');
      expect(next).to.be.an.instanceOf(Date);
      expect(next.getTime()).to.be.greaterThan(Date.now());
    });
    it('should return next occurrence of 0 2 * * *', () => {
      const next = parser.getNextRunTime('0 2 * * *');
      expect(next.getHours()).to.equal(2);
      expect(next.getMinutes()).to.equal(0);
    });
    it('should return null for invalid expression', () => {
      const next = parser.getNextRunTime('invalid');
      expect(next).to.be.null;
    });
  });

  // ─── getDescription ───
  describe('getDescription()', () => {
    it('should describe * * * * *', () => {
      expect(parser.getDescription('* * * * *').toLowerCase()).to.include('every minute');
    });
    it('should describe */15 * * * *', () => {
      expect(parser.getDescription('*/15 * * * *').toLowerCase()).to.include('every 15');
    });
    it('should describe 0 2 * * *', () => {
      expect(parser.getDescription('0 2 * * *')).to.include('02');
    });
    it('should describe invalid as Invalid', () => {
      expect(parser.getDescription('invalid')).to.include('Invalid');
    });
    it('should describe 0 9-17 * * 1-5', () => {
      const desc = parser.getDescription('0 9-17 * * 1-5');
      expect(desc).to.include('Mon');
      expect(desc).to.include('Fri');
    });
  });

  // ─── matchesField ───
  describe('matchesField()', () => {
    it('should match * always', () => {
      expect(parser.matchesField(30, '*', 0, 59)).to.be.true;
    });
    it('should match exact value', () => {
      expect(parser.matchesField(30, '30', 0, 59)).to.be.true;
    });
    it('should not match wrong value', () => {
      expect(parser.matchesField(31, '30', 0, 59)).to.be.false;
    });
    it('should match range', () => {
      expect(parser.matchesField(5, '1-10', 0, 59)).to.be.true;
    });
    it('should not match out of range', () => {
      expect(parser.matchesField(15, '1-10', 0, 59)).to.be.false;
    });
    it('should match step', () => {
      expect(parser.matchesField(30, '*/15', 0, 59)).to.be.true;
    });
    it('should not match non-step', () => {
      expect(parser.matchesField(13, '*/15', 0, 59)).to.be.false;
    });
    it('should match list', () => {
      expect(parser.matchesField(5, '1,5,10', 0, 59)).to.be.true;
    });
    it('should not match outside list', () => {
      expect(parser.matchesField(3, '1,5,10', 0, 59)).to.be.false;
    });
  });
});
