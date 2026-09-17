// tests/test-logs-screen.js
//
// The Logs screen crashed in production: renderLogsTable replaced the contents
// of #logs-table-wrap, which destroyed the #logs-empty node living inside it,
// and the next render then dereferenced null. It was also slow, because every
// render drew every row the log files held.
//
// These tests pin the structure and the filtering contract.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'style.css'), 'utf8');

describe('Logs screen: structure', () => {
  // This is the crash. The empty state must not live inside the node that
  // renderLogsTable overwrites.
  it('keeps the empty state outside the table host', () => {
    const wrap = html.indexOf('id="logs-table-wrap"');
    const empty = html.indexOf('id="logs-empty"');
    expect(wrap, 'no table host').to.be.above(-1);
    expect(empty, 'no empty state').to.be.above(-1);

    // The host has to be closed before the empty state begins.
    const between = html.slice(wrap, empty);
    const closes = (between.match(/<\/div>/g) || []).length;
    const opens = (between.match(/<div/g) || []).length;
    expect(closes, 'the empty state is still nested in the table host')
      .to.be.above(opens);
  });

  it('has a host for the filter bar', () => {
    expect(html).to.include('id="logs-filters"');
  });

  it('styles the filter bar', () => {
    for (const rule of ['.logs-filter-row', '.logs-search', '.logs-count', '.logs-more']) {
      expect(css, `${rule} is unstyled`).to.include(rule);
    }
  });
});

describe('Logs screen: behaviour', () => {
  // Drawing thousands of rows is what made the screen feel frozen.
  it('pages the table instead of rendering everything', () => {
    expect(app).to.match(/const LOG_PAGE = \d+/);
    expect(app).to.include('logPageSize');
    expect(app).to.include("id=\"logs-more\"");
  });

  it('rebuilds the filter bar on the SWR path, not only on the fallback', () => {
    const swr = app.slice(app.indexOf('async function refreshLogs'), app.indexOf('function logsSince'));
    const calls = swr.match(/renderLogFilters\(\)/g) || [];
    expect(calls.length, 'the cached path would leave a stale filter bar').to.be.at.least(2);
  });

  // Typing rerenders the table; rebuilding the input would move the caret.
  it('does not rebuild the search box while it has focus', () => {
    expect(app).to.include("document.activeElement.id === 'log-search'");
  });

  it('resets the level filter when the tab changes', () => {
    const fn = app.slice(app.indexOf('function switchLogTab'), app.indexOf('async function refreshLogs'));
    expect(fn).to.include("logFilters.level = ''");
    expect(fn).to.include('renderLogFilters()');
  });
});

describe('Logs screen: translations', () => {
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'i18n.js'), 'utf8');

  // Hardcoded Portuguese was exactly what the user asked us to stop doing.
  it('has every key the screen asks for, in both languages', () => {
    const used = [...new Set((app.match(/i18n\.t\('(logs\.[a-zA-Z0-9]+)'/g) || [])
      .map(m => /'([^']+)'/.exec(m)[1]))];
    expect(used.length, 'no logs keys found - did the screen stop using i18n?').to.be.above(10);

    for (const key of used) {
      const occurrences = (i18n.match(new RegExp(`'${key.replace('.', '\.')}':`, 'g')) || []).length;
      expect(occurrences, `${key} is missing from one of the dictionaries`).to.equal(2);
    }
  });
});
