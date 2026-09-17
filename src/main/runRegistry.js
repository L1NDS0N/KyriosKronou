// runRegistry.js - What is running right now, and how far along it is.
//
// Until now a task or backup fired and the operator saw nothing until it
// finished. This tracks every in-flight run: its steps, its progress and its
// live output, so the UI can show a badge, a footer count, and a window onto a
// single run as it happens.
//
// Deliberately in the main process rather than the renderer: the service also
// executes jobs, the GUI may be closed and reopened mid-run, and output has to
// survive a page navigation.
//
// Electron-free, so the Windows service can load it too.

const EventEmitter = require('events');
const crypto = require('crypto');

// Enough to follow along without letting a chatty script exhaust memory.
const MAX_LINES_PER_RUN = 2000;
// Finished runs stay briefly so the UI can show the final state.
const KEEP_FINISHED_MS = 2 * 60 * 1000;

class RunRegistry extends EventEmitter {
  constructor() {
    super();
    this.runs = new Map(); // runId -> run
    this._sweepTimer = setInterval(() => this._sweep(), 30000);
    if (this._sweepTimer.unref) this._sweepTimer.unref();
  }

  /**
   * Begin tracking a run.
   *
   * @param {object} info { kind: 'task'|'backup', targetId, name, steps: [string] }
   * @returns {string} runId
   */
  start(info) {
    const runId = crypto.randomUUID();
    const steps = (info.steps || []).map((label, i) => ({
      index: i, label, state: i === 0 ? 'running' : 'pending', startedAt: i === 0 ? Date.now() : null, endedAt: null, detail: '',
    }));

    const run = {
      runId,
      kind: info.kind || 'task',
      targetId: info.targetId || null,
      name: info.name || '(sem nome)',
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      percent: 0,
      currentStep: steps.length ? 0 : -1,
      steps,
      lines: [],
      lineSeq: 0,
      message: '',
    };

    this.runs.set(runId, run);
    this.emit('started', this.summary(run));
    this.emit('changed');
    return runId;
  }

  get(runId) { return this.runs.get(runId) || null; }

  /** Advance to a step, completing the ones before it. */
  setStep(runId, index, detail) {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;

    for (let i = 0; i < run.steps.length; i++) {
      const step = run.steps[i];
      if (i < index && step.state !== 'done' && step.state !== 'failed') {
        step.state = 'done';
        step.endedAt = step.endedAt || Date.now();
      }
    }

    const step = run.steps[index];
    if (step) {
      step.state = 'running';
      step.startedAt = step.startedAt || Date.now();
      if (detail) step.detail = String(detail).slice(0, 300);
      run.currentStep = index;
    }

    this._recomputePercent(run);
    this.emit('progress', this.summary(run));
    this.emit('changed');
  }

  /** Explicit progress, for work whose size is known (bytes, rows, files). */
  setPercent(runId, percent, detail) {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return;
    run.percent = Math.max(0, Math.min(100, Math.round(percent)));
    if (detail) {
      const step = run.steps[run.currentStep];
      if (step) step.detail = String(detail).slice(0, 300);
    }
    this.emit('progress', this.summary(run));
  }

  /** A line of live output. */
  appendOutput(runId, text, stream = 'stdout') {
    const run = this.runs.get(runId);
    if (!run || !text) return;

    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.replace(/\r/g, '');
      if (!line.trim()) continue;
      run.lines.push({ seq: ++run.lineSeq, at: Date.now(), stream, text: line.slice(0, 2000) });
    }
    // Keep the tail: the end of the output is what matters while watching.
    if (run.lines.length > MAX_LINES_PER_RUN) {
      run.lines = run.lines.slice(-MAX_LINES_PER_RUN);
    }
    this.emit('output', { runId, lines: run.lines.slice(-20) });
  }

  /** Mark a step as failed without ending the run. */
  failStep(runId, index, detail) {
    const run = this.runs.get(runId);
    if (!run) return;
    const step = run.steps[index];
    if (!step) return;
    step.state = 'failed';
    step.endedAt = Date.now();
    if (detail) step.detail = String(detail).slice(0, 300);
    this.emit('progress', this.summary(run));
  }

  finish(runId, result = {}) {
    const run = this.runs.get(runId);
    if (!run) return;

    run.status = result.success === false ? 'failed' : 'success';
    run.endedAt = Date.now();
    run.message = String(result.message || '').slice(0, 1000);

    for (const step of run.steps) {
      if (step.state === 'running' || step.state === 'pending') {
        step.state = run.status === 'failed' ? 'skipped' : 'done';
        step.endedAt = step.endedAt || Date.now();
      }
    }
    run.percent = run.status === 'failed' ? run.percent : 100;

    this.emit('finished', this.summary(run));
    this.emit('changed');
  }

  _recomputePercent(run) {
    if (!run.steps.length) return;
    const done = run.steps.filter(s => s.state === 'done').length;
    // Count the running step as half, so the bar moves as work starts rather
    // than jumping only when a step completes.
    const running = run.steps.some(s => s.state === 'running') ? 0.5 : 0;
    run.percent = Math.round(((done + running) / run.steps.length) * 100);
  }

  /** Lightweight shape for lists, badges and the footer count. */
  summary(run) {
    return {
      runId: run.runId,
      kind: run.kind,
      targetId: run.targetId,
      name: run.name,
      status: run.status,
      percent: run.percent,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      elapsedMs: (run.endedAt || Date.now()) - run.startedAt,
      currentStep: run.currentStep,
      currentStepLabel: (run.steps[run.currentStep] || {}).label || '',
      stepCount: run.steps.length,
      message: run.message,
    };
  }

  /** Full detail for the one run being watched. */
  detail(runId, sinceSeq = 0) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      ...this.summary(run),
      steps: run.steps,
      lines: run.lines.filter(l => l.seq > sinceSeq),
      lastSeq: run.lineSeq,
    };
  }

  /** Everything currently running, newest first. */
  active() {
    return Array.from(this.runs.values())
      .filter(r => r.status === 'running')
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(r => this.summary(r));
  }

  /** Running plus recently finished, for the footer panel. */
  recent() {
    return Array.from(this.runs.values())
      .sort((a, b) => b.startedAt - a.startedAt)
      .map(r => this.summary(r));
  }

  /** Is anything running for this task or profile? */
  activeFor(targetId) {
    for (const run of this.runs.values()) {
      if (run.status === 'running' && run.targetId === targetId) return this.summary(run);
    }
    return null;
  }

  _sweep() {
    const now = Date.now();
    for (const [id, run] of this.runs) {
      if (run.status !== 'running' && run.endedAt && (now - run.endedAt) > KEEP_FINISHED_MS) {
        this.runs.delete(id);
      }
    }
  }

  dispose() {
    if (this._sweepTimer) clearInterval(this._sweepTimer);
    this.runs.clear();
    this.removeAllListeners();
  }
}

module.exports = RunRegistry;
module.exports.MAX_LINES_PER_RUN = MAX_LINES_PER_RUN;
module.exports.KEEP_FINISHED_MS = KEEP_FINISHED_MS;
