// tests/test-run-registry.js
//
// Until now a task fired and the operator saw nothing until it finished. The
// registry is what makes a run observable while it happens, so what matters is
// that progress is honest, that output cannot grow without bound, and that a
// finished run does not linger forever.

const { expect } = require('chai');
const RunRegistry = require('../src/main/runRegistry');

describe('Run registry: tracking a run', () => {
  let runs;
  beforeEach(() => { runs = new RunRegistry(); });
  afterEach(() => runs.dispose());

  it('reports a started run as active', () => {
    const id = runs.start({ kind: 'task', targetId: 't1', name: 'Backup diário', steps: ['A', 'B'] });
    const active = runs.active();
    expect(active).to.have.length(1);
    expect(active[0].runId).to.equal(id);
    expect(active[0].name).to.equal('Backup diário');
    expect(active[0].status).to.equal('running');
  });

  it('marks the first step as running straight away', () => {
    const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['Um', 'Dois'] });
    const detail = runs.detail(id);
    expect(detail.steps[0].state).to.equal('running');
    expect(detail.steps[1].state).to.equal('pending');
  });

  it('advances progress as steps complete', () => {
    const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A', 'B', 'C', 'D'] });
    const first = runs.detail(id).percent;

    runs.setStep(id, 2);
    const later = runs.detail(id);
    expect(later.percent).to.be.above(first);
    expect(later.steps[0].state).to.equal('done');
    expect(later.steps[1].state).to.equal('done');
    expect(later.steps[2].state).to.equal('running');
    expect(later.steps[3].state).to.equal('pending');
  });

  it('accepts explicit progress for work whose size is known', () => {
    const id = runs.start({ kind: 'backup', targetId: 'b1', name: 'X', steps: ['dump'] });
    runs.setPercent(id, 42, '42 MB');
    expect(runs.detail(id).percent).to.equal(42);
  });

  it('clamps nonsense progress instead of drawing an impossible bar', () => {
    const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A'] });
    runs.setPercent(id, 250);
    expect(runs.detail(id).percent).to.equal(100);
    runs.setPercent(id, -10);
    expect(runs.detail(id).percent).to.equal(0);
  });

  it('finishes at 100% on success', () => {
    const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A', 'B'] });
    runs.finish(id, { success: true, message: 'ok' });
    const detail = runs.detail(id);
    expect(detail.status).to.equal('success');
    expect(detail.percent).to.equal(100);
    expect(detail.steps.every(s => s.state === 'done')).to.equal(true);
  });

  // A failed run must not claim 100%: the bar is a statement about what
  // actually happened.
  it('does not claim 100% when the run failed', () => {
    const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A', 'B', 'C'] });
    runs.finish(id, { success: false, message: 'boom' });
    const detail = runs.detail(id);
    expect(detail.status).to.equal('failed');
    expect(detail.percent).to.be.below(100);
    expect(detail.message).to.equal('boom');
  });

  it('records a failed step without ending the run', () => {
    const id = runs.start({ kind: 'backup', targetId: 'b1', name: 'X', steps: ['db1', 'db2'] });
    runs.failStep(id, 0, 'access denied');
    const detail = runs.detail(id);
    expect(detail.steps[0].state).to.equal('failed');
    expect(detail.steps[0].detail).to.equal('access denied');
    expect(detail.status).to.equal('running');
  });

  it('drops a finished run out of the active list', () => {
    const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A'] });
    expect(runs.active()).to.have.length(1);
    runs.finish(id, { success: true });
    expect(runs.active()).to.have.length(0);
    // But it is still readable, so the viewer can show the final state.
    expect(runs.detail(id)).to.not.equal(null);
  });

  it('finds the run belonging to a task or profile', () => {
    runs.start({ kind: 'task', targetId: 'task-42', name: 'X', steps: ['A'] });
    expect(runs.activeFor('task-42')).to.not.equal(null);
    expect(runs.activeFor('outra')).to.equal(null);
  });

  it('ignores updates to a run that does not exist', () => {
    expect(() => runs.setStep('nope', 1)).to.not.throw();
    expect(() => runs.setPercent('nope', 50)).to.not.throw();
    expect(() => runs.appendOutput('nope', 'x')).to.not.throw();
    expect(() => runs.finish('nope', {})).to.not.throw();
    expect(runs.detail('nope')).to.equal(null);
  });
});

