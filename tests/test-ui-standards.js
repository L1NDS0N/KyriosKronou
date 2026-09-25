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

  it('keeps wide modals inside the viewport at every window size', () => {
    expect(css).to.include('width: min(520px, calc(100vw - 48px))');
    expect(css).to.include('width: min(780px, calc(100vw - 48px))');
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

  it('keeps the settings page free of unstyled and orphan buttons', () => {
    expect(index).to.not.match(/<button class="btn-primary"/);
    expect(index).to.not.match(/<button class="btn-outline btn-sm">Browse<\/button>/);
  });
});
