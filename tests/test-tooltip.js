// tests/test-tooltip.js
//
// data-tip tooltips used to be a CSS ::after inside the element, clipped by
// any ancestor with overflow (cards, wizard tabs, modals). They are now one
// fixed element on <body>, rendered by tooltip.js, above the modals.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'renderer');
const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

describe('tooltips are not clipped by their containers', () => {
  it('no ::after tooltip inside the element', () => {
    expect(css).to.not.match(/\[data-tip\][^{]*::after/);
  });

  it('the floating tooltip is fixed and above the modal overlay', () => {
    const rule = css.match(/\.kc-tooltip\s*\{([^}]*)\}/);
    expect(rule, '.kc-tooltip rule').to.not.equal(null);
    expect(rule[1]).to.match(/position:\s*fixed/);
    const z = parseInt(rule[1].match(/z-index:\s*(\d+)/)[1], 10);
    const modal = css.match(/position: fixed; inset: 0; z-index: (\d+)/);
    expect(z).to.be.above(parseInt(modal[1], 10));
  });

  it('index.html loads tooltip.js, which attaches to <body>', () => {
    expect(html).to.include('<script src="tooltip.js"></script>');
    expect(fs.readFileSync(path.join(dir, 'tooltip.js'), 'utf8')).to.include('document.body.appendChild');
  });
});
