<#
    Kyrios Chronos - Teste 01: criacao e agendamento de tarefas.

    O que exercita:
      - criacao de tarefa com script .ps1 e argumentos
      - execucao manual e registro no historico
      - deteccao de conflito de horario entre tarefas
      - validacao de cron invalido

    Como usar: crie uma tarefa no Kyrios apontando Command para este arquivo,
    ou execute direto pelo powershell para ver a saida.
#>
param(
    [string]$Saida = "$PSScriptRoot\..\_saida"
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Saida)) { New-Item -ItemType Directory -Path $Saida -Force | Out-Null }
$log = Join-Path $Saida 'teste-01-tarefa.log'

function Escrever {
    param([string]$m)
    $linha = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
    Write-Host $linha
    Add-Content -Path $log -Value $linha
}

Escrever "=== inicio ==="
Escrever "PID: $PID"
Escrever "Usuario: $env:USERNAME"
Escrever "Argumentos recebidos: $($args -join ' ')"

# Escreve um arquivo para provar que a execucao realmente aconteceu e onde.
$prova = Join-Path $Saida 'task-01-prova.txt'
Set-Content -Path $prova -Value ("executado em {0}" -f (Get-Date))
Escrever "prova escrita em: $prova"

# Escreve em stderr de proposito: o Kyrios captura as duas saidas e mostra na
# tela de execucao. Se voce ver esta linha vermelha no detalhe, o fluxo funciona.
[Console]::Error.WriteLine("linha em stderr, proposital, para ver no detalhe da execucao")

# Volume de dados: muitas linhas, para a tela de execucao ao vivo ter o que
# rolar. 200 linhas e o suficiente para ver a rolagem sem poluir o historico.
1..200 | ForEach-Object { Escrever "linha de volume $_ de 200" }

Escrever "=== fim ==="
Write-Host ""
Write-Host "Confira no Kyrios:" -ForegroundColor Cyan
Write-Host "  1. Historico > Tarefas: a execucao aparece com saida e duracao"
Write-Host "  2. O arquivo _saida\task-01-prova.txt existe"
Write-Host "  3. A linha em stderr aparece em vermelho no detalhe"
