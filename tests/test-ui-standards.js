const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('UI standards', () => {
  const css = read('src/renderer/style.css');
  const webCss = read('src/web/style.css');
  const index = read('src/renderer/index.html');

  it('defines every token used by shared components', () => {
    for (const token of ['--border:', '--text1:', '--primary-glow:', '--font-mono:']) {
      expect(css).to.include(token);
    }
  });

  it('measures layout against the content container, not only the window', () => {
    expect(css).to.include('container-type: inline-size');
    expect(css).to.include('container-name: content');
    const unreachable = [...css.matchAll(/@media \(max-width: (?:900|760|720|680|600)px\)/g)];
    expect(unreachable).to.have.lengthOf(0);
  });

  it('ships the shared responsive primitives', () => {
    for (const selector of ['.responsive-grid', '.toolbar-wrap', '.table-scroll', '.connection-grid']) {
      expect(css).to.include(selector);
    }
  });

  it('keeps wide modals inside the viewport and never below 64vw', () => {
    expect(css).to.include('max(640px, 64vw)');
    expect(css).to.include('max(900px, 72vw)');
    expect(css).to.include('max(720px, 64vw)');
    expect(css).to.not.include('96vw');
  });

  it('lets dense tables scroll instead of collapsing', () => {
    expect(css).to.match(/\.data-table \{[^}]*min-width: 560px/);
    expect(css).to.match(/\.logs-table \{[^}]*min-width: 620px/);
    expect(css).to.match(/\.table-wrap \{[^}]*overflow: auto/);
  });

  it('removes fixed column templates from the wizards', () => {
    for (const file of ['src/renderer/backupPage.js', 'src/renderer/syncPage.js']) {
      expect(read(file)).to.not.include('grid-template-columns:');
    }
  });

  it('gives every button family the same size, icon and focus model', () => {
    for (const selector of ['.btn-glow', '.btn-primary', '.btn-ghost', '.btn-outline', '.btn-secondary-sm', '.btn-danger']) {
      expect(css).to.include(selector);
    }
    expect(css).to.include('--btn-h: 34px');
    expect(css).to.include('--btn-h: 28px');
    expect(css).to.match(/focus-visible/);
    expect(css).to.match(/btn-danger:disabled/);
    expect(webCss).to.include('.btn-sm');
    expect(webCss).to.include('focus-visible');
  });

  it('keeps task history rows from collapsing inside the scroll container', () => {
    expect(css).to.include('.task-history-list { display: block; }');
    expect(css).to.include('.task-history-list .th-entry { flex: 0 0 auto; }');
  });

  it('reloads backup profiles through the real method after cloning', () => {
    const backupPage = read('src/renderer/backupPage.js');
    expect(backupPage).to.not.include('this.loadProfiles()');
    expect(backupPage).to.include('await this.load();');
  });

  it('exposes the per-screen web permission matrix in Settings', () => {
    const index = read('src/renderer/index.html');
    const app = read('src/renderer/app.js');
    expect(index).to.include('id="web-permissions-matrix"');
    expect(index).to.include('webPermissionsUi.js');
    expect(app).to.include('window.webPermissionsUI.access = cfg');
    expect(read('src/renderer/webPermissionsUi.js')).to.include('setWebUserPermissions');
  });

  it('routes task, backup, sync and retention histories to the same full detail modal', () => {
    expect(read('src/renderer/app.js')).to.include('function showRunDetail');
    expect(read('src/renderer/backupPage.js')).to.include("showRunDetail(history[Number(row.dataset.backupHistoryIndex)], 'backup')");
    expect(read('src/renderer/syncPage.js')).to.include("showRunDetail(entries[Number(row.dataset.syncHistoryIndex)], 'sync')");
    expect(read('src/renderer/retentionPage.js')).to.include("}, 'retention')");
  });

  it('keeps quick create on the main cron implementation and drops the dead renderer duplicate', () => {
    const index = read('src/renderer/index.html');
    expect(index).to.not.include('quickAssist.js');
    expect(index).to.include('quickCreate.js');
    const quick = read('src/renderer/quickCreate.js');
    expect(quick).to.include('bridge.validateCron');
    expect(quick).to.include('window.api');
  });

  it('keeps the settings page free of unstyled and orphan buttons', () => {
    expect(index).to.not.match(/<button class="btn-primary"/);
    expect(index).to.not.match(/<button class="btn-outline btn-sm">Browse<\/button>/);
  });
});
