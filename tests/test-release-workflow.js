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
