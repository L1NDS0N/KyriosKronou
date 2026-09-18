---
name: graphify
description: Gera/atualiza o grafo de conhecimento do Kyrios Chronos — módulos do main, canais IPC, API do preload, endpoints HTTP do painel web, telas, testes e chaves i18n, com as ligações entre eles. Use quando precisar de um mapa atualizado do código, ao avaliar o impacto de uma alteração, ao verificar se o painel web está em paridade com o desktop, ou quando o usuário pedir "graphify".
---

# Graphify — grafo do código do Kyrios Chronos

```
node .claude/hooks/graphify.js
```

Escreve em `graphify-out/` (fora do git):

| Arquivo | Conteúdo |
|---|---|
| `index.html` | Página navegável com busca, para abrir no navegador (autocontida, sem rede) |
| `CODEBASE-GRAPH.md` | Dossiê por módulo, acoplamento, módulos sem teste e saúde do i18n |
| `PARIDADE-WEB.md` | O que o desktop faz e o painel web ainda não — a lista de trabalho da paridade |
| `IPC.md` | Inventário de canais IPC, o método `window.api` de cada um e para onde delegam |
| `graph.json` | Grafo completo — nós e arestas tipados, para consulta programática |

## Por que ele existe

O sistema tem três superfícies que precisam contar a mesma história:

```
renderer  ──window.api──▶  preload  ──IPC──▶  main.js  ──▶  módulos
web/app.js ────fetch────▶  apiServer ────────────────────▶  módulos
serviceScheduler ───────────────────────────────────────▶  módulos
```

O que mais quebra aqui é uma superfície ficar para trás da outra — o painel web
sem uma ação que o desktop tem, ou uma chave i18n só em um idioma. O grafo
existe sobretudo para medir isso.

## O que o grafo sabe

**Nós:** módulo (`src/main/*`) · canal IPC · `window.api.*` · endpoint HTTP · arquivo do renderer · tela · teste

**Arestas:**

| Aresta | Origem da informação |
|---|---|
| `window.api.x` → canal IPC | `contextBridge.exposeInMainWorld` em `preload.js` |
| canal IPC → módulo | corpo de cada `ipcMain.handle` em `main.js`, até o próximo handler |
| renderer → `window.api.x` | ocorrências de `window.api.` em `src/renderer/*.js` |
| endpoint → módulo | corpo de cada `this.app.get/post/...` em `apiServer.js` |
| `web/app.js` → endpoint | chamadas `api('/api/…')`, casadas inclusive com rotas `:param` |
| teste → módulo | `require('../src/main/x')`, e também os testes que leem o fonte |
| módulo → módulo | `require('./x')` |

## Como usar

- **Continuar a paridade do painel web:** `PARIDADE-WEB.md` — a primeira tabela é
  a lista do que falta, com o módulo que cada ação usa.
- **Avaliar o impacto de mexer num módulo:** a coluna *Usado por* em
  `CODEBASE-GRAPH.md`, e as arestas que entram nele no `index.html`.
- **Achar quem atende uma ação da tela:** `IPC.md` vai de `window.api.x` até o módulo.
- **Conferir o i18n:** a seção *i18n* lista chave usada sem definição, chave
  definida em um só idioma e chave órfã.
- **Consulta precisa:** `graph.json`, filtrando `arestas` por `tipo`.

## Limites conhecidos

- A ligação canal→módulo e endpoint→módulo é por menção do nome do módulo dentro
  do corpo do handler. É generosa: pode listar um módulo apenas citado num
  comentário. Serve para navegar, não para concluir que algo é código morto.
- A paridade casa verbo + recurso (`add-task` ↔ `POST /api/tasks`). É
  conservadora de propósito: quando os dois lados nomeiam o recurso de formas
  diferentes (`get-backup-profiles` vs `/api/backups`) ela reporta como falta.
  Confirme antes de implementar de novo o que já existe.
- Só enxerga `ipcMain.handle` em `main.js` e rotas declaradas literalmente em
  `apiServer.js`. Rota montada dinamicamente não aparece.

## Quando regenerar

Sempre que criar/remover canal IPC, endpoint, módulo, tela ou teste. O grafo
envelhece em silêncio. Nunca versione `graphify-out/`.
