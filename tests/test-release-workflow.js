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
  // Recorta o bloco de um job pelo nome, para os testes falarem pelo job certo
  // em vez de procurarem no arquivo inteiro. Não usa um parser de YAML de
  // propósito: js-yaml aqui é dependência transitiva, e um teste não deve
  // depender de algo que o package.json não declara.
  function blocoDoJob(nome) {
    const inicio = workflow.indexOf(`\n  ${nome}:`);
    if (inicio < 0) throw new Error(`job ${nome} não encontrado`);
    const resto = workflow.slice(inicio + 1);
    const fim = resto.search(/\n  [a-z][a-zA-Z]*:/);
    return fim < 0 ? workflow.slice(inicio) : workflow.slice(inicio, inicio + 1 + fim);
  }
  function jobs() {
    const secao = workflow.slice(workflow.indexOf('\njobs:'));
    const nomes = secao.match(/^  ([a-z][a-zA-Z]*):/gm) || [];
    return nomes.map((linha) => linha.trim().replace(':', ''));
  }
  function job(nome) { return blocoDoJob(nome); }

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
  it('a publicação lê os assets do mesmo caminho em que o download os deixou', () => {
    // O upload usa o glob dist/*.exe, e o upload-artifact tira o prefixo comum
    // de todos os arquivos - que é "dist/". O download entrega os arquivos
    // soltos na raiz, e não em build/dist/. Um find atrás de build/dist/ falhou
    // com "No such file or directory" mesmo com os arquivos baixados.
    expect(job('publish'), 'o download precisa ir para build/').to.include('path: build');
    expect(job('publish'), 'o find tem de olhar na raiz do download').to.include('find build -maxdepth 1');
    expect(job('publish'), 'nada de build/dist/ em comando').to.not.match(/(find|cat|cp)\s+[^\n|]*build\/dist/);
    const caminhos = job('publish').match(/(?:find|cat|cp|--notes-file)\s+[^\n|]*/g) || [];
    for (const linha of caminhos) {
      expect(linha, `caminho relativo a dist/ no publish: ${linha}`).to.not.match(/(^|\s|\/)dist\//);
    }
  });

  it('publica o portable além do instalador', () => {
    // A build já produzia a pasta descompactada (168 MB em build/), que não
    // serve para download. O alvo `portable` do electron-builder é o .exe
    // único, com nome versionado, e sem ele a release oferece só instalador.
    const pkg = JSON.parse(read('package.json'));
    const alvos = pkg.build.win.target.map((t) => (typeof t === 'string' ? t : t.target));
    expect(alvos, 'o alvo portable precisa estar declarado').to.include('portable');
    expect(pkg.build.portable.artifactName, 'e nomeado com a versão').to.include('${version}');

    expect(job('build'), 'o portable é construído no job de build').to.include('electron-builder --win portable');
    // E sai com a versão da release, não com a do package.json: o bump é do
    // publish, então o package.json ainda diz a anterior e o portable saía uma
    // versão atrás do instalador.
    expect(job('build'), 'a versão do portable vem do passo de resolução').to.include('extraMetadata.version=');
    // O manifesto continua apontando para o instalador: é ele que substitui uma
    // instalação. O portable não se atualiza sozinho.
    const script = read('scripts/generate-update-manifest.js');
    expect(script).to.include('KyriosChronos-Setup-${version}.exe');
    expect(script).to.not.include('-portable.exe');
  });

  it('o build não mexe na versão: quem sobe é o publish, depois dos testes', () => {
    // O instalador precisa sair com a versão da release, mas escrevê-la no
    // package.json no build faria o bump acontecer antes dos testes ficarem
    // verdes. O parâmetro -Version resolve: o script estampa o número sem
    // tocar no arquivo.
    const build = job('build');
    const publish = job('publish');

    expect(build, 'o build passa a versão em vez de bumpear').to.include('-Version');
    expect(build, 'o build não bumpeia').to.not.include('npm version');
    expect(build, 'o build não escreve changelog').to.not.include('generate-changelog.js --version');

    expect(publish, 'o bump é do publish').to.include('npm version');
    expect(publish, 'e o changelog também').to.include('generate-changelog.js --version');

    const script = read('Build-Installer.ps1');
    expect(script, 'o script aceita a versão por parâmetro').to.include('[string]$Version');
    // E tira o "v" da tag: o NSIS usa o valor em VIProductVersion e exige
    // X.X.X.X, e um "v" na frente aborta a compilação inteira.
    expect(script).to.include("-replace '^v', ''");

    // O publish só roda com os dois jobs verdes, então é aí - e só aí - que a
    // versão sobe.
    expect(publish).to.match(/needs:\s*\[\s*test\s*,\s*build\s*\]/);
    expect(publish.indexOf('Bump the version')).to.be.greaterThan(-1);
  });

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
    const commitStep = job('publish');
    expect(commitStep).to.include('git add package.json package-lock.json CHANGELOG.md');
  });

  // A run that tagged and then died must not bump again on every re-run.
  it('reaproveita a tag se a execução anterior morreu antes de publicar', () => {
    expect(workflow).to.include('git rev-parse -q --verify "refs/tags/$TAG"');
    expect(workflow).to.include('reaproveitando');
  });

  // A primeira execução automática chegou até o publish e morreu assim:
  //   line 7: TAG: unbound variable
  // A etapa declarava `TAG:` no env:, mas o runner já exporta um `TAG` e o
  // valor não chegava no script; com `set -u` isso mata a etapa antes do
  // primeiro comando. A variável do passo virou RELEASE_TAG.
  it('não usa TAG como nome de variável de ambiente, que colide com o runner', () => {
    const bloco = workflow.slice(workflow.indexOf('Attach artifacts to GitHub Release'));
    expect(bloco).to.include('RELEASE_TAG: ${{ needs.build.outputs.tag }}');
    expect(bloco, 'TAG no env: colide com a do runner').to.not.include('  TAG: ${{ needs.build.outputs.tag }}');
    // E o script transforma em TAG local, que é o nome que o resto do passo usa.
    expect(bloco).to.include('TAG="$RELEASE_TAG"');
  });

  // Toda etapa que roda bash com `set -u` e lê a versão direto da expressão
  // está correta; a que usava env: foi a que quebrou.
  it('nenhuma etapa de bash deixa a tag vinda só do env:', () => {
    const etapas = workflow.split(/\n(?=      - name: )/).slice(1);
    for (const etapa of etapas) {
      if (!/shell:\s*bash/.test(etapa)) continue;
      if (!/set -euo pipefail/.test(etapa)) continue;
      const usaTag = /\$\{?\{?\s*steps\.version\.outputs\.tag/.test(etapa);
      if (usaTag) expect(etapa, 'a versão tem de vir interpolada, não do env:').to.not.match(/^\s*TAG:\s*\$\{\{/m);
    }
  });

  it('bumps a versão com um valor limpo, que é o que a validação exige', () => {
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
    expect(workflow).to.include("if: needs.build.outputs.publish == 'true'");
    expect(workflow).to.not.include("if: github.event_name == 'workflow_dispatch' && inputs.publish");
  });

  // ─── Testes em paralelo com a build, publicação travada pelos dois ───
  //
  // A build é a etapa longa e a suíte não precisa esperar por ela. O que
  // impede um teste vermelho de virar release publicada é o job publish
  // depender dos dois: sem isso o artefato subiria e a release sairia.

  it('tem um job de testes e um de build, e nenhum espera o outro', () => {
    expect(jobs().map((n) => n.trim()), 'três jobs: teste, build e publicação').to.have.lengthOf(3);
    expect(blocoDoJob('test')).to.not.include('needs:');
    expect(blocoDoJob('build')).to.not.include('needs:');
  });

  it('a publicação depende dos dois, e é isso que barra o teste vermelho', () => {
    expect(blocoDoJob('publish')).to.match(/needs:\s*\[\s*test\s*,\s*build\s*\]/);
    // E a publicação é onde mora tudo que escreve no repositório.
    const publish = blocoDoJob('publish');
    for (const passo of ['git push origin "$TAG"', 'gh release create "$TAG"']) {
      expect(publish, passo).to.include(passo);
    }
    // Nada disso pode existir no job de build: seria publicar sem esperar os
    // testes, que é exatamente o que se quer evitar.
    const build = blocoDoJob('build');
    expect(build, 'build não pode empurrar tag').to.not.include('git push origin');
    expect(build, 'build não pode criar release').to.not.include('gh release create');
  });

  it('a suíte roda uma vez só: o build não repete os testes', () => {
    expect(blocoDoJob('test'), 'a suíte fica no job de testes').to.include('run: npm test');
    expect(blocoDoJob('build'), 'o build pula a suíte, que já corre em paralelo').to.include('Build-Installer.ps1 -SkipTests');
    expect(blocoDoJob('build')).to.not.include('run: npm test');
  });

  it('o passo de npm test não pode transformar suite vermelha em pipeline verde', () => {
    const linhas = blocoDoJob('test').split('\n').filter((l) => /^\s*run:/.test(l) && l.includes('npm test'));
    expect(linhas).to.have.lengthOf(1);
    expect(linhas[0].trim()).to.equal('run: npm test');
  });

  it('keeps the package version and the release tag in sync', () => {
    expect(workflow).to.include('does not match package.json version');
    expect(workflow).to.include('npm version "$VERSION" --no-git-tag-version');
    expect(workflow).to.include('git tag -a "$TAG"');
  });

  it('publishes the tag only after tests and the build succeed', () => {
    // Com testes e build em paralelo, a ordem deixa de ser "testes, depois
    // build" no mesmo job: o que garante é o publish depender dos dois. Taguear
    // dentro do job de build publicaria sem esperar a suíte.
    const buildStep = workflow.indexOf('Build installer');
    expect(buildStep, 'o build compila o instalador').to.be.greaterThan(-1);
    expect(job('build'), 'a tag é criada na publicação, não no build').to.not.include('git tag -a');
    expect(job('publish'), 'a tag é criada na publicação').to.include('git tag -a "$TAG"');
    expect(blocoDoJob('publish')).to.match(/needs:\s*\[\s*test\s*,\s*build\s*\]/);
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
