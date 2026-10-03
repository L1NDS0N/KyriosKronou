// tests/test-retention-date-patterns.js
//
// O caso que motivo este arquivo: um ambiente de backup real com nomes
// EcoDoacoes<AAAAMMDDHHmm>.zip. O padrao embutido de 8 digitos (20260922) exige
// um nao-digito depois, e com 12 digitos sobra digito - entao o nome nao era
// lido, o arquivo passava a ser datado pelo MTIME, e uma regra de contagem
// apagava backup real sem que a previa apresentasse qualquer aviso.
//
// Nenhum caminho de rede e aberto aqui: os nomes reais entram como texto.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const retention = require('../src/main/sync/retention');

// Nomes copiados de \\theo\bancos2\<cliente> - so a string.
const REAIS = [
  'EcoDoacoes202511182152.zip',
  'EcoDoacoes202601100800.zip',
  'EcoDoacoes202609302152.zip',
  'EcoDoacoes202605272221.7z',
  'EcoDoacoes202603301734.zip',
];

describe('Retencao: padroes de data no nome do arquivo', () => {
  it('le o padrao real do ambiente, com data e hora', () => {
    // 12 digitos: AAAAMMDDHHmm. Era este o formato que nao era reconhecido.
    const d = retention.parseDateFromName('EcoDoacoes202511182152.zip');
    expect(d, 'o nome real tem de ser lido').to.not.equal(null);
    expect(d.toISOString().slice(0, 10)).to.equal('2025-11-18');
  });

  it('le data com hora em segundos tambem', () => {
    const d = retention.parseDateFromName('backup-20260527222130.7z');
    expect(d.toISOString().slice(0, 10)).to.equal('2026-05-27');
  });

  it('continua lendo os cinco formatos que ja funccionavam', () => {
    for (const [nome, esperado] of [
      ['2026-09-22.zip', '2026-09-22'],
      ['backup-20260922.zip', '2026-09-22'],
      ['log-22-09-2026.txt', '2026-09-22'],
      ['snap.22.09.2026.7z', '2026-09-22'],
      ['dump_22_09_2026.sql', '2026-09-22'],
    ]) {
      const d = retention.parseDateFromName(nome);
      expect(d, nome).to.not.equal(null);
      expect(d.toISOString().slice(0, 10), nome).to.equal(esperado);
    }
  });

  it('le data com hora separada por -, _, espaco ou .', () => {
    for (const nome of [
      '2026-09-22-21-52.zip',
      '2026_09_22_21_52.zip',
      '2026-09-22 21-52.zip',
      '22-09-2026-21-52.zip',
    ]) {
      const d = retention.parseDateFromName(nome);
      expect(d, nome).to.not.equal(null);
      expect(d.toISOString().slice(0, 10), nome).to.equal('2026-09-22');
    }
  });

  it('le barra como dia/mes/ano', () => {
    const d = retention.parseDateFromName('relatorio-22/09/2026.pdf');
    expect(d).to.not.equal(null);
    expect(d.toISOString().slice(0, 10)).to.equal('2026-09-22');
  });

  it('recusa data que nao existe no calendario', () => {
    for (const nome of ['2026-02-30.zip', 'EcoDoacoes202602300800.zip', '30-02-2026.zip']) {
      expect(retention.parseDateFromName(nome), nome).to.equal(null);
    }
  });

  it('nao confunde numero de versao com data', () => {
    // 12 digitos comecando em 2099 saoFuturos e nao sao snapshot.
    expect(retention.parseDateFromName('app-209912312359.zip')).to.equal(null);
  });
});

