// tests/test-calendar-data.js
//
// Tasks, backups and service-managed jobs each lived on their own screen, so
// nobody could see the night as a whole. This lays them on one timeline: the
// future projected from cron, the past taken from history - because what
// actually ran matters more than what was meant to.

const { expect } = require('chai');
const CronParser = require('../src/main/cronParser');
const calendar = require('../src/main/calendarData');

const cron = new CronParser();

// A fixed Monday so weekday expressions behave identically on every run.
const MONDAY = new Date('2026-01-05T00:00:00');
const day = (n) => new Date(2026, 0, n, 12, 0, 0);

describe('Calendar: collecting what is scheduled', () => {
  it('merges tasks and backup profiles', () => {
    const sources = calendar.collectSources(
      [{ Id: 't1', Name: 'Limpeza', CronExpression: '0 3 * * *', Enabled: true }],
      [{ Id: 'b1', Name: 'Backup', CronExpression: '0 2 * * *', Enabled: true }]
    );
    expect(sources).to.have.length(2);
    expect(sources.map(s => s.kind)).to.have.members(['task', 'backup']);
  });

  // An NSSM-managed task runs as its own Windows service, so it belongs on the
  // services screen, not the tasks one.
  it('treats an NSSM-managed task as a service and links to that screen', () => {
    const [source] = calendar.collectSources(
      [{ Id: 't1', Name: 'Serviço', CronExpression: '0 3 * * *', Enabled: true, ManagementMode: 'nssm' }], []
    );
    expect(source.kind).to.equal('service');
    expect(source.page).to.equal('services');
  });

  it('carries the screen each item belongs to, so the calendar can link out', () => {
    const sources = calendar.collectSources(
      [{ Id: 't1', Name: 'T', CronExpression: '0 3 * * *', Enabled: true }],
      [{ Id: 'b1', Name: 'B', CronExpression: '0 2 * * *', Enabled: true }]
    );
    expect(sources.find(s => s.kind === 'task').page).to.equal('tasks');
    expect(sources.find(s => s.kind === 'backup').page).to.equal('backup');
  });

  it('skips anything without a schedule', () => {
    expect(calendar.collectSources([{ Id: 't1', Name: 'Sem cron' }], [{ Id: 'b1', Name: 'Sem cron' }])).to.deep.equal([]);
  });

  it('handles missing arguments', () => {
    expect(calendar.collectSources(null, undefined)).to.deep.equal([]);
  });
});

describe('Calendar: projecting the future', () => {
  const sources = [
    { id: 't1', name: 'Diária', cron: '0 3 * * *', enabled: true, kind: 'task', page: 'tasks' },
    { id: 'b1', name: 'Noturno', cron: '0 2 * * *', enabled: true, kind: 'backup', page: 'backup' },
  ];

  it('places an occurrence on each day the expression fires', () => {
    // build() normalises to the end of the day; this lower-level function takes
    // the boundaries it is given, so the test supplies one.
    const to = calendar.endOfDay(new Date(MONDAY.getFullYear(), MONDAY.getMonth(), MONDAY.getDate() + 2));
    const occurrences = calendar.futureOccurrences(cron, sources, MONDAY, to);
    expect(occurrences.filter(o => o.id === 't1')).to.have.length(3);
  });

  it('leaves out disabled items, which will never fire', () => {
    const off = [{ ...sources[0], enabled: false }];
    const to = new Date(MONDAY); to.setDate(to.getDate() + 2);
    expect(calendar.futureOccurrences(cron, off, MONDAY, to)).to.deep.equal([]);
  });

  it('can include disabled items when asked, for planning', () => {
    const off = [{ ...sources[0], enabled: false }];
    const to = new Date(MONDAY); to.setDate(to.getDate() + 1);
    const occurrences = calendar.futureOccurrences(cron, off, MONDAY, to, { includeDisabled: true });
    expect(occurrences.length).to.be.above(0);
    expect(occurrences[0].enabled).to.equal(false);
  });

  it('ignores an invalid expression rather than throwing', () => {
    const bad = [{ id: 'x', name: 'Ruim', cron: 'nonsense', enabled: true, kind: 'task', page: 'tasks' }];
    const to = new Date(MONDAY); to.setDate(to.getDate() + 1);
    expect(calendar.futureOccurrences(cron, bad, MONDAY, to)).to.deep.equal([]);
  });

  // A per-minute cron would otherwise produce 1440 entries a day.
  it('caps how much a single source can generate', () => {
    const noisy = [{ id: 'x', name: 'Cada minuto', cron: '* * * * *', enabled: true, kind: 'task', page: 'tasks' }];
    const to = new Date(MONDAY); to.setDate(to.getDate() + 7);
    const occurrences = calendar.futureOccurrences(cron, noisy, MONDAY, to);
    expect(occurrences.length).to.be.at.most(calendar.MAX_OCCURRENCES_PER_SOURCE);
  });

  it('groups by local day, not UTC, so a late-evening run lands on the right date', () => {
    const late = [{ id: 'x', name: 'Noite', cron: '0 23 * * *', enabled: true, kind: 'task', page: 'tasks' }];
    const to = new Date(MONDAY); to.setDate(to.getDate() + 1);
    const [first] = calendar.futureOccurrences(cron, late, MONDAY, to);
    const local = new Date(first.at);
    expect(first.day).to.equal(calendar.dayKey(local));
    expect(local.getHours()).to.equal(23);
  });
});

