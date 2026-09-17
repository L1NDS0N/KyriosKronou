// tests/test-schedule-advisor.js
//
// Two heavy jobs firing in the same minute is a real operational problem - a
// backup and a task both hitting the same database at 02:00 turn a fast night
// into a slow one - and nothing used to warn about it. This compares actual
// fire times rather than expression text, so "0 2 * * *" and "*/30 2 * * *"
// are correctly seen as colliding.

const { expect } = require('chai');
const CronParser = require('../src/main/cronParser');
const advisor = require('../src/main/scheduleAdvisor');

const cron = new CronParser();

// A fixed Monday so weekday expressions behave the same on every run.
const MONDAY = new Date('2026-01-05T00:00:00');

const opts = { from: MONDAY, horizonHours: 48 };

describe('Schedule advisor: fire times', () => {
  it('computes when an expression actually fires', () => {
    const times = advisor.fireTimes(cron, '0 2 * * *', opts);
    expect(times.size).to.equal(2); // 48h horizon, once a day
  });

  it('returns nothing for an invalid expression rather than throwing', () => {
    expect(advisor.fireTimes(cron, 'nonsense', opts).size).to.equal(0);
    expect(advisor.fireTimes(cron, '', opts).size).to.equal(0);
    expect(advisor.fireTimes(cron, null, opts).size).to.equal(0);
  });

  it('caps samples so a per-minute schedule cannot run unbounded', () => {
    const times = advisor.fireTimes(cron, '* * * * *', { from: MONDAY, horizonHours: 24 * 7 });
    expect(times.size).to.be.at.most(advisor.MAX_SAMPLES);
  });
});

describe('Schedule advisor: conflicts', () => {
  const schedules = [
    { id: 'a', name: 'Backup noturno', cron: '0 2 * * *', kind: 'backup' },
    { id: 'b', name: 'Limpeza', cron: '0 3 * * *', kind: 'task' },
    { id: 'c', name: 'Sincronismo', cron: '*/30 * * * *', kind: 'task' },
  ];

  it('finds an exact collision', () => {
    const found = advisor.findConflicts(cron, '0 2 * * *', schedules, opts);
    expect(found.map(c => c.id)).to.include('a');
  });

  // The whole reason for comparing fire times instead of expression text.
  it('finds a collision between differently written expressions', () => {
    const found = advisor.findConflicts(cron, '0 2 * * *', [
      { id: 'x', name: 'Meia em meia hora', cron: '*/30 2 * * *', kind: 'task' },
    ], opts);
    expect(found).to.have.length(1);
    expect(found[0].id).to.equal('x');
  });

  it('reports nothing when the times do not overlap', () => {
    const found = advisor.findConflicts(cron, '17 4 * * *', [
      { id: 'a', name: 'Backup', cron: '0 2 * * *', kind: 'backup' },
    ], opts);
    expect(found).to.deep.equal([]);
  });

  it('never reports the item being edited against itself', () => {
    const found = advisor.findConflicts(cron, '0 2 * * *', schedules, { ...opts, excludeId: 'a' });
    expect(found.map(c => c.id)).to.not.include('a');
  });

  it('includes the name and kind, so the warning names the culprit', () => {
    const [first] = advisor.findConflicts(cron, '0 2 * * *', schedules, opts);
    expect(first.name).to.be.a('string').with.length.above(0);
    expect(['task', 'backup']).to.include(first.kind);
    expect(first.cron).to.be.a('string');
    expect(new Date(first.at).toString()).to.not.equal('Invalid Date');
  });

  it('lists the soonest collision first', () => {
    const found = advisor.findConflicts(cron, '0 2,3 * * *', schedules, opts);
    expect(found.length).to.be.above(1);
    for (let i = 1; i < found.length; i++) {
      expect(new Date(found[i].at) >= new Date(found[i - 1].at)).to.equal(true);
    }
  });

  it('ignores schedules with no expression', () => {
    const found = advisor.findConflicts(cron, '0 2 * * *', [
      { id: 'x', name: 'Sem cron', cron: '', kind: 'task' },
      { id: 'y', name: 'Nulo', kind: 'task' },
      null,
    ], opts);
    expect(found).to.deep.equal([]);
  });
});