describe('Run registry: live output', () => {
  let runs, id;
  beforeEach(() => {
    runs = new RunRegistry();
    id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A'] });
  });
  afterEach(() => runs.dispose());

  it('splits a chunk into lines', () => {
    runs.appendOutput(id, 'primeira\nsegunda\nterceira');
    expect(runs.detail(id).lines.map(l => l.text)).to.deep.equal(['primeira', 'segunda', 'terceira']);
  });

  it('handles Windows line endings', () => {
    runs.appendOutput(id, 'um\r\ndois\r\n');
    expect(runs.detail(id).lines.map(l => l.text)).to.deep.equal(['um', 'dois']);
  });

  it('keeps stderr distinguishable from stdout', () => {
    runs.appendOutput(id, 'normal', 'stdout');
    runs.appendOutput(id, 'problema', 'stderr');
    const lines = runs.detail(id).lines;
    expect(lines[0].stream).to.equal('stdout');
    expect(lines[1].stream).to.equal('stderr');
  });

  it('skips blank lines, which are just noise in a log view', () => {
    runs.appendOutput(id, 'a\n\n\n   \nb');
    expect(runs.detail(id).lines.map(l => l.text)).to.deep.equal(['a', 'b']);
  });

  // A chatty script must not be able to exhaust memory.
  it('keeps only the tail once the cap is reached', () => {
    for (let i = 0; i < RunRegistry.MAX_LINES_PER_RUN + 500; i++) runs.appendOutput(id, 'linha ' + i);
    const lines = runs.detail(id).lines;
    expect(lines.length).to.be.at.most(RunRegistry.MAX_LINES_PER_RUN);
    // The end is what matters while watching.
    expect(lines[lines.length - 1].text).to.equal('linha ' + (RunRegistry.MAX_LINES_PER_RUN + 499));
  });

  it('truncates an absurdly long single line', () => {
    runs.appendOutput(id, 'x'.repeat(10000));
    expect(runs.detail(id).lines[0].text.length).to.be.at.most(2000);
  });

  // The viewer polls with the last sequence it saw, so it only ever receives
  // what is new - otherwise the log would flicker and lose scroll position.
  it('returns only lines newer than the given sequence', () => {
    runs.appendOutput(id, 'um\ndois');
    const first = runs.detail(id, 0);
    expect(first.lines).to.have.length(2);

    runs.appendOutput(id, 'tres');
    const second = runs.detail(id, first.lastSeq);
    expect(second.lines.map(l => l.text)).to.deep.equal(['tres']);
  });
});

describe('Run registry: events', () => {
  let runs;
  beforeEach(() => { runs = new RunRegistry(); });
  afterEach(() => runs.dispose());

  it('announces a run starting and finishing', (done) => {
    let started = false;
    runs.on('started', () => { started = true; });
    runs.on('finished', (summary) => {
      try {
        expect(started).to.equal(true);
        expect(summary.status).to.equal('success');
        done();
      } catch (e) { done(e); }
    });
    const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A'] });
    runs.finish(id, { success: true });
  });

  it('announces progress so the UI does not have to poll for it', (done) => {
    const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A', 'B'] });
    runs.on('progress', (summary) => {
      try { expect(summary.runId).to.equal(id); done(); } catch (e) { done(e); }
    });
    runs.setStep(id, 1);
  });
});

describe('Run registry: housekeeping', () => {
  it('forgets a finished run after the keep window', () => {
    const runs = new RunRegistry();
    try {
      const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A'] });
      runs.finish(id, { success: true });

      // Backdate the end so the sweep considers it stale.
      runs.get(id).endedAt = Date.now() - RunRegistry.KEEP_FINISHED_MS - 1000;
      runs._sweep();

      expect(runs.detail(id)).to.equal(null);
    } finally { runs.dispose(); }
  });

  it('never sweeps a run that is still going', () => {
    const runs = new RunRegistry();
    try {
      const id = runs.start({ kind: 'task', targetId: 't1', name: 'X', steps: ['A'] });
      runs._sweep();
      expect(runs.detail(id)).to.not.equal(null);
    } finally { runs.dispose(); }
  });
});

describe('Run registry: the executors report through it', () => {
  const fs = require('fs');
  const path = require('path');

  it('taskManager streams output instead of waiting for the process to exit', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'taskManager.js'), 'utf8');
    // execFile only hands over output once the process has already ended,
    // which makes watching a run live impossible.
    expect(src).to.include('spawn(cmd, cmdArgs, options)');
    expect(src).to.include('runs.appendOutput');
  });

  it('backupManager reports a step per database', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'backupManager.js'), 'utf8');
    expect(src).to.include('runs.setStep(runId, dbIndex');
    expect(src).to.include('runs.finish(runId');
  });

  it('both keep working without a registry, so the service is unaffected', () => {
    for (const file of ['taskManager.js', 'backupManager.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', file), 'utf8');
      expect(src, `${file} must treat the registry as optional`).to.include('runRegistry || null');
    }
  });
});
