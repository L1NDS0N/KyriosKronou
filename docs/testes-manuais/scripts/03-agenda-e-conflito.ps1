<#
    Kyrios Chronos - Teste 03: simulador de agenda e conflito.

    Gera expressoes cron validas e invalidas para voce testar:
      - o validador do agendador
      - a deteccao de conflito de horario
      - a criacao rapida (quick create)

    Voce pode rodar direto para ver a lista, ou colar as expressoes no Kyrios.
#>
param()

$ErrorActionPreference = 'Stop'

$validas = @(
    @{ c = '* * * * *';            d = 'todo minuto' }
    @{ c = '0 3 * * *';            d = '3h todo dia' }
    @{ c = '*/15 * * * *';         d = 'a cada 15 min' }
    @{ c = '0 0 * * 1-5';          d = 'meia-noite, dias uteis' }
    @{ c = '30 2 * * 0';            d = 'domingo as 2h30' }
    @{ c = '0 12 1 * *';           d = 'dia 1 de cada mes, meio-dia' }
    @{ c = '5 4 * * sun';          d = 'domingo as 4h05' }
)

$invalidas = @(
    '99 * * * *'     # minuto acima de 59
    '* 25 * * *'     # hora acima de 23
    '* * 32 * *'     # dia acima de 31
    '* * * 13 *'     # mes acima de 12
    '* * * * 8'      # dia da semana acima de 7
    'abc * * * *'    # texto no lugar de numero
    '* * * *'        # so quatro campos
    '* * * * * *'    # seis campos
    '1.5 * * * *'    # decimal - foi bug real, agora recusado
)

Write-Host ""
Write-Host "EXPRESSOES VALIDAS" -ForegroundColor Green
Write-Host ""
foreach ($v in $validas) {
    Write-Host ("  {0,-16} {1}" -f $v.c, $v.d) -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "EXPRESSOES QUE DEVEM SER RECUSADAS" -ForegroundColor Yellow
Write-Host ""
foreach ($v in $invalidas) {
    Write-Host ("  {0,-16} fora de faixa ou malformada" -f $v) -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Expressoes que colidem de proposito" -ForegroundColor Cyan
Write-Host "  estas duas rodam no mesmo minuto e o agendador deve avisar:" -ForegroundColor DarkGray
Write-Host "    0 3 * * *" -ForegroundColor DarkGray
Write-Host "    0 3 * * 0-5" -ForegroundColor DarkGray
Write-Host ""
Write-Host "Confira no Kyrios:" -ForegroundColor Cyan
Write-Host "  1. Criacao rapida: cole cada expressao invalida e veja o aviso"
Write-Host "  2. Crie duas tarefas com as expressoes que colidem"
Write-Host "  3. A criacao rapida deve sugerir um horario livre"
Write-Host "  4. Agendar: o calendario tem que mostrar o conflito"