describe('Calendar: the past comes from history', () => {
  const taskHistory = [
    { Id: 'h1', TaskId: 't1', TaskName: 'Limpeza', Timestamp: day(6).toISOString(), Status: 'Success', Duration: '2.1s' },
    { Id: 'h2', TaskId: 't1', TaskName: 'Limpeza', Timestamp: day(7).toISOString(), Status: 'Error', Duration: '0.3s', Message: 'boom' },
  ];
  const backupHistory = [
    { Id: 'h3', ProfileId: 'b1', ProfileName: 'Noturno', Timestamp: day(6).toISOString(), Status: 'Success', Duration: '9s', TotalSizeHuman: '12 MB' },
  ];

  it('reports what ran, with its outcome', () => {
    const occurrences = calendar.pastOccurrences(taskHistory, backupHistory, day(1), day(10));
    expect(occurrences).to.have.length(3);
    expect(occurrences.filter(o => o.state === 'success')).to.have.length(2);
    expect(occurrences.filter(o => o.state === 'failed')).to.have.length(1);
  });

  it('keeps the link back to the item, so history entries are clickable too', () => {
    const [first] = calendar.pastOccurrences(taskHistory, [], day(1), day(10));
    expect(first.id).to.equal('t1');
    expect(first.page).to.equal('tasks');
  });

  it('ignores entries outside the range', () => {
    expect(calendar.pastOccurrences(taskHistory, backupHistory, day(20), day(25))).to.deep.equal([]);
  });

  it('survives malformed history rows', () => {
    const junk = [null, {}, { Timestamp: 'not a date' }];
    expect(() => calendar.pastOccurrences(junk, junk, day(1), day(10))).to.not.throw();
    expect(calendar.pastOccurrences(junk, junk, day(1), day(10))).to.deep.equal([]);
  });
});

describe('Calendar: building a range', () => {
  const data = {
    tasks: [{ Id: 't1', Name: 'Limpeza', CronExpression: '0 3 * * *', Enabled: true }],
    profiles: [{ Id: 'b1', Name: 'Noturno', CronExpression: '0 2 * * *', Enabled: true }],
    taskHistory: [],
    backupHistory: [],
  };

  it('groups occurrences by day', () => {
    const from = new Date();
    const to = new Date(); to.setDate(to.getDate() + 3);
    const result = calendar.build(cron, data, { from, to });

    expect(result.days).to.be.an('object');
    for (const [key, items] of Object.entries(result.days)) {
      expect(key).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(items).to.be.an('array').with.length.above(0);
    }
  });

  it('returns totals the UI can show without recounting', () => {
    const from = new Date();
    const to = new Date(); to.setDate(to.getDate() + 3);
    const result = calendar.build(cron, data, { from, to });
    expect(result.totals.sources).to.equal(2);
    expect(result.totals.scheduled).to.be.above(0);
  });

  it('projects nothing into the past and reads no history from the future', () => {
    const from = new Date(); from.setDate(from.getDate() + 1);
    const to = new Date(); to.setDate(to.getDate() + 3);
    const result = calendar.build(cron, data, { from, to });
    const all = Object.values(result.days).flat();
    expect(all.every(o => o.state === 'scheduled')).to.equal(true);
  });

  it('sorts a day chronologically, so the timeline reads top to bottom', () => {
    const from = new Date();
    const to = new Date(); to.setDate(to.getDate() + 2);
    const result = calendar.build(cron, data, { from, to });
    for (const items of Object.values(result.days)) {
      for (let i = 1; i < items.length; i++) {
        expect(new Date(items[i].at) >= new Date(items[i - 1].at)).to.equal(true);
      }
    }
  });

  it('counts load per hour, for spotting the crowded parts of the night', () => {
    const from = new Date();
    const to = new Date(); to.setDate(to.getDate() + 3);
    const hours = calendar.hourHistogram(calendar.build(cron, data, { from, to }));
    expect(hours).to.have.length(24);
    expect(hours.reduce((a, b) => a + b, 0)).to.be.above(0);
  });

  it('never throws on empty data', () => {
    const from = new Date();
    const to = new Date(); to.setDate(to.getDate() + 1);
    const result = calendar.build(cron, { tasks: [], profiles: [], taskHistory: [], backupHistory: [] }, { from, to });
    expect(result.days).to.deep.equal({});
    expect(result.totals.sources).to.equal(0);
  });
});
