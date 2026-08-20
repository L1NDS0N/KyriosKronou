// CronParser.js - Cron Expression Parser
class CronParser {
  constructor() {
    this.validRanges = {
      minute: { min: 0, max: 59 },
      hour: { min: 0, max: 23 },
      dayOfMonth: { min: 1, max: 31 },
      month: { min: 1, max: 12 },
      dayOfWeek: { min: 0, max: 7 }
    };

    this.monthNames = {
      jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
      jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    };

    this.dayNames = {
      sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
    };
  }

  validate(expression) {
    if (!expression || typeof expression !== 'string') return false;
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const fields = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'];
    for (let i = 0; i < 5; i++) {
      const range = this.validRanges[fields[i]];
      if (!this.validateField(parts[i], range.min, range.max)) return false;
    }
    return true;
  }

  validateField(value, min, max) {
    if (!value) return false;
    if (value === '*') return true;

    // Step: */5
    if (value.includes('/')) {
      const [base, step] = value.split('/');
      if (base !== '*' && !this.parseValue(base, min, max)) return false;
      const stepNum = parseInt(step, 10);
      if (isNaN(stepNum) || stepNum < 1) return false;
      return true;
    }

    // Range: 1-5
    if (value.includes('-')) {
      const [start, end] = value.split('-');
      const s = this.parseValue(start, min, max);
      const e = this.parseValue(end, min, max);
      if (s < 0 || e < 0 || s > e) return false;
      return true;
    }

    // List: 1,3,5
    if (value.includes(',')) {
      const items = value.split(',');
      return items.every(item => this.validateField(item.trim(), min, max));
    }

    // Single value
    const num = this.parseValue(value, min, max);
    return num >= min && num <= max;
  }

  parseValue(value, min, max) {
    if (!value) return -1;
    const trimmed = value.trim().toLowerCase();

    // Month name
    if (this.monthNames[trimmed] !== undefined) {
      return this.monthNames[trimmed];
    }

    // Day name
    if (this.dayNames[trimmed] !== undefined) {
      return this.dayNames[trimmed];
    }

    const num = parseInt(trimmed, 10);
    if (isNaN(num)) return -1;
    if (num < min || num > max) return -1;
    return num;
  }

  matchesField(currentValue, fieldExpression, min, max) {
    if (fieldExpression === '*') return true;

    // Step: */5
    if (fieldExpression.includes('/')) {
      const [, stepStr] = fieldExpression.split('/');
      const step = parseInt(stepStr, 10);
      return currentValue % step === 0;
    }

    // Range: 1-5
    if (fieldExpression.includes('-')) {
      const [start, end] = fieldExpression.split('-').map(v => parseInt(v, 10));
      return currentValue >= start && currentValue <= end;
    }

    // List: 1,3,5
    if (fieldExpression.includes(',')) {
      const values = fieldExpression.split(',').map(v => parseInt(v.trim(), 10));
      return values.includes(currentValue);
    }

    // Single value
    return currentValue === parseInt(fieldExpression, 10);
  }

  shouldRunAt(expression, date) {
    const parts = expression.trim().split(/\s+/);
    if (parts.length !== 5) return false;

    const fields = ['minute', 'hour', 'dayOfMonth', 'month', 'dayOfWeek'];
    const values = [
      date.getMinutes(),
      date.getHours(),
      date.getDate(),
      date.getMonth() + 1,
      date.getDay()
    ];

    for (let i = 0; i < 5; i++) {
      if (!this.matchesField(values[i], parts[i], this.validRanges[fields[i]].min, this.validRanges[fields[i]].max)) {
        return false;
      }
    }
    return true;
  }

  shouldRunNow(expression) {
    return this.shouldRunAt(expression, new Date());
  }

  getNextRunTime(expression, after) {
    if (!after) after = new Date();
    let candidate = new Date(after);
    candidate.setSeconds(0);
    candidate.setMilliseconds(0);
    candidate.setMinutes(candidate.getMinutes() + 1);

    // Search up to 2 years ahead
    const maxIterations = 365 * 24 * 60;
    for (let i = 0; i < maxIterations; i++) {
      if (this.shouldRunAt(expression, candidate)) {
        return candidate;
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return null;
  }

  getDescription(expression) {
    if (!this.validate(expression)) return 'Invalid expression';

    const parts = expression.trim().split(/\s+/);
    const [min, hour, dom, month, dow] = parts;

    if (min === '*' && hour === '*') return 'Every minute';
    if (min.startsWith('*/')) return `Every ${min.replace('*/', '')} minutes`;
    if (hour.startsWith('*/')) return `Every ${hour.replace('*/', '')} hours`;

    let desc = 'At ';
    if (min !== '*') desc += min;
    else desc += '0';
    desc += ':';
    if (hour !== '*') desc += hour.padStart(2, '0');
    else desc += '00';

    if (dom !== '*' && month !== '*') desc += `, day ${dom} of month ${month}`;
    else if (dom !== '*') desc += `, day ${dom}`;
    else if (month !== '*') desc += ` in month ${month}`;

    if (dow !== '*') {
      const dayMap = { '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday', '4': 'Thursday', '5': 'Friday', '6': 'Saturday', '7': 'Sunday' };
      if (dow.includes('-')) {
        const [s, e] = dow.split('-');
        desc += `, ${dayMap[s] || s}-${dayMap[e] || e}`;
      } else {
        desc += `, ${dayMap[dow] || dow}`;
      }
    } else if (dom === '*') {
      desc += ' daily';
    }

    return desc;
  }
}

module.exports = CronParser;
