// linkPolicy.js - Para onde vai um link clicado no app.
//
// Duas coisas acontecem quando se clica num link hoje, e as duas são ruins:
//
//  1. A página abre numa nova BrowserWindow DENTRO do app. Ela carrega o mesmo
//     preload, ou seja, recebe window.api - a ponte IPC inteira. Uma página de
//     buymeacoffee, ou um link http que a pessoa escreveu na descrição de uma
//     tarefa, passa a ter o mesmo poder que a tela do agendador: mudar
//     configuração, parar o servidor web, abrir diálogo de arquivo. Isso é
//     tomar o controle do aplicativo a partir de uma página de terceiros.
//  2. As duas âncoras de localhost - que são a documentação da API, servida
//     pelo próprio app - abrem dentro dele com o preload em cima.
//
// A correção é no main, não em cada âncora: uma política única aplicada ao
// windowOpen e ao navigate. Corrigir âncora por âncora deixaria de fora os
// links que o app monta em runtime - o bloco de sanitização do rich text
// aceita http, https e mailto digitados pelo usuário, em quantidade ilimitada.
//
// Por que a validação existe: shell.openExternal entrega a URL ao sistema.
// Passar uma string sem esquema - "C:\Windows\System32\calc.exe" ou
// "file:///..." - faz o SO abrir um programa. O Electron avisa sobre isso na
// própria documentação, e o filtro é o que mantém o aviso sem efeito.

const { shell } = require('electron');

// Só isto vai para o navegador. mailto e tel vão para o programa padrão do
// sistema, que é o que a pessoa espera; file: e data: abrirem um executável ou
// um documento com a ponte IPC dentro do app não é uma opção.
const PERMITIDOS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function classificar(candidate) {
  if (typeof candidate !== 'string') return { ok: false, reason: 'linkPolicy.notAString' };
  const bruto = candidate.trim();
  if (!bruto) return { ok: false, reason: 'linkPolicy.empty' };

  // Um "//evil.com" é relativo para o parser e absoluto para o navegador: sem
  // o esquema ele escaparia do filtro e ainda assim abriria um site remoto.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(bruto)) return { ok: false, reason: 'linkPolicy.noScheme' };

  let url;
  try {
    url = new URL(bruto);
  } catch (e) {
    return { ok: false, reason: 'linkPolicy.unparseable' };
  }

  // Um caminho de executável do Windows ("C:\Windows\System32\calc.exe") tem
  // um esquema de letra só, que é o que o Node lê. Ele é barrado aqui, mas o
  // motivo correto é outro: é um caminho local, não um esquema web.
  if (/^[a-z]:[\\/]/i.test(bruto)) return { ok: false, reason: 'linkPolicy.localPath' };

  if (!PERMITIDOS.has(url.protocol)) return { ok: false, reason: 'linkPolicy.schemeNotAllowed' };
  if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.hostname) {
    return { ok: false, reason: 'linkPolicy.noHost' };
  }
  return { ok: true, url };
}

function ehInterno(candidate, paginaDoApp) {
  // Só o arquivo do próprio renderer é navegação interna. Qualquer outra coisa
  // - outro arquivo local, http, data - sai do app.
  if (typeof candidate !== 'string') return false;
  try {
    const url = new URL(candidate);
    if (url.protocol === 'file:') {
      if (!paginaDoApp) return false;
      const base = new URL(paginaDoApp);
      const destino = decodeURIComponent(url.pathname).replace(/\//g, '\\').toLowerCase();
      return destino === decodeURIComponent(base.pathname).replace(/\//g, '\\').toLowerCase();
    }
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * Abre no sistema. Devolve o motivo da recusa em vez de só um booleano: um
 * link recusado sem explicação vira um clique que não faz nada, e a pessoa
 * conclui que o botão está quebrado.
 */
async function abrirExternamente(candidate, deps = {}) {
  const abrir = deps.openExternal || shell.openExternal;
  const classificacao = classificar(candidate);
  if (!classificacao.ok) return { ok: false, reason: classificacao.reason, url: candidate };
  try {
    await abrir(classificacao.url.href);
    return { ok: true, url: classificacao.url.href };
  } catch (e) {
    return { ok: false, reason: 'linkPolicy.openFailed', error: e.message, url: classificacao.url.href };
  }
}

/**
 * Instala a política numa webContents. Cobre os dois caminhos de saída:
 * target="_blank" e will-navigate. Só o primeiro não bastaria - há navegação
 * sem target que também sai do app.
 */
function aplicarEm(webContents, deps = {}) {
  const paginaDoApp = deps.paginaDoApp
    || (webContents.getURL ? webContents.getURL() : null);
  const avisar = deps.avisar || (() => {});

  webContents.setWindowOpenHandler(({ url }) => {
    abrirExternamente(url, deps).then((r) => {
      if (!r.ok) avisar(r.reason, url);
    });
    // deny impede a nova janela. Sem este return, o Electron abriria a página
    // dentro do app com o preload inteiro.
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (ehInterno(url, paginaDoApp)) return;
    event.preventDefault();
    abrirExternamente(url, deps);
  });

  // will-redirect cobre o mesmo caminho vindo de um meta refresh ou de um
  // redirect de servidor, que não passam por will-navigate.
  webContents.on('will-redirect', (event, url) => {
    if (ehInterno(url, paginaDoApp)) return;
    event.preventDefault();
    abrirExternamente(url, deps);
  });
}

module.exports = {
  PERMITIDOS,
  classificar,
  ehInterno,
  abrirExternamente,
  aplicarEm,
};