describe('Schedule advisor: suggesting a free slot', () => {
  const busy = [
    { id: 'a', name: 'Backup', cron: '0 2 * * *', kind: 'backup' },
    { id: 'b', name: 'Relatório', cron: '1 2 * * *', kind: 'task' },
  ];

  it('moves only the minute, so the chosen hour and day are respected', () => {
    const suggestion = advisor.suggestFreeSlot(cron, '0 2 * * *', busy, { ...opts, excludeId: null });
    expect(suggestion).to.not.equal(null);
    const parts = suggestion.expression.split(' ');
    expect(parts.slice(1)).to.deep.equal(['2', '*', '*', '*'], 'hour and day must not change');
    expect(parts[0]).to.not.equal('0');
  });

  it('suggests a minute that really is free', () => {
    const suggestion = advisor.suggestFreeSlot(cron, '0 2 * * *', busy, opts);
    const remaining = advisor.findConflicts(cron, suggestion.expression, busy, opts);
    expect(remaining).to.deep.equal([]);
  });

  it('stays close to the time the user asked for', () => {
    const suggestion = advisor.suggestFreeSlot(cron, '0 2 * * *', busy, opts);
    // 0 and 1 are taken, so 59 or 2 are the nearest; either is one or two away.
    expect(suggestion.movedBy).to.be.at.most(2);
  });

  // Offering to "fix" */5 by nudging a minute would be dishonest.
  it('offers nothing when the minute is not a single fixed value', () => {
    expect(advisor.suggestFreeSlot(cron, '*/5 * * * *', busy, opts)).to.equal(null);
    expect(advisor.suggestFreeSlot(cron, '* * * * *', busy, opts)).to.equal(null);
    expect(advisor.suggestFreeSlot(cron, '0,30 2 * * *', busy, opts)).to.equal(null);
  });

  it('offers nothing for a malformed expression', () => {
    expect(advisor.suggestFreeSlot(cron, 'garbage', busy, opts)).to.equal(null);
    expect(advisor.suggestFreeSlot(cron, '', busy, opts)).to.equal(null);
  });
});

describe('Schedule advisor: collecting what is scheduled', () => {
  it('merges tasks and backup profiles into one list', () => {
    const list = advisor.collectSchedules(
      [{ Id: 't1', Name: 'Tarefa', CronExpression: '0 1 * * *', Enabled: true }],
      [{ Id: 'b1', Name: 'Backup', CronExpression: '0 2 * * *', Enabled: true }]
    );
    expect(list).to.have.length(2);
    expect(list.map(s => s.kind)).to.have.members(['task', 'backup']);
  });

  // A disabled item never fires, so warning about it would be noise.
  it('skips disabled items', () => {
    const list = advisor.collectSchedules(
      [{ Id: 't1', Name: 'Off', CronExpression: '0 1 * * *', Enabled: false }],
      [{ Id: 'b1', Name: 'Off', CronExpression: '0 2 * * *', Enabled: false }]
    );
    expect(list).to.deep.equal([]);
  });

  it('skips items with no schedule', () => {
    const list = advisor.collectSchedules(
      [{ Id: 't1', Name: 'Sem cron', Enabled: true }],
      [{ Id: 'b1', Name: 'Sem cron', Enabled: true }]
    );
    expect(list).to.deep.equal([]);
  });

  it('treats a task with no Enabled field as enabled, matching the scheduler', () => {
    const list = advisor.collectSchedules([{ Id: 't1', Name: 'Legacy', CronExpression: '0 1 * * *' }], []);
    expect(list).to.have.length(1);
  });

  it('handles missing arguments', () => {
    expect(advisor.collectSchedules(null, null)).to.deep.equal([]);
    expect(advisor.collectSchedules(undefined, undefined)).to.deep.equal([]);
  });
});
