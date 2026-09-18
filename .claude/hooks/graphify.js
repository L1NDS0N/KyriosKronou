#!/usr/bin/env node
/*
 * Graphify - grafo de conhecimento do Kyrios Chronos.
 *
 * O sistema tem tres superficies que precisam contar a mesma historia: o app
 * desktop (renderer -> preload -> IPC -> main), o painel web (web/app.js ->
 * HTTP -> apiServer -> main) e o servico Windows (serviceScheduler -> main).
 * O que mais quebra aqui e uma superficie ficar para tras da outra, entao o
 * grafo existe sobretudo para medir isso.
 *
 * Nos:     modulo, canal-ipc, api-preload, endpoint, pagina, teste
 * Arestas: preload->ipc, ipc->modulo, renderer->preload, endpoint->modulo,
 *          web->endpoint, teste->modulo, modulo->modulo
 *
 * Saida em graphify-out/ (fora do git):
 *   graph.json         - grafo completo, para consulta programatica
 *   CODEBASE-GRAPH.md  - dossie por modulo e acoplamento
 *   PARIDADE-WEB.md    - o que o desktop faz e o painel web ainda nao
 *   IPC.md             - inventario de canais IPC e endpoints HTTP
 *   index.html         - pagina navegavel com busca, autocontida
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'graphify-out');

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
const ls = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return []; } };
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const uniq = (a) => [...new Set(a)];

function walk(dir, filter, acc = []) {
  for (const e of ls(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'build', 'graphify-out', 'codemirror-modes', 'assets'].includes(e.name)) continue;
      walk(full, filter, acc);
    } else if (filter(e.name)) acc.push(full);
  }
  return acc;
}

const isJs = (n) => n.endsWith('.js') && !n.endsWith('.min.js');

const nos = [];
const arestas = [];
const no = (tipo, id, extra) => { nos.push(Object.assign({ tipo, id }, extra || {})); return id; };
const liga = (de, tipo, para, extra) => arestas.push(Object.assign({ de, tipo, para }, extra || {}));

// --------------------------------------------------- MODULOS (src/main)
const mainFiles = walk(path.join(ROOT, 'src', 'main'), isJs);
const modulos = {};
for (const f of mainFiles) {
  const nome = rel(f).replace('src/main/', '').replace(/\.js$/, '');
  const src = read(f);
  const exporta = uniq([
    ...[...src.matchAll(/^class (\w+)/gm)].map((m) => m[1]),
    ...[...src.matchAll(/module\.exports\s*=\s*\{([^}]*)\}/g)].flatMap((m) =>
      m[1].split(',').map((s) => s.split(':')[0].trim()).filter((s) => /^\w+$/.test(s))),
    ...[...src.matchAll(/module\.exports\s*=\s*(\w+)\s*;/g)].map((m) => m[1]),
  ]);
  modulos[nome] = { nome, arquivo: rel(f), src, exporta, linhas: src.split('\n').length };
  no('modulo', nome, { arquivo: rel(f), exporta, linhas: modulos[nome].linhas });
}

// modulo -> modulo, por require relativo
for (const m of Object.values(modulos)) {
  for (const r of m.src.matchAll(/require\('\.\/([^']+)'\)/g)) {
    const alvo = r[1].replace(/\.js$/, '');
    const chave = modulos[alvo] ? alvo : (modulos[alvo + '/index'] ? alvo + '/index' : null);
    if (chave && chave !== m.nome) liga(m.nome, 'usa', chave);
  }
}

// --------------------------------------------------- PRELOAD -> IPC
const preload = read(path.join(ROOT, 'src', 'main', 'preload.js'));
const apiPreload = [];
for (const m of preload.matchAll(/(\w+)\s*:\s*\([^)]*\)\s*=>\s*ipcRenderer\.(invoke|send)\('([^']+)'/g)) {
  apiPreload.push({ metodo: m[1], canal: m[3] });
  no('api-preload', 'window.api.' + m[1], { canal: m[3] });
  liga('window.api.' + m[1], 'invoca', 'ipc:' + m[3]);
}

// --------------------------------------------------- CANAIS IPC (main.js)
const mainSrc = modulos['main'] ? modulos['main'].src : '';
// Cada handler vai ate o inicio do proximo: e o corpo que diz qual modulo ele usa.
const handlers = [...mainSrc.matchAll(/ipcMain\.handle\('([^']+)'/g)];
const canais = [];
for (let i = 0; i < handlers.length; i++) {
  const canal = handlers[i][1];
  const inicio = handlers[i].index;
  const fim = i + 1 < handlers.length ? handlers[i + 1].index : mainSrc.length;
  const corpo = mainSrc.slice(inicio, fim);
  canais.push({ canal, corpo });
  no('canal-ipc', 'ipc:' + canal, { canal });
  for (const nome of Object.keys(modulos)) {
    const curto = nome.split('/').pop();
    if (curto === 'main') continue;
    if (new RegExp('\\b' + curto + '\\b', 'i').test(corpo)) liga('ipc:' + canal, 'delega', nome);
  }
}

// --------------------------------------------------- ENDPOINTS HTTP (apiServer)
const apiSrc = modulos['apiServer'] ? modulos['apiServer'].src : '';
const rotas = [...apiSrc.matchAll(/this\.app\.(get|post|put|patch|delete)\('([^']+)'/g)];
const endpoints = [];
for (let i = 0; i < rotas.length; i++) {
  const verbo = rotas[i][1].toUpperCase();
  const caminho = rotas[i][2];
  const inicio = rotas[i].index;
  const fim = i + 1 < rotas.length ? rotas[i + 1].index : apiSrc.length;
  const corpo = apiSrc.slice(inicio, fim);
  const id = verbo + ' ' + caminho;
  endpoints.push({ verbo, caminho, id, corpo });
  no('endpoint', id, { verbo, caminho });
  for (const nome of Object.keys(modulos)) {
    const curto = nome.split('/').pop();
    if (['apiServer', 'main'].includes(curto)) continue;
    if (new RegExp('\\b' + curto + '\\b', 'i').test(corpo)) liga(id, 'delega', nome);
  }
}

// --------------------------------------------------- RENDERER -> preload
const rendererFiles = walk(path.join(ROOT, 'src', 'renderer'), isJs);
for (const f of rendererFiles) {
  const nome = rel(f);
  const src = read(f);
  const usa = uniq([...src.matchAll(/window\.api\.(\w+)/g)].map((m) => m[1]));
  if (!usa.length && !/function /.test(src)) continue;
  no('renderer', nome, { linhas: src.split('\n').length, chamadas: usa.length });
  for (const u of usa) liga(nome, 'chama', 'window.api.' + u);
}

// paginas do app, pelos botoes de navegacao
const html = read(path.join(ROOT, 'src', 'renderer', 'index.html'));
for (const m of html.matchAll(/data-page="([^"]+)"/g)) no('pagina', 'desktop:' + m[1], {});
const webHtml = read(path.join(ROOT, 'src', 'web', 'index.html'));
for (const m of webHtml.matchAll(/data-page="([^"]+)"/g)) no('pagina', 'web:' + m[1], {});

// --------------------------------------------------- WEB -> endpoints
const webSrc = read(path.join(ROOT, 'src', 'web', 'app.js'));
const webChamadas = uniq([...webSrc.matchAll(/api\(\s*'([^']+)'/g)].map((m) => m[1].split('?')[0]));
for (const c of webChamadas) {
  // '/api/tasks/' + id casa com a rota /api/tasks/:id
  const alvo = endpoints.find((e) => e.caminho === c)
    || endpoints.find((e) => e.caminho.replace(/:[^/]+/g, '').replace(/\/+$/, '') === c.replace(/\/+$/, ''));
  liga('web/app.js', 'consome', alvo ? alvo.id : c, alvo ? {} : { naoResolvido: true });
}

// --------------------------------------------------- TESTES -> modulos
for (const f of walk(path.join(ROOT, 'tests'), isJs)) {
  const nome = rel(f);
  const src = read(f);
  no('teste', nome, { casos: (src.match(/\bit\(/g) || []).length });
  for (const m of src.matchAll(/require\('\.\.\/src\/main\/([^']+)'\)/g)) {
    const alvo = m[1].replace(/\.js$/, '');
    if (modulos[alvo]) liga(nome, 'cobre', alvo);
  }
  // Varios testes leem o fonte em vez de importar: conta igual como cobertura.
  for (const m of src.matchAll(/'src', '(?:main|renderer)', '([^']+)'/g)) {
    const alvo = m[1].replace(/\.js$/, '');
    if (modulos[alvo]) liga(nome, 'cobre', alvo);
  }
}

// --------------------------------------------------- PARIDADE desktop x web
// Um canal IPC sem endpoint equivalente e uma acao que o painel web nao faz.
// Os dois lados nomeiam a mesma acao de formas diferentes: 'add-task' de um
// lado, 'POST /api/tasks' do outro. Casar o verbo e o recurso reconhece o par;
// comparar as strings inteiras nao reconhece nenhum.
const VERBOS = {
  get: 'GET', list: 'GET', read: 'GET', check: 'GET', browse: 'GET',
  add: 'POST', create: 'POST', execute: 'POST', run: 'POST', install: 'POST',
  start: 'POST', stop: 'POST', restart: 'POST', import: 'POST', export: 'POST',
  update: 'PUT', save: 'PUT', set: 'PUT', toggle: 'PUT',
  delete: 'DELETE', remove: 'DELETE', uninstall: 'DELETE',
};
const singular = (s) => s.replace(/ies$/, 'y').replace(/s$/, '');
const palavras = (s) => s.toLowerCase().split(/[-_/]/).filter(Boolean).map(singular);

const paridade = canais.map(({ canal }) => {
  const partes = palavras(canal);
  const verbo = VERBOS[partes[0]] || null;
  const recurso = (verbo ? partes.slice(1) : partes).filter((p) => p !== 'api');
  if (!recurso.length) return { canal, endpoint: null };

  const casa = endpoints.find((e) => {
    if (verbo && e.verbo !== verbo) return false;
    const segmentos = palavras(e.caminho).filter((s) => !s.startsWith(':'));
    return recurso.every((r) => segmentos.includes(r));
  });
  return { canal, endpoint: casa ? casa.id : null };
});
const semWeb = paridade.filter((p) => !p.endpoint);

// --------------------------------------------------- i18n
const i18nSrc = read(path.join(ROOT, 'src', 'renderer', 'i18n.js'));
const definidas = {};
for (const m of i18nSrc.matchAll(/^\s*'([a-zA-Z]+\.[a-zA-Z0-9]+)':/gm)) definidas[m[1]] = (definidas[m[1]] || 0) + 1;
const usadas = uniq(rendererFiles.concat([path.join(ROOT, 'src', 'renderer', 'index.html')])
  // Varias telas usam o atalho T('chave'); sem ele o relatorio acusa centenas
  // de chaves orfas que na verdade estao em uso.
  .flatMap((f) => [...read(f).matchAll(/(?:i18n\.t\('|data-i18n="|T\(')([a-zA-Z]+\.[a-zA-Z0-9]+)/g)].map((m) => m[1])));
const i18nFaltando = usadas.filter((k) => !definidas[k]);
const i18nSoUmIdioma = Object.keys(definidas).filter((k) => definidas[k] < 2);
const i18nOrfas = Object.keys(definidas).filter((k) => !usadas.includes(k));

// --------------------------------------------------- saida
fs.mkdirSync(OUT, { recursive: true });
const grafo = {
  geradoEm: new Date().toISOString(),
  nos, arestas,
  resumo: {
    modulos: Object.keys(modulos).length,
    canaisIpc: canais.length,
    endpoints: endpoints.length,
    apiPreload: apiPreload.length,
    testes: nos.filter((n) => n.tipo === 'teste').length,
    paridadeWeb: (paridade.length - semWeb.length) + '/' + paridade.length,
  },
  paridade,
  i18n: { definidas: Object.keys(definidas).length, faltando: i18nFaltando, soUmIdioma: i18nSoUmIdioma, orfas: i18nOrfas },
};
fs.writeFileSync(path.join(OUT, 'graph.json'), JSON.stringify(grafo, null, 2));

const entram = (id) => arestas.filter((a) => a.para === id);
const saem = (id) => arestas.filter((a) => a.de === id);

let md = '# Kyrios Chronos - grafo do codigo\n\nGerado em ' + grafo.geradoEm + '\n\n| | |\n|---|---|\n';
for (const [k, v] of Object.entries(grafo.resumo)) md += '| ' + k + ' | ' + v + ' |\n';
md += '\n## Modulos\n\n| Modulo | Linhas | Exporta | Usa | Usado por | Canais IPC | Endpoints | Testes |\n|---|--:|---|--:|--:|--:|--:|--:|\n';
for (const m of Object.values(modulos).sort((a, b) => b.linhas - a.linhas)) {
  const dentro = entram(m.nome);
  md += '| `' + m.nome + '` | ' + m.linhas + ' | ' + (m.exporta.join(', ') || '-')
    + ' | ' + saem(m.nome).filter((a) => a.tipo === 'usa').length
    + ' | ' + dentro.filter((a) => a.tipo === 'usa').length
    + ' | ' + dentro.filter((a) => a.tipo === 'delega' && a.de.startsWith('ipc:')).length
    + ' | ' + dentro.filter((a) => a.tipo === 'delega' && !a.de.startsWith('ipc:')).length
    + ' | ' + dentro.filter((a) => a.tipo === 'cobre').length + ' |\n';
}
const semTeste = Object.keys(modulos).filter((n) => !entram(n).some((a) => a.tipo === 'cobre'));
md += '\n## Modulos sem teste\n\n' + (semTeste.map((n) => '- `' + n + '`').join('\n') || 'nenhum') + '\n';
md += '\n## i18n\n\n- chaves definidas: ' + Object.keys(definidas).length
  + '\n- usadas sem definicao: ' + i18nFaltando.length + (i18nFaltando.length ? ' - ' + i18nFaltando.map((k) => '`' + k + '`').join(', ') : '')
  + '\n- definidas em um so idioma: ' + i18nSoUmIdioma.length + (i18nSoUmIdioma.length ? ' - ' + i18nSoUmIdioma.map((k) => '`' + k + '`').join(', ') : '')
  + '\n- definidas e nunca usadas: ' + i18nOrfas.length + '\n';
fs.writeFileSync(path.join(OUT, 'CODEBASE-GRAPH.md'), md);

let par = '# Paridade desktop x web\n\nGerado em ' + grafo.geradoEm + '\n\n'
  + 'O painel web cobre **' + (paridade.length - semWeb.length) + ' de ' + paridade.length + '** acoes do desktop.\n\n'
  + '## Acoes que o painel web ainda nao faz\n\n| Canal IPC | Delega para |\n|---|---|\n';
for (const p of semWeb) {
  par += '| `' + p.canal + '` | ' + (saem('ipc:' + p.canal).map((a) => '`' + a.para + '`').join(', ') || '-') + ' |\n';
}
par += '\n## Endpoints existentes\n\n| Endpoint | Delega para | Consumido pelo painel |\n|---|---|---|\n';
for (const e of endpoints) {
  const consumido = arestas.some((a) => a.de === 'web/app.js' && a.para === e.id);
  par += '| `' + e.id + '` | ' + (saem(e.id).map((a) => '`' + a.para + '`').join(', ') || '-') + ' | ' + (consumido ? 'sim' : 'nao') + ' |\n';
}
const naoCasadas = arestas.filter((a) => a.de === 'web/app.js' && a.naoResolvido);
if (naoCasadas.length) par += '\n## Chamadas do painel sem rota casada\n\n' + naoCasadas.map((a) => '- `' + a.para + '`').join('\n') + '\n';
fs.writeFileSync(path.join(OUT, 'PARIDADE-WEB.md'), par);

let ipcMd = '# Canais IPC e endpoints\n\n## IPC\n\n| Canal | window.api | Delega para |\n|---|---|---|\n';
for (const c of canais) {
  const api = apiPreload.filter((a) => a.canal === c.canal).map((a) => '`' + a.metodo + '`').join(', ');
  ipcMd += '| `' + c.canal + '` | ' + (api || '-') + ' | ' + (saem('ipc:' + c.canal).map((a) => '`' + a.para + '`').join(', ') || '-') + ' |\n';
}
const semHandler = apiPreload.filter((a) => !canais.some((c) => c.canal === a.canal));
if (semHandler.length) ipcMd += '\n## window.api sem handler no main\n\n' + semHandler.map((a) => '- `' + a.metodo + '` -> `' + a.canal + '`').join('\n') + '\n';
fs.writeFileSync(path.join(OUT, 'IPC.md'), ipcMd);

// pagina navegavel, sem rede
const dados = JSON.stringify(grafo).split('<').join('\\u003c');
fs.writeFileSync(path.join(OUT, 'index.html'), '<!doctype html><meta charset="utf-8">\n'
  + '<title>Kyrios Chronos - grafo</title>\n'
  + '<style>\n'
  + ' :root{color-scheme:dark}\n'
  + ' body{background:#0d1117;color:#c9d1d9;font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px}\n'
  + ' h1{font-size:20px} input{width:100%;padding:10px;margin:12px 0;background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:8px;font-size:14px}\n'
  + ' .n{border:1px solid #30363d;border-radius:8px;padding:10px 12px;margin:6px 0;background:#161b22}\n'
  + ' .t{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;background:#1f6feb33;color:#58a6ff;margin-right:8px}\n'
  + ' .e{color:#8b949e;font-size:12px;font-family:ui-monospace,monospace}\n'
  + ' code{color:#7ee787}\n'
  + '</style>\n'
  + '<h1>Kyrios Chronos - grafo do codigo</h1>\n'
  + '<div class="e" id="r"></div>\n'
  + '<input id="q" placeholder="buscar no, canal, endpoint, modulo...">\n'
  + '<div id="o"></div>\n'
  + '<script>\n'
  + 'const G=' + dados + ';\n'
  + "document.getElementById('r').textContent=Object.entries(G.resumo).map(function(p){return p[0]+': '+p[1]}).join(' | ');\n"
  + 'function saem(id){return G.arestas.filter(function(a){return a.de===id})}\n'
  + 'function entram(id){return G.arestas.filter(function(a){return a.para===id})}\n'
  + 'function render(f){\n'
  + "  var q=(f||'').toLowerCase();\n"
  + "  document.getElementById('o').innerHTML=G.nos.filter(function(n){return !q||n.id.toLowerCase().indexOf(q)>=0||n.tipo.indexOf(q)>=0})\n"
  + '    .slice(0,300).map(function(n){\n'
  + '      var s=saem(n.id), e=entram(n.id);\n'
  + '      return \'<div class="n"><span class="t">\'+n.tipo+\'</span><code>\'+n.id+\'</code>\'\n'
  + "        +(n.arquivo?'<div class=\"e\">'+n.arquivo+'</div>':'')\n"
  + "        +(s.length?'<div class=\"e\">-&gt; '+s.map(function(a){return a.tipo+' '+a.para}).join(', ')+'</div>':'')\n"
  + "        +(e.length?'<div class=\"e\">&lt;- '+e.map(function(a){return a.de+' ('+a.tipo+')'}).join(', ')+'</div>':'')\n"
  + "        +'</div>';\n"
  + "    }).join('');\n"
  + '}\n'
  + "document.getElementById('q').addEventListener('input',function(e){render(e.target.value)});\n"
  + "render('');\n"
  + '</' + 'script>');

console.log('graphify-out/ escrito');
for (const [k, v] of Object.entries(grafo.resumo)) console.log('  ' + k + ': ' + v);