describe('Retencao: regex customizado nas opcoes avancadas', () => {
  it('le o padrao que o usuario escreve', () => {
    // Formato que nenhum padrao embutido pega: ano, mes, dia, com sufixo.
    const d = retention.parseDateFromName('bk_SNAP_v1_2026-09-22_final.zip', '_SNAP_v(\\d{4})-(\\d{2})-(\\d{2})_');
    expect(d).to.not.equal(null);
    expect(d.toISOString().slice(0, 10)).to.equal('2026-09-22');
  });

  it('aceita grupos nomeados, que e a forma legivel de escrever', () => {
    const d = retention.parseDateFromName('AA_2026_09_22_BB', 'AA_(?<year>\\d{4})_(?<month>\\d{2})_(?<day>\\d{2})_BB');
    expect(d).to.not.equal(null);
    expect(d.toISOString().slice(0, 10)).to.equal('2026-09-22');
  });

  it('o custom tem precedencia sobre os embutidos', () => {
    // O nome tem duas datas; sem o custom a primeira vale, com ele a segunda.
    const nome = '2020-01-01_cliente_2026-09-22.zip';
    const d = retention.parseDateFromName(nome, 'cliente_(\\d{4})-(\\d{2})-(\\d{2})');
    expect(d.toISOString().slice(0, 10)).to.equal('2026-09-22');
  });

  it('um regex invalido e recusado com motivo, nao silenciosamente ignorado', () => {
    for (const [regex, motivo] of [
      ['(unclosed', 'invalid'],
      ['((.+)+)+', 'nestedRepeat'],
      ['(?<=\\d{4})', 'lookaround'],
      ['[a-z]+', 'noCapture'],
      ['abc', 'noDigits'],
      ['x'.repeat(300), 'tooLong'],
    ]) {
      const r = retention.validateDatePattern(regex);
      expect(r.ok, regex).to.equal(false);
      expect(retention.padraoReason(r.reason), regex).to.be.a('string').and.not.equal('');
    }
  });

  it('aceita regex vazio, que e "usar so os padroes embutidos"', () => {
    const r = retention.validateDatePattern('');
    expect(r.ok).to.equal(true);
    expect(r.vazio).to.equal(true);
  });
});

