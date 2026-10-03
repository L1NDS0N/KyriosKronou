<#
    Kyrios Chronos - Teste 05: sincronismo (motor local).

    Cria origem e destino com diferencas de proposito, para voce validar:
      - copia do que e novo
      - pulo do que nao mudou (mtime e tamanho iguais)
      - modo espelho (apaga do destino o que sumiu da origem)
      - exclusoes por padrao

    Como usar:
      Kyrios > Sincronismo > Novo perfil > Motor: local
      Origem e destino apontando para as pastas criadas aqui.
#>
param(
    [string]$Base = (Join-Path (Split-Path -Parent $PSScriptRoot) 'sync-teste')
)

$ErrorActionPreference = 'Stop'

$origem = Join-Path $Base 'sync-origem'
$destino = Join-Path $Base 'sync-destino'

# Recomeca do zero para o cenario ser sempre o mesmo.
foreach ($p in @($origem, $destino)) {
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
    New-Item -ItemType Directory -Path $p -Force | Out-Null
}

Write-Host "Origem : $origem" -ForegroundColor Cyan
Write-Host "Destino: $destino" -ForegroundColor Cyan
Write-Host ""

# --- o que so existe na origem: tem de ser copiado ---
foreach ($n in @('novo-1.txt', 'novo-2.txt', 'novo-sub/novo-3.txt')) {
    $arq = Join-Path $origem $n
    $d = Split-Path $arq -Parent
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    Set-Content -Path $arq -Value ("arquivo novo: $n" * 20)
}

# --- identico nos dois lados: tem de ser PULADO ---
foreach ($n in @('igual-1.txt', 'igual-2.txt', 'igual-sub/igual-3.txt')) {
    $conteudo = ("conteudo identico" * 50)
    $a = Join-Path $origem $n
    $b = Join-Path $destino $n
    foreach ($p in @($a, $b)) {
        $d = Split-Path $p -Parent
        if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
        Set-Content -Path $p -Value $conteudo
    }
    # Mesmo mtime dos dois lados: e o mtime que decide "mudou".
    $quando = (Get-Date).AddDays(-10)
    (Get-Item $a).LastWriteTime = $quando
    (Get-Item $b).LastWriteTime = $quando
}

# --- existe nos dois, mas mudou: tem de ser recopiado ---
foreach ($n in @('mudou-1.txt', 'mudou-2.txt')) {
    $a = Join-Path $origem $n
    $b = Join-Path $destino $n
    Set-Content -Path $a -Value ("versao nova" * 80)
    Set-Content -Path $b -Value ("versao antiga" * 80)
    (Get-Item $b).LastWriteTime = (Get-Date).AddDays(-30)
}

# --- so no destino: some SO no modo espelho ---
Set-Content -Path (Join-Path $destino 'orfao.txt') -Value ("sumiu da origem" * 20)
Set-Content -Path (Join-Path $destino 'orfao-sub/so-no-destino.txt') -Value ("tambem" * 20) -ErrorAction SilentlyContinue

# --- excluidos por padrao: nunca devem ser copiados ---
foreach ($d in @('temp', 'node_modules')) {
    $p = Join-Path $origem $d
    New-Item -ItemType Directory -Path $p -Force | Out-Null
    Set-Content -Path (Join-Path $p 'lixo.txt') -Value ("nao deve ir" * 100)
}

$a = Get-ChildItem $origem -Recurse -File | Measure-Object
$b = Get-ChildItem $destino -Recurse -File | Measure-Object
Write-Host ""
Write-Host "Origem : $($a.Count) arquivo(s)" -ForegroundColor Green
Write-Host "Destino: $($b.Count) arquivo(s)" -ForegroundColor Green
Write-Host ""
Write-Host "O que esperar de uma execucao NAO-espelho:" -ForegroundColor Cyan
Write-Host "  copiar    : novo-1, novo-2, novo-sub/novo-3, mudou-1, mudou-2"
Write-Host "  pular     : igual-1, igual-2, igual-sub/igual-3"
Write-Host "  manter    : orfao.txt e orfao-sub/ (o destino nao e apagado)"
Write-Host "  excluir   : temp\ e node_modules\ (use exclusoes 'temp' e 'node_modules')"
Write-Host ""
Write-Host "Depois rode de novo: tudo deve pular, e a execucao fica instantanea."
Write-Host "Depois ligue 'espelho': orfao.txt deve sumir do destino."
