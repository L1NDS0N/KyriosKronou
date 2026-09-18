// tests/test-i18n.js
//
// Every user-visible string has to come from the dictionary, or the language
// setting silently stops working for whatever was hardcoded. An earlier pass
// wrote Portuguese straight into the renderer; these tests make that a failure
// rather than something noticed later.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function loadDictionaries() {
  const src = fs.readFileSync(path.join(RENDERER, 'i18n.js'), 'utf8');
  const match = src.match(/const translations = ([\s\S]*?);\s*\n\s*class/);
  expect(match, 'could not read the translations object').to.not.equal(null);
  // eslint-disable-next-line no-eval
  return eval('(' + match[1] + ')');
}

describe('i18n: dictionaries', () => {
  let dict;
  before(() => { dict = loadDictionaries(); });

  it('ships English and Brazilian Portuguese', () => {
    expect(dict).to.have.property('en');
    expect(dict).to.have.property('pt-BR');
  });

  it('has the same keys in both languages', () => {
    const en = Object.keys(dict.en);
    const pt = Object.keys(dict['pt-BR']);

    const missingPt = en.filter(k => !pt.includes(k));
    const missingEn = pt.filter(k => !en.includes(k));

    expect(missingPt, `missing from pt-BR: ${missingPt.join(', ')}`).to.deep.equal([]);
    expect(missingEn, `missing from en: ${missingEn.join(', ')}`).to.deep.equal([]);
  });

  it('has no empty translations', () => {
    for (const [lang, entries] of Object.entries(dict)) {
      for (const [key, value] of Object.entries(entries)) {
        expect(String(value).trim(), `${lang}.${key} is empty`).to.not.equal('');
      }
    }
  });

  it('keeps placeholders consistent between languages', () => {
    const placeholders = (s) => (String(s).match(/{{\w+}}/g) || []).sort();
    for (const key of Object.keys(dict.en)) {
      const inEn = placeholders(dict.en[key]);
      const inPt = placeholders(dict['pt-BR'][key]);
      expect(inPt, `${key}: placeholders differ (en ${inEn} vs pt ${inPt})`).to.deep.equal(inEn);
    }
  });

  it('the English dictionary carries no Portuguese diacritics', () => {
    const suspicious = Object.entries(dict.en)
      .filter(([, v]) => /[ãõçáéíóúâêôà]/i.test(String(v)))
      .map(([k]) => k);
    expect(suspicious, `English entries look Portuguese: ${suspicious.join(', ')}`).to.deep.equal([]);
  });
});

describe('i18n: the renderer does not hardcode user-visible text', () => {
  // Files that build UI markup. Anything Portuguese in here is a string the
  // language switch cannot reach.
  const FILES = ['app.js', 'backupPage.js', 'pathInput.js'];

  it('no Portuguese sentence is written directly into the renderer', () => {
    const offenders = [];

    for (const file of FILES) {
      const src = fs.readFileSync(path.join(RENDERER, file), 'utf8');
      src.split('\n').forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
        // A translation call on the line means the text is already handled.
        if (/i18n\.t\(|tr\(/.test(line)) return;
        // Portuguese-specific characters are the reliable tell.
        if (/[ãõçáéíóúâêô]/i.test(line)) {
          offenders.push(`${file}:${i + 1}  ${trimmed.slice(0, 90)}`);
        }
      });
    }

    expect(offenders, 'these lines hardcode Portuguese instead of using i18n.t:\n' + offenders.join('\n'))
      .to.deep.equal([]);
  });

  it('the main process returns keys, not sentences, for path messages', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'pathSuggest.js'), 'utf8');
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    expect(code).to.include('messageKey');
    expect(code, 'the main process must not choose the language').to.not.match(/message:\s*['"][^'"]{8,}/);
  });

  it('every key the renderer asks for exists in the dictionary', () => {
    const dict = loadDictionaries();
    const known = new Set(Object.keys(dict.en));
    const missing = new Set();

    for (const file of FILES.concat(['index.html'])) {
      const full = path.join(RENDERER, file);
      if (!fs.existsSync(full)) continue;
      const src = fs.readFileSync(full, 'utf8');

      for (const m of src.matchAll(/i18n\.t\(\s*'([^']+)'/g)) {
        if (!known.has(m[1])) missing.add(m[1]);
      }
      for (const m of src.matchAll(/data-i18n="([^"]+)"/g)) {
        if (!known.has(m[1])) missing.add(m[1]);
      }
    }

    expect([...missing], `keys used but never defined: ${[...missing].join(', ')}`).to.deep.equal([]);
  });
});

describe('i18n: higiene do arquivo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8');

  const LINHAS = (texto) => texto.split(/\r?\n/);

  // Uma edicao em massa ja colapsou ~80 entradas numa linha unica atras de um
  // "// Backup Page": 4KB de traducao comentada, viva so na aparencia.
  it('nao tem bloco de chaves escondido dentro de um comentario', () => {
    const comentadas = LINHAS(src).filter(l => /^\s*\/\//.test(l) && /'[a-zA-Z]+\.[a-zA-Z0-9]+':/.test(l));
    expect(comentadas.map(l => l.slice(0, 60)), 'ha traducao comentada').to.deep.equal([]);
  });

  it('nao tem linha gigante, que esconde o que foi mexido', () => {
    const gigantes = LINHAS(src).map((l, i) => [i + 1, l.length]).filter(([, n]) => n > 400);
    expect(gigantes, 'linha longa demais para revisar num diff').to.deep.equal([]);
  });

  // Num objeto literal a ultima definicao vence calada: a tela mostra um texto
  // e o arquivo parece dizer outro.
  it('nao define a mesma chave duas vezes no mesmo idioma', () => {
    const blocos = [...src.matchAll(/^ {2}(?:'?[a-zA-Z-]+'?):\s*\{/gm)].map(m => m.index);
    for (let i = 0; i < blocos.length; i++) {
      const corpo = src.slice(blocos[i], i + 1 < blocos.length ? blocos[i + 1] : src.length);
      const chaves = [...corpo.matchAll(/^\s*'([a-zA-Z]+\.[a-zA-Z0-9]+)':/gm)].map(m => m[1]);
      const repetidas = chaves.filter((k, idx) => chaves.indexOf(k) !== idx);
      expect([...new Set(repetidas)], 'chave repetida no mesmo dicionario').to.deep.equal([]);
    }
  });
});