describe('Retencao: o regex viaja ate a analise e a execucao', () => {
  function cenario() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-padrao-'));
    const cliente = path.join(dir, 'AACCMS');
    fs.mkdirSync(cliente, { recursive: true });
    const agora = Date.now();
    const dia = 86400000;
    const nomes = REAIS.slice(0, 5);
    nomes.forEach((n, i) => {
      const arq = path.join(cliente, n);
      fs.writeFileSync(arq, 'x'.repeat(32));
      const t = new Date(agora - (nomes.length - i) * 20 * dia);
      fs.utimesSync(arq, t, t);
    });
    return { dir, cliente, nomes, agora };
  }

  it('o padrao real ja e lido SEM regex custom', () => {
    // Este era o bug: o nome de 12 digitos nao era reconhecido e o arquivo
    // passava a ser datado pelo mtime. Com o padrao novo ele e lido sozinho.
    const { dir, cliente } = cenario();
    try {
      const a = retention.analyze(cliente, { useNames: true, extensions: ['.zip', '.7z'] });
      expect(a.withDates, 'o padrao embutido tem de ler o nome real').to.equal(5);
      expect(a.ignored).to.deep.equal([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('sem o padrao novo, o nome real cairia no mtime - e isso nao pode mais acontecer', () => {
    // Guarda contra regressão: o nome de 12 digitos precisa continuar lido
    // como data do NOME, e não como data de modificação.
    for (const nome of REAIS) {
      const d = retention.parseDateFromName(nome);
      expect(d, nome).to.not.equal(null);
    }
    // E a data tem de vir do nome: 2025-11-18 no nome, 2025-11-18 lido.
    expect(retention.parseDateFromName('EcoDoacoes202511182152.zip').toISOString().slice(0, 10)).to.equal('2025-11-18');
  });

  it('com o regex custom, a previa e a execucao leem a mesma data', () => {
    const { dir, cliente, agora } = cenario();
    const padrao = 'EcoDoacoes(\\d{4})(\\d{2})(\\d{2})';
    try {
      const arquivos = retention.scanDest(cliente);
      const comPadrao = retention.compile({
        Enabled: true, ByCount: true, KeepCount: 2, MinKeep: 0,
        DateSource: 'names', FileExtensions: ['.zip', '.7z'], DatePatternRegex: padrao,
      });
      const plano = retention.planDeletion(arquivos, comPadrao, { now: agora });

      // Os três mais antigos pela DATA DO NOME. Datas: 2025-11-18, 2026-01-10,
      // 2026-09-30, 2026-05-27 e 2026-03-30 - as três mais velhas são
      // 2025-11-18, 2026-01-10 e 2026-03-30. O rel vem sem o prefixo da pasta
      // porque o scan foi feito a partir dela.
      const esperadas = [REAIS[0], REAIS[1], REAIS[4]].sort();
      expect(plano.delete.map((d) => d.rel).sort()).to.deep.equal(esperadas);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('a analise usa o regex custom quando a data vem do nome', () => {
    // Formato que NENHUM padrao embutido pega: ano.mes.dia com ponto.
    // O custom existe para isso - o prefixo do nome nao importa, o que
    // importa e o formato da data em si.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-custom-'));
    try {
      const c = path.join(dir, 'BANCOS');
      fs.mkdirSync(c, { recursive: true });
      for (const n of ['bk_V3_2024.03.11_a.zip', 'bk_V3_2024.04.11_a.zip']) {
        fs.writeFileSync(path.join(c, n), 'x');
      }
      const semPadrao = retention.analyze(c, { useNames: true, extensions: ['.zip'] });
      expect(semPadrao.withDates, 'AAA.MM.DD nao esta entre os padroes embutidos').to.equal(0);

      const comPadrao = retention.analyze(c, {
        useNames: true, extensions: ['.zip'],
        datePattern: 'bk_V\\d+_(\\d{4})\\.(\\d{2})\\.(\\d{2})_',
      });
      expect(comPadrao.withDates, 'com o padrao, os dois sao lidos').to.equal(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('um padrao invalido impede a compilacao, em vez de virar passe livre', () => {
    const c = retention.compile({
      Enabled: true, ByCount: true, KeepCount: 2, MinKeep: 0,
      DateSource: 'names', DatePatternRegex: '((.+)+)+',
    });
    expect(c.ok).to.equal(false);
    expect(c.datePatternError).to.be.a('string');
    expect(c.error).to.contain('inválido');
  });

  it('um padrao invalido impede a analise, e nao e ignorado em silencio', () => {
    // A falha perigosa: preview mostrava zero arquivos com data e todo mundo
    // caia no mtime, que e o que a pessoa nao esperava. analyze() tem que
    // recusar igual a compile(), senao a tela mente.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-bad-'));
    try {
      const c = path.join(dir, 'X');
      fs.mkdirSync(c, { recursive: true });
      fs.writeFileSync(path.join(c, 'bk-2024-03-11.zip'), 'x');

      const r = retention.analyze(c, { useNames: true, extensions: ['.zip'], datePattern: '((.+)+)+' });
      expect(r.ok, 'a analise tem de recusar o padrao perigoso').to.equal(false);
      expect(r.datePatternError).to.be.a('string');
      expect(r.error).to.contain('inválido');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('um padrao valido passa pela analise', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyrios-ok-'));
    try {
      const c = path.join(dir, 'X');
      fs.mkdirSync(c, { recursive: true });
      fs.writeFileSync(path.join(c, 'bk_2024-03-11.zip'), 'x');
      const r = retention.analyze(c, { useNames: true, extensions: ['.zip'], datePattern: 'bk_(\\d{4})-(\\d{2})-(\\d{2})' });
      expect(r.ok).to.equal(true);
      expect(r.withDates).to.equal(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('o padrao so vale quando a data vem do nome', () => {
    // Em modo metadata o nome nunca e lido, e um regex estragado nao pode
    // travar a varredura de um destino inteiro.
    const c = retention.compile({
      Enabled: true, ByCount: true, KeepCount: 2, MinKeep: 0,
      DateSource: 'metadata', DatePatternRegex: '((.+)+)+',
    });
    expect(c.ok).to.equal(true);
  });
});
