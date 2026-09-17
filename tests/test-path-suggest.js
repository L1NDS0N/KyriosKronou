// tests/test-path-suggest.js
//
// Path fields are where tasks, services and backup profiles are most often got
// wrong, and a typo only surfaces later as a failed run. This module completes
// against the real filesystem, so the things worth pinning down are: that it
// only ever reads, that it cannot be made to hang the UI, and that it tells the
// truth about what exists.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ps = require('../src/main/pathSuggest');

const B = String.fromCharCode(92); // backslash

describe('Path completion: starting points', () => {
  it('offers the drives that actually exist when nothing is typed', () => {
    const { suggestions } = ps.suggest('');
    const drives = suggestions.filter(s => /^[A-Z]:\\$/.test(s.name));
    expect(drives.length).to.be.above(0);
    for (const d of drives) expect(fs.existsSync(d.full)).to.equal(true);
  });

  it('offers the usual Windows folders as shortcuts', () => {
    const names = ps.suggest('').suggestions.map(s => s.name);
    expect(names).to.include('%programfiles%');
    expect(names).to.include('%userprofile%');
  });

  it('never invents a drive that is not mounted', () => {
    const drives = ps.listDrives();
    for (const d of drives) expect(fs.existsSync(d)).to.equal(true);
    // Q: is almost never a real drive; if it is, the assertion above covers it.
    if (!fs.existsSync('Q:' + B)) expect(drives).to.not.include('Q:' + B);
  });
});

describe('Path completion: walking the filesystem', () => {
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathsuggest-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'scratch'));
    fs.writeFileSync(path.join(dir, 'backup.ps1'), '');
    fs.writeFileSync(path.join(dir, 'backup.bat'), '');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  });

  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

  it('lists everything in a directory when the fragment is empty', () => {
    const names = ps.suggest(dir + B).suggestions.map(s => s.name);
    expect(names).to.have.members(['scripts', 'scratch', 'backup.ps1', 'backup.bat', 'notes.txt']);
  });

  it('filters by the typed fragment', () => {
    const names = ps.suggest(path.join(dir, 'scr')).suggestions.map(s => s.name);
    expect(names).to.have.members(['scripts', 'scratch']);
  });

  it('lists directories before files, since the user is usually still navigating', () => {
    const items = ps.suggest(dir + B).suggestions;
    const firstFile = items.findIndex(s => !s.directory);
    const lastDir = items.map(s => s.directory).lastIndexOf(true);
    expect(lastDir).to.be.below(firstFile);
  });

  it('marks directories with a trailing separator, so typing continues naturally', () => {
    const scripts = ps.suggest(path.join(dir, 'scripts')).suggestions.find(s => s.name === 'scripts');
    expect(scripts.full.endsWith(B)).to.equal(true);
  });

  it('offers only directories when the field asks for a folder', () => {
    const items = ps.suggest(dir + B, { kind: 'directory' }).suggestions;
    expect(items.every(s => s.directory)).to.equal(true);
    expect(items.map(s => s.name)).to.have.members(['scripts', 'scratch']);
  });

  it('restricts files to the extensions the field accepts', () => {
    const names = ps.suggest(dir + B, { kind: 'file', extensions: ['.ps1'] }).suggestions.map(s => s.name);
    expect(names).to.include('backup.ps1');
    expect(names).to.not.include('backup.bat');
    expect(names).to.not.include('notes.txt');
    // Directories still show, because they are the route to the file.
    expect(names).to.include('scripts');
  });

  it('accepts forward slashes, which people paste from elsewhere', () => {
    const names = ps.suggest(dir.replace(/\\/g, '/') + '/back').suggestions.map(s => s.name);
    expect(names).to.include('backup.ps1');
  });

  it('expands environment variables', () => {
    const result = ps.suggest('%TEMP%' + B);
    expect(result.base.toLowerCase()).to.equal((process.env.TEMP + B).toLowerCase());
    expect(result.suggestions.length).to.be.above(0);
  });

  it('reports a missing directory instead of throwing', () => {
    const result = ps.suggest('C:' + B + 'definitivamente-nao-existe-' + Date.now() + B);
    expect(result.suggestions).to.deep.equal([]);
    expect(result.error).to.equal('not-found');
  });

  it('survives a path it has no permission to read', () => {
    // System Volume Information is present and unreadable on a normal account.
    expect(() => ps.suggest('C:' + B + 'System Volume Information' + B)).to.not.throw();
  });

  // A directory with tens of thousands of entries must not stall the UI.
  it('caps results so a huge directory cannot freeze the interface', () => {
    const started = Date.now();
    const result = ps.suggest('C:' + B + 'Windows' + B + 'System32' + B);
    const elapsed = Date.now() - started;
    expect(result.suggestions.length).to.be.at.most(ps.MAX_RESULTS);
    expect(elapsed, 'listing must stay interactive').to.be.below(1500);
  });

  it('handles empty and nonsense input without throwing', () => {
    for (const input of ['', '   ', '::::', '\\\\', '%NAO_EXISTE%']) {
      expect(() => ps.suggest(input), JSON.stringify(input)).to.not.throw();
    }
  });
});

describe('Path completion: validation', () => {
  let dir, file;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathvalid-'));
    file = path.join(dir, 'script.ps1');
    fs.writeFileSync(file, 'Write-Host hello');
  });
  after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} });

  it('confirms a file that exists', () => {
    const r = ps.validate(file, { kind: 'file' });
    expect(r.exists).to.equal(true);
    expect(r.valid).to.equal(true);
    expect(r.size).to.be.above(0);
  });

  it('confirms a directory that exists', () => {
    const r = ps.validate(dir, { kind: 'directory' });
    expect(r.valid).to.equal(true);
    expect(r.directory).to.equal(true);
  });

  it('says so when a folder was given where a file is needed', () => {
    const r = ps.validate(dir, { kind: 'file' });
    expect(r.exists).to.equal(true);
    expect(r.valid).to.equal(false);
    expect(r.messageKey).to.equal('path.expectedFile');
  });

  it('says so when a file was given where a folder is needed', () => {
    const r = ps.validate(file, { kind: 'directory' });
    expect(r.valid).to.equal(false);
    expect(r.messageKey).to.equal('path.expectedFolder');
  });

  it('reports a path that does not exist', () => {
    const r = ps.validate(path.join(dir, 'nope.ps1'), { kind: 'file' });
    expect(r.exists).to.equal(false);
    expect(r.messageKey).to.equal('path.notFound');
  });

  it('treats an empty field as neither valid nor invalid', () => {
    const r = ps.validate('', { kind: 'file' });
    expect(r.exists).to.equal(false);
    expect(r.messageKey).to.equal('');
  });

  it('validates through an environment variable', () => {
    const r = ps.validate('%TEMP%', { kind: 'directory' });
    expect(r.valid).to.equal(true);
  });
});

describe('Path completion: it only ever reads', () => {
  it('the module never writes, deletes or executes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'pathSuggest.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    for (const forbidden of ['writeFile', 'unlink', 'rmSync', 'rmdir', 'mkdir', 'exec', 'spawn']) {
      expect(code, `pathSuggest must not call ${forbidden}`).to.not.include(forbidden);
    }
  });
});
