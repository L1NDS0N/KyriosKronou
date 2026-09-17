// tests/test-app-icon.js
//
// The icon regressed twice. The confusing part is that Windows takes it from
// three independent places, and getting one right says nothing about the
// others:
//
//   the .exe file icon   -> electron-packager --icon
//   the window/taskbar   -> BrowserWindow { icon }
//   the shortcut         -> whatever CreateShortCut points at
//
// These tests pin all three.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'build-resources', 'icon.ico');

describe('App icon: the file itself', () => {
  it('exists', () => {
    expect(fs.existsSync(ICON), 'build-resources/icon.ico is missing').to.equal(true);
  });

  it('is a real .ico, not a renamed png', () => {
    const buf = fs.readFileSync(ICON);
    // ICONDIR: reserved must be 0, type must be 1.
    expect(buf.readUInt16LE(0)).to.equal(0);
    expect(buf.readUInt16LE(2)).to.equal(1);
  });

  // Windows picks a different size for the taskbar, the title bar, Explorer
  // and Alt-Tab. A single-size icon looks wrong in most of them.
  it('carries the sizes Windows actually asks for', () => {
    const buf = fs.readFileSync(ICON);
    const count = buf.readUInt16LE(4);
    expect(count, 'an icon with one size will look wrong somewhere').to.be.above(3);

    const sizes = [];
    for (let i = 0; i < count; i++) {
      const offset = 6 + i * 16;
      sizes.push(buf[offset] || 256);
    }
    for (const needed of [16, 32, 48, 256]) {
      expect(sizes, `missing the ${needed}x${needed} variant`).to.include(needed);
    }
  });
});

describe('App icon: the window and taskbar', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');

  // This was the actual bug: the packaged .exe had the right icon, but the
  // window did not set one, so the taskbar button showed Electron's default.
  it('BrowserWindow is given an icon', () => {
    expect(main).to.include('icon: iconPath');
    expect(main).to.include('function appIconPath');
  });

  it('looks for the icon in both the dev tree and a packaged build', () => {
    expect(main).to.include("'build-resources', 'icon.ico'");
    expect(main).to.include('app.asar');
  });

  // Without an explicit AppUserModelID, Windows does not associate the running
  // window with the installed shortcut and falls back to a default icon.
  it('sets an AppUserModelID on Windows', () => {
    expect(main).to.include('setAppUserModelId');
  });

  it('uses the same id the installer registers', () => {
    const match = /APP_USER_MODEL_ID = '([^']+)'/.exec(main);
    expect(match, 'no AppUserModelID constant found').to.not.equal(null);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(match[1]).to.equal(pkg.build.appId);
  });
});

describe('App icon: packaging and shortcuts', () => {
  it('the packager is told which icon to use', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts', 'package-app.js'), 'utf8');
    expect(script).to.include("icon:");
    expect(script).to.include('icon.ico');
  });

  it('the packaging rules never exclude build-resources', () => {
    const { ignore } = require('../scripts/package-app');
    expect(ignore('/build-resources/icon.ico')).to.equal(false);
  });

  const nsis = fs.readFileSync(path.join(ROOT, 'installer', 'KyriosChronos-Installer.nsi'), 'utf8');

  it('the installer ships the icon as a loose file', () => {
    expect(nsis).to.match(/File\s+"\.\.\\build-resources\\icon\.ico"/);
  });

  // Pointing a shortcut at "the exe, icon index 0" left it showing Electron's
  // logo; an explicit .ico removes the ambiguity.
  it('shortcuts point at the .ico, not at an icon index inside the exe', () => {
    const shortcuts = nsis.split('\n').filter(l => l.includes('CreateShortCut') && l.includes('KyriosChronos.exe'));
    expect(shortcuts.length, 'no application shortcuts found').to.be.above(0);
    for (const line of shortcuts) {
      expect(line, `shortcut still uses the exe as its icon source:\n${line}`).to.include('icon.ico');
    }
  });

  it('the installer and uninstaller use the icon too', () => {
    expect(nsis).to.include('MUI_ICON');
    expect(nsis).to.include('MUI_UNICON');
  });
});
