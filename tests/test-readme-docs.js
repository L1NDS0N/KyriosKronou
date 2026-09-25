const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

describe('README documentation', () => {
  it('links every screenshot that exists in the repository', () => {
    const links = [
      ...[...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]),
      ...[...readme.matchAll(/<img[^>]+src="([^"]+)"/g)].map(match => match[1]),
    ].filter(link => link.startsWith('./docs/screenshots/'));
    expect(links).to.have.length.of.at.least(13);
    for (const link of links) {
      const file = path.join(ROOT, link);
      expect(fs.existsSync(file), link).to.equal(true);
      expect(fs.statSync(file).size, link).to.be.greaterThan(20000);
    }
  });

  it('documents every top-level screen with a caption', () => {
    for (const term of ['Dashboard', 'Tarefas', 'Backups', 'Sincronismo', 'Retenção', 'Serviços', 'Histórico', 'Calendário', 'Logs', 'Configurações']) {
      expect(readme).to.include(term);
    }
  });

  it('explains how the images are generated', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts', 'capture-readme-screenshots.js'), 'utf8');
    expect(readme).to.include('npx electron scripts/capture-readme-screenshots.js');
    expect(script).to.include("i18n.setLang('pt-BR')");
    for (const image of fs.readdirSync(path.join(ROOT, 'docs', 'screenshots'))) {
      expect(script).to.include(image);
    }
  });

  it('carries search terms and hashtags for repository discovery', () => {
    for (const tag of ['#Windows', '#Electron', '#Cron', '#NSSM', '#MySQL', '#SQLServer', '#BackupRetention', '#Automation']) {
      expect(readme).to.include(tag);
    }
  });
});
