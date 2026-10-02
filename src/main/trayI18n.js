// trayI18n.js - Dicionário do menu da bandeja.
//
// O menu da bandeja vive no processo main e o i18n.js do projeto é um script de
// renderer: depende de window e localStorage. Este módulo carrega o MESMO
// arquivo i18n.js num contexto sem DOM e expõe só o que o menu precisa, para
// que a bandeja e a janela nunca falem em dizer coisas diferentes.
//
// Se um dia main.js passar a falar com o renderer o tempo todo, isto vira um
// require direto do i18n e sai de cena.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'renderer', 'i18n.js');

let cache = null;
let langAtual = 'en';

function carregar() {
  if (cache) return cache;
  const fonte = fs.readFileSync(SOURCE, 'utf8');
  // O i18n.js termina em "const i18n = new I18n()". Um const de topo não vira
  // propriedade do contexto, então é preciso expor explicitamente - sem isso a
  // bandeja receberia undefined e cairia no texto cru.
  const contexto = {
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    navigator: { language: 'en-US' },
    console,
  };
  contexto.window = contexto;
  vm.createContext(contexto);
  vm.runInContext(`${fonte}\n;this.__i18n = i18n;`, contexto);
  cache = contexto.__i18n;
  return cache;
}

// O idioma vem do renderer, que é quem guarda a preferência do usuário. Sem
// isso a bandeja ficaria sempre em inglês dentro de um app em português.
function setLang(lang) {
  const i18n = carregar();
  langAtual = lang === 'pt-BR' ? 'pt-BR' : 'en';
  try { i18n.setLang(langAtual); } catch (e) { /* mantém o anterior */ }
}

function t(chave, params) {
  const i18n = carregar();
  try {
    const valor = i18n.t(chave, params);
    // A chave devolvida é sinal de que a tradução não existe: melhor o texto
    // técnico visível do que nada.
    return valor === chave ? chave : valor;
  } catch (e) {
    return chave;
  }
}

module.exports = { setLang, t, getLang: () => langAtual, carregar };