# Kyrios Chronos — Roteiro de teste manual

Roteiro de teste manual do Kyrios Chronos, para exercitar as funcionalidades
na mão sem depender do banco de dados e sem esperar um backup de tempo real.

Tudo aqui é falso por construção: os arquivos existem para o algoritmo os
enxergar, e os scripts escrevem em pasta própria. Nada toca `%ProgramData%`.

---

## Começando

```powershell
cd docs\testes-manuais

# 1. Gera a árvore de arquivos para a retenção (~35 MB, leva ~1 minuto)
.\New-RetentionTestTree.ps1 -Clean

# 2. Confere que a árvore ficou como esperado
.\Invoke-TestTreeCheck.ps1
```

O script aceita `-Days` e `-SizeKb` se quiser árvores maiores ou menores:

```powershell
.\New-RetentionTestTree.ps1 -Clean -Days 800 -SizeKb 128
```

A árvore gerada (`retention-testes\`, umas 33 MB) **não vai para o git**: ela
sempre sai igual, e so ocupa espaço no repositório. O script a reconstrói em
qualquer máquina.

---

## O que tem aqui

| Arquivo | Para que serve |
|---|---|
| `New-RetentionTestTree.ps1` | Gera a árvore de snapshots (é o insumo de tudo) |
| `Invoke-TestTreeCheck.ps1` | Confere a estrutura e simula a retenção |
| `scripts\` | Um roteiro por funcionalidade |

Cada roteiro é executável: `.\scripts\01-criar-tarefa.ps1` roda e escreve o
que produziu. Os de número 6, 7 e 9 são só roteiro de leitura — imprimem o
que verificar, na tela do Kyrios, que precisa de banco, serviço ou segunda
máquina.

---

## Os roteiros, na ordem que vale seguir

### 1. `scripts\01-criar-tarefa.ps1`

Cria tarefa, executa script, grava log.

```powershell
.\scripts\01-criar-tarefa.ps1
```

Depois, no Kyrios: **Tarefas → Nova**, tipo `script`, comando apontando para o
script, e rode. O que conferir:

- a execução aparece em **Histórico → Tarefas** com duração e saída;
- `_saida\task-01-prova.txt` foi criado;
- a linha escrita em *stderr* aparece em vermelho no detalhe (o script escreve
  de propósito, para você ver que as duas saídas são capturadas);
- 200 linhas de rolagem — a tela de execução ao vivo mostra rolando.

### 2. `scripts\02-backup-local.ps1`

Origem e destino para testar o motor de backup sem banco de dados.

```powershell
.\scripts\02-backup-local.ps1
```

No Kyrios: **Backups → Novo perfil**, motor `local`, origem `backup-teste\backup-origem`,
destino `backup-teste\backup-destino`. Conferir:

- os arquivos vão para o destino **com a data de modificação preservada**
  (é isso que a retenção usa depois);
- as subpastas `cliente-a` e `cliente-b` são recursadas;
- em **Histórico → Backups** aparecem arquivos, bytes e duração.

### 3. `scripts\03-agenda-e-conflito.ps1`

Lista expresses que devem passar e as que devem ser recusadas.

```powershell
.\scripts\03-agenda-e-conflito.ps1
```

Copie cada expressão para a criação rápida. As que **não** devem passar:

| Expressão | Motivo |
|---|---|
| `99 * * * *` | minuto acima de 59 |
| `* 25 * * *` | hora acima de 23 |
| `1.5 * * * *` | decimal — *já foi bug: `parseInt` truncava e a tela aceitava* |
| `1,,2 * * * *` | lista com elemento vazio |
| `* * * *` | só quatro campos |
| `* * * * * *` | seis campos |

Crie também `0 3 * * *` e `0 3 * * 0-5`: as duas rodam no mesmo minuto, e a
criação rápida deve sugerir um horário livre.

### 4. `scripts\04-retencao-simulacao.ps1`

O mais importante para pegar erro de verdade.

```powershell
.\scripts\04-retencao-simulacao.ps1
```

Ele calcula **com a mesma lógica do Kyrios** o que cada política apagaria — e
não apaga nada. No Kyrios: **Retenção → Novo perfil**, destino apontando para
`retention-testes`, clique em **Simular**.

**Se os números do script e a prévia da tela divergirem, um dos dois está
errado.** É esse o ponto do teste: a tela precisa prever exatamente o que a
execução vai fazer.

Depois de comparar, ligue **MinKeep** e confirme que nenhum dos mais novos
pode sumir. Só então clique em **Aplicar**.

### 5. `scripts\05-sincronismo-local.ps1`

Diferenças de propósito, para cada ramo do planejador.

```powershell
.\scripts\05-sincronismo-local.ps1
```

No Kyrios: **Sincronismo → motor `local`**, origem e destino指示ados. O que
esperar:

| Caso | Arquivos | Resultado |
|---|---|---|
| novo | `novo-1`, `novo-2`, `novo-sub/novo-3` | **copiar** |
| igual | `igual-1`, `igual-2`, `igual-sub/igual-3` | **pular** |
| mudou | `mudou-1`, `mudou-2` | **recopiar** |
| só no destino | `orfao.txt`, `orfao-sub\` | ficam (sem espelho) |
| excluído | `temp\`, `node_modules\` | **nunca** copiar |

Rode duas vezes: a segunda tem que pular tudo. Ligue **espelho** e rode de
novo — `orfao.txt` deve sumir do destino.

### 6. `scripts\06-painel-web.ps1`

Roteiro de painel web e permissões. **Lê o script** — ele é a lista do que
verificar, item por item, incluindo o que é segurança (CSRF, origem, CSP,
senha de backup nunca na resposta).

```powershell
.\scripts\06-painel-web.ps1
```

Para abrir o painel: **Serviços → painel web**.

### 7. `scripts\07-servico-windows.ps1`

Roteiro do serviço. O ponto que mais gera dúvida está lá: **quem é o dono da
execução** quando o serviço e o app estão abertos ao mesmo tempo.

```powershell
.\scripts\07-servico-windows.ps1
```

### 8. `scripts\08-compactacao.ps1`

Deixa um arquivo "em trânsito" de propósito — é o cenário perigoso.

```powershell
.\scripts\08-compactacao.ps1
```

No Kyrios: **Rede → pasta → aba Compactação**. Com a pasta ainda
sincronizando, **Compactar agora não deve fazer nada**. Compactar arquivo pela
metade gera um `.7z` truncado que parece inteiro, e o original é apagado.

### 9. `scripts\09-rede-entre-maquinas.ps1`

Precisa de **duas máquinas** (ou uma VM). Também é o roteiro da atualização do
próprio app: aviso no rodapé, download, instalação.

```powershell
.\scripts\09-rede-entre-maquinas.ps1
```

---

## Como a retenção enxerga um arquivo

Copiado de `src\main\sync\retention.js`. **A data vem do NOME**; o *mtime* só
entra quando o nome não tem data. Estes cinco formatos são reconhecidos:

```
2026-09-22          20260922          22-09-2026
22.09.2026          22_09_2026
```

Uma data que não existe no calendário é recusada (`30-02-2026`), assim como
qualquer data antes de 1970 ou mais de um dia no futuro — esta última porque
`20260922` costuma ser número de versão, não data.

O que **não** é reconhecido, e por isso não deve envelhecer:

- `semanal-01.zip`, `mensal-01.zip` — cópia periódica, sem data no nome;
- `nota-1.txt` — nem data nem formato gerenciado.

---

## As subpastas da árvore, e o que cada uma testa

A árvore é montada com 705 arquivos para que **cada regra** do algoritmo tenha
algo que a exercite:

| Subpasta | Arquivos | Testa |
|---|---|---|
| `2025-08-30/` … | 400 | snapshot diário, o padrão mais comum |
| `cliente-a/`, `cliente-b/` | 90 cada | subpasta densa: vira **arquivo próprio**, com contagem e regra próprias |
| `2025-08-30/` (com arquivo dentro) | 20 | subpasta **cujo nome é a data** |
| `flat-por-nome/` | 60 | data no **nome do arquivo**, sem pasta por data |
| `esparsa/` | 15 | poucos datados (20%): **não** vira arquivo próprio |
| `periodicas-sem-data/` | 5 | sem data no nome: envelhece só pelo *mtime* |
| `nao-gerenciados/` | 10 | `.txt` sem data: **não deve ser tocado** |
| `outro-*.bak` dentro das datadas | 15 | filtro de formato: Some se o perfil filtrar só `.7z`/`.zip` |

O limiar é **60%** de arquivos datados numa subpasta para ela virar arquivo
próprio. `esparsa` fica em 20% justamente para ficar do lado de baixo.

---

## Se algo der errado

O Kyrios grava tudo em `%ProgramData%\KyriosChronos`:

```
config\   tarefas, perfis de backup, sync e retenção, permissões web
logs\     log geral, por auditoria, por tarefa, por backup
logs\nssm\ saída do serviço
```

Para começar do zero (apaga tarefas, perfis e histórico):

```powershell
Remove-Item "$env:ProgramData\KyriosChronos" -Recurse -Force
```

---

## Duas coisas que este roteiro não cobre

**Senhas e conexão real.** Os testes 2 e 5 usam o motor local de propósito.
Para testar MySQL, SFTP ou FTP de verdade, crie o perfil pelo app e use uma
credencial de teste: o roteiro não quis deixar senha em arquivo de texto.

**A rede entre máquinas de verdade.** O teste 9 é um roteiro para você seguir
com duas máquinas; não dá para automatizar de um terminal só.
