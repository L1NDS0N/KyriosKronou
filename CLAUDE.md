# Kyrios Chronos

Agendador de tarefas e ferramenta de backup para Windows: app Electron, serviço
Windows headless e painel web — as três superfícies rodando o mesmo código.

- **Nome**: Kyrios Chronos. Dentro do sistema e da UI, o nome aparece em **alfabeto grego**
  (Κύριος Χρόνος). Fora — pastas, arquivos, `.exe`, nome do serviço, repositório — **latino**
  (`KyriosChronos`). Nunca misture: nome de arquivo em grego quebra o instalador e o NSSM.
- **Idiomas da UI**: pt-BR e en. Toda string visível passa pelo i18n.

## Comandos

| | |
|---|---|
| `npm test` | Suíte completa (mocha). **Tem que passar antes de commitar.** |
| `npx mocha tests/test-x.js` | Um arquivo só |
| `npm start` | App em desenvolvimento |
| `node .claude/hooks/graphify.js` | Regenera o grafo do código (veja a skill `graphify`) |
| `node scripts/package-app.js` | Empacota (não use `electron-packager` pela linha de comando) |
| `./Build-Installer.ps1` | Instalador NSIS |

## Arquitetura

```
src/renderer  ──window.api──▶ src/main/preload.js ──IPC──▶ main.js ──▶ src/main/*
src/web       ────fetch─────▶ src/main/apiServer.js ──────────────────▶ src/main/*
                              src/main/serviceScheduler.js ───────────▶ src/main/*
```

`src/main/*` não conhece Electron nem Express — é o que permite o serviço carregar
os mesmos módulos. **Nada em `src/main/` que o serviço use pode importar `electron`.**

Antes de mexer num módulo, consulte `graphify-out/CODEBASE-GRAPH.md` (quem depende dele)
e, para trabalho no painel web, `graphify-out/PARIDADE-WEB.md`.

## Regras que vieram de bugs reais

Cada uma destas custou um diagnóstico. Não as reverta sem reproduzir o bug original.

- **Dados compartilhados ficam em `%ProgramData%\KyriosChronos`**, via `src/main/paths.js` —
  nunca `%APPDATA%`. O serviço roda como LocalSystem e enxerga outro `%APPDATA%`: a GUI
  gravava a configuração onde o serviço nunca leria.
- **O serviço roda o binário do Electron com `ELECTRON_RUN_AS_NODE=1`**, como Node puro.
  Assim funciona na sessão 0, sem GPU e sem exigir Node instalado no servidor.
- **Só um agendador executa por vez**, por lease com heartbeat (`schedulerCore.js`): o serviço
  toma da GUI, a GUI nunca toma de volta. `EPERM` ao checar um PID conta como vivo — o processo
  é de outro usuário, não está morto.
- **Senha de MySQL vai por `--defaults-file` escrito em UTF-8.** Passar `-p` na linha de comando
  corrompe senha não-ASCII no Windows (era o `1045 Access denied` em produção).
- **`.bat`/`.cmd` recebem argumentos crus num array**, nunca com aspas manuais — `execFile`
  reescapa e o comando nunca roda.
- **Métricas do Windows vêm de classes CIM `Win32_PerfFormattedData_*`**, não de `typeperf`
  nem `Get-Counter`: os nomes dos contadores são traduzidos e quebram fora do inglês.
- **Empacotar é sempre por `scripts/package-app.js`** (API Node). O `cmd.exe` come o `^` de
  `--ignore=^/dist`, o padrão deixa de ser ancorado e apaga `node_modules/*/dist`.
- **O ícone tem três origens independentes** e acertar uma não acerta as outras: ícone do
  `.exe` (packager), da janela/barra de tarefas (`BrowserWindow { icon }` + `setAppUserModelId`)
  e do atalho (o `.ico` solto, nunca um índice dentro do `.exe`). `tests/test-app-icon.js` fixa as três.
- **Execução de tarefa usa `spawn`**, não `execFile`: o log ao vivo depende da saída em fluxo.
- **Nenhuma string visível é escrita direto no código** — vai para `src/renderer/i18n.js`, nos
  **dois** dicionários. O `graphify` reporta chave definida em um só idioma.

## Como trabalhar aqui

- **Diagnóstico é por medição, não por dedução.** Quando houver hipótese sobre causa, meça:
  extraia o ícone de verdade, leia os bytes, reproduza contra o MySQL real, dirija o renderer
  por CDP. Mais de uma hipótese "óbvia" já se mostrou errada depois de medida.
- **Verifique na forma de produção**, não só no teste: build empacotado, sob
  `ELECTRON_RUN_AS_NODE`, servindo do `app.asar`.
- **Todo bug corrigido ganha um teste** que falharia antes da correção. A suíte é a rede de
  segurança das três superfícies (hoje ~397 casos).
- **Comentário explica o porquê**, principalmente quando o código parece estranho de propósito
  (é quase sempre um bug antigo). Comentário que narra o que a linha faz, não.
- **Nunca use regex cega para renomear em massa** em `app.js`/`backupPage.js` — já quebrou
  handlers inline. Substituições exatas e verificadas, uma a uma.
- **Alterações de UI se confirmam no app rodando** (CDP na porta 9222), não só por leitura.

## Segurança do painel web

Requisito do usuário: máxima integridade, o painel não pode ser porta de invasão.

- Login por GitHub (Device Flow, só client ID), cookie assinado HttpOnly comparado com
  `timingSafeEqual`, allowlist com negação por padrão.
- Escuta em `127.0.0.1` salvo se `ApiBindAll` estiver ligado explicitamente.
- Senhas nunca saem nas respostas da API.
- Toda ação do painel é auditada com autor e IP (`actor=`, `ip=` no log de auditoria).
