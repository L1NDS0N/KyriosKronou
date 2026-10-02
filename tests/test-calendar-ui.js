const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(__dirname, 'fixtures', 'calendar-ui-runner.js');

const { rodar, ELECTRON } = require('./fixtures/electron-runner');

const runCalendar = () => rodar(RUNNER, 'calendar renderer');

describe('Calendar UI in the real Electron renderer', () => {
  let result;

  before(async function () {
    if (!fs.existsSync(ELECTRON)) return this.skip();
    result = await runCalendar();
  });

  it('renders a complete and organized month without overflowing May 31 into July', () => {
    expect(result.firstRender.days).to.equal(42);
    expect(result.firstRender.cellsWithItems).to.equal(1);
    expect(result.firstRender.chips).to.equal(1);
    expect(result.firstRender.metrics).to.equal(4);
    expect(result.junePeriod.toLowerCase()).to.include('june');
  });

  it('keeps the selected view when an older request resolves last', () => {
    expect(result.duringAgenda).to.equal(true);
    expect(result.finalView).to.equal('agenda');
    expect(result.staleVisible).to.equal(false);
  });
});
