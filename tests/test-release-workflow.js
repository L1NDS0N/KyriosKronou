const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('Release workflow', () => {
  const workflow = read('.github/workflows/release.yml');
  const installer = read('installer/KyriosChronos-Installer.nsi');
  const build = read('Build-Installer.ps1');

  // The regression that broke CI: every path still pointed at the old
  // CronMasterJS/ layout, so setup-node aborted the job on an unresolved
  // cache-dependency-path before a single line of the project was built.
  it('builds from the repository root, not the removed CronMasterJS folder', () => {
    for (const file of ['.github/workflows/build.yml', '.github/workflows/release.yml']) {
      const source = read(file);
      expect(source, file).to.not.include('CronMasterJS');
    }
    expect(workflow).to.include('run: npm ci');
  });

  it('builds on Windows from tags and manual publications', () => {
    expect(workflow).to.include("tags:\n      - 'v*.*.*'");
    expect(workflow).to.include('workflow_dispatch:');
    expect(workflow).to.include('runs-on: windows-latest');
    expect(workflow).to.include('choco install nsis');
    expect(workflow).to.include('.\\Build-Installer.ps1');
  });

  it('keeps the package version and the release tag in sync', () => {
    expect(workflow).to.include('does not match package.json version');
    expect(workflow).to.include('npm version "$VERSION" --no-git-tag-version');
    expect(workflow).to.include('git tag -a "$TAG"');
  });

  it('publishes the tag only after tests and the build succeed', () => {
    const buildStep = workflow.indexOf('Run tests and build installer');
    const tagStep = workflow.indexOf('Commit version and create release tag');
    expect(buildStep).to.be.greaterThan(-1);
    expect(tagStep).to.be.greaterThan(buildStep);
  });

  it('attaches every installer, portable build and updater file to the release', () => {
    expect(workflow).to.include('actions/upload-artifact@v4');
    expect(workflow).to.include("dist/*.exe");
    expect(workflow).to.include('gh release create "$TAG"');
    expect(workflow).to.include('gh release upload "$TAG"');
    expect(workflow).to.include("-name '*.exe'");
    expect(workflow).to.include("-name '*.blockmap'");
    expect(workflow).to.include("-name 'latest.yml'");
  });

  it('reports categorized changes in the release and the job summary', () => {
    expect(workflow).to.include('node scripts/generate-changelog.js');
    expect(workflow).to.include('GITHUB_STEP_SUMMARY');
    expect(workflow).to.include('release-notes.md');
    const script = read('scripts/generate-changelog.js');
    for (const category of ['Added', 'Fixed', 'Security', 'Changed', 'Documentation', 'Tests', 'Removed']) {
      expect(script).to.include(`title: '${category}'`);
    }
  });

  it('versions the NSIS artifact from package.json instead of hardcoding it', () => {
    expect(installer).to.include('!define APP_VERSION "1.0.0"');
    expect(installer).to.include('${SETUP_EXE}');
    expect(installer).to.not.include('OutFile "..\\dist\\KyriosChronos-Setup-1.0.0.exe"');
    expect(build).to.include('"/DAPP_VERSION=$version"');
  });

  it('caches the Electron/NSIS toolchain and drops the cancelled-run race', () => {
    for (const file of ['.github/workflows/build.yml', '.github/workflows/release.yml']) {
      const source = read(file);
      expect(source, file).to.include('actions/cache@v4');
      expect(source, file).to.include('ELECTRON_CACHE:');
      expect(source, file).to.include('ELECTRON_BUILDER_CACHE:');
      expect(source, file).to.include("hashFiles('package-lock.json')");
    }
    const ci = read('.github/workflows/build.yml');
    expect(ci).to.include('cancel-in-progress: true');
    // A failed suite must fail the job: a `|| true` on the npm test step is how
    // a red build ships green. Checked per line so a comment can name it.
    const runLines = ci.split('\n').filter(line => /^\s*(run|shell):/.test(line) && line.includes('npm test'));
    expect(runLines).to.have.lengthOf(1);
    expect(runLines[0]).to.equal('        run: npm test');
  });

  it('does not run the suite twice on the same pipeline', () => {
    const ci = read('.github/workflows/build.yml');
    expect(ci).to.include('.\\Build-Installer.ps1 -SkipTests');
    expect(build).to.include('[switch]$SkipTests');
  });

  it('exposes a manual dispatcher to cancel a run in flight', () => {
    const cancel = read('.github/workflows/cancel.yml');
    expect(cancel).to.include('workflow_dispatch:');
    expect(cancel).to.include('run_id:');
    expect(cancel).to.include('actions/runs/${RUN_ID}/cancel');
    // Own workflow, own concurrency: sharing a group with the run being
    // cancelled would make the dispatcher cancel itself.
    expect(cancel).to.not.include('concurrency:');
    expect(cancel).to.include('actions: write');
  });

  it('generates a categorized changelog from the real git history', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-changelog-'));
    const output = path.join(dir, 'CHANGELOG.md');
    const notes = path.join(dir, 'notes.md');
    execFileSync(process.execPath, ['scripts/generate-changelog.js', '--version', '1.0.0', '--output', output, '--notes-output', notes], { cwd: ROOT });
    execFileSync(process.execPath, ['scripts/generate-changelog.js', '--version', '1.0.0', '--output', output, '--notes-output', notes], { cwd: ROOT });
    const changelog = fs.readFileSync(output, 'utf8');
    const releaseNotes = fs.readFileSync(notes, 'utf8');
    expect(changelog.match(/^## 1\.0\.0 /gm)).to.have.lengthOf(1);
    expect(changelog).to.include('## 1.0.0');
    expect(releaseNotes).to.match(/### (Added|Fixed|Changed|Documentation|Tests)/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
