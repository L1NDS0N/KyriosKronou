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

  // The whole point of the workflow: merging to master publishes a release.
  // Without the branch trigger it only ever ran for a tag someone made by
  // hand, and a merge produced no release at all.
  it('publica sozinho quando algo é mergeado na master', () => {
    expect(workflow).to.include('branches: [master]');
    expect(workflow).to.include('push:');
  });

  // Without this the release commit it pushes back to master re-triggers the
  // workflow, which bumps the version again, forever. GitHub only skips a
  // workflow when EVERY changed file is ignored, and the release commit touches
  // exactly these three.
  it('não se re-dispara com o próprio commit de release', () => {
    const on = workflow.slice(0, workflow.indexOf('permissions:'));
    expect(on, 'paths-ignore é o que corta o loop').to.include('paths-ignore:');
    for (const arquivo of ['CHANGELOG.md', 'package.json', 'package-lock.json']) {
      expect(on, arquivo).to.include(`- ${arquivo}`);
    }
    // E o commit de release não pode mexer em mais nada, senão sai da lista.
    const commitStep = workflow.slice(
      workflow.indexOf('Commit version and create release tag'),
      workflow.indexOf('Generate release notes')
    );
    expect(commitStep).to.include('git add package.json package-lock.json CHANGELOG.md');
  });

  // A run that tagged and then died must not bump again on every re-run.
  it('reaproveita a tag se a execução anterior morreu antes de publicar', () => {
    expect(workflow).to.include('git rev-parse -q --verify "refs/tags/$TAG"');
    expect(workflow).to.include('reaproveitando');
  });

  // O CI falhou aqui: --bump imprimia a versão atual E a próxima, e a
  // validação MAJOR.MINOR.PATCH recebia as duas numa variável só. A flag
  // dedicada imprime uma linha e não escreve arquivo nenhum.
  it('pede a próxima versão por uma flag que imprime uma linha só', () => {
    expect(workflow).to.include('generate-changelog.js --print-next');
    expect(workflow).to.not.include('--bump --print-version');

    const out = execFileSync(process.execPath, ['scripts/generate-changelog.js', '--print-next'], {
      cwd: ROOT, encoding: 'utf8',
    });
    const linhas = out.trim().split(/\r?\n/);
    expect(linhas, 'tem de ser uma linha só').to.have.lengthOf(1);
    expect(linhas[0], 'e no formato que a validação exige').to.match(/^\d+\.\d+\.\d+$/);
  });

  it('o helper de bump não deixa resíduo nem depende de pegar a última linha', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-next-'));
    try {
      const changelog = path.join(dir, 'CHANGELOG.md');
      const notes = path.join(dir, 'notes.md');
      const out = execFileSync(
        process.execPath,
        ['scripts/generate-changelog.js', '--print-next', '--output', changelog, '--notes-output', notes],
        { cwd: ROOT, encoding: 'utf8' }
      );
      expect(out.trim().split(/\r?\n/)).to.have.lengthOf(1);
      // Só calcular a próxima versão não pode mexer no changelog do repositório.
      expect(fs.existsSync(changelog), 'não deve criar changelog').to.equal(false);
      expect(fs.existsSync(notes), 'não deve criar release notes').to.equal(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('o passo de tag roda por saída, não pelo tipo de evento', () => {
    // Gatear por github.event_name deixava a publicação de branch fora: o
    // passo não rodava num push, e a release nunca recebia a tag.
    expect(workflow).to.include("if: steps.version.outputs.publish == 'true'");
    expect(workflow).to.not.include("if: github.event_name == 'workflow_dispatch' && inputs.publish");
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
    // --output e --notes-output são obrigatórios aqui: sem eles o script usa
    // CHANGELOG.md na raiz do repositório e o teste passa reescrevendo o
    // changelog de verdade a cada execução da suíte.
    execFileSync(process.execPath, ['scripts/generate-changelog.js', '--version', '1.0.0', '--output', output, '--notes-output', notes], { cwd: ROOT });
    execFileSync(process.execPath, ['scripts/generate-changelog.js', '--version', '1.0.0', '--output', output, '--notes-output', notes], { cwd: ROOT });
    const changelog = fs.readFileSync(output, 'utf8');
    const releaseNotes = fs.readFileSync(notes, 'utf8');
    expect(changelog.match(/^## 1\.0\.0 /gm)).to.have.lengthOf(1);
    expect(changelog).to.include('## 1.0.0');
    expect(releaseNotes).to.match(/### (Added|Fixed|Changed|Documentation|Tests)/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deixa o changelog do repositório intacto ao rodar a suíte', () => {
    const changelog = path.join(ROOT, 'CHANGELOG.md');
    const antes = fs.readFileSync(changelog, 'utf8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-cl-'));
    try {
      execFileSync(
        process.execPath,
        ['scripts/generate-changelog.js', '--version', '1.0.0', '--output', path.join(dir, 'c.md'), '--notes-output', path.join(dir, 'n.md')],
        { cwd: ROOT }
      );
      expect(fs.readFileSync(changelog, 'utf8'), 'a suíte não pode reescrever o changelog versionado').to.equal(antes);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
