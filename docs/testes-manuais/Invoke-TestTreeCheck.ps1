<#
    Kyrios Chronos - Roteiro de teste manual.
    Gerado junto com a arvore de retencao. Leia o README.md na pasta.
#>
param()

$ErrorActionPreference = 'Stop'

function Say  { param([string]$m) Write-Host $m -ForegroundColor Cyan }
function Ok   { param([string]$m) Write-Host "  [ok] $m" -ForegroundColor Green }
function Info  { param([string]$m) Write-Host "  $m" -ForegroundColor DarkGray }
function Falha { param([string]$m) Write-Host "  [FALHA] $m" -ForegroundColor Red }

function Test-Arvore {
    param([string]$Raiz)

    $esperados = @{
        'snapshots diarios na raiz' = 400
        'cliente-a' = 90
        'cliente-b' = 90
        'flat-por-nome' = 60
        'periodicas-sem-data' = 5
        'nao-gerenciados' = 10
    }

    Say "Estrutura da arvore"
    foreach ($nome in $esperados.Keys) {
        $caminho = if ($nome -eq 'snapshots diarios na raiz') { $Raiz } else { Join-Path $Raiz $nome }
        if (Test-Path $caminho) { Ok $nome } else { Falha "$nome nao encontrado" }
    }

    $total = (Get-ChildItem $Raiz -Recurse -File | Measure-Object).Count
    Info "total de arquivos: $total"
}

function Test-Retencao {
    param([string]$Raiz)

    Say "Simulacao de retencao (nao apaga nada)"
    $alvo = Join-Path $Raiz 'cliente-a'
    if (-not (Test-Path $alvo)) { Falha "pasta cliente-a ausente"; return }

    $arquivos = Get-ChildItem $alvo -Recurse -File | Sort-Object LastWriteTime
    Info "cliente-a tem $($arquivos.Count) arquivo(s), do mais antigo ao mais novo:"
    Info ("  " + $arquivos[0].Name + "  (" + $arquivos[0].LastWriteTime.ToString('yyyy-MM-dd') + ")")
    Info ("  " + $arquivos[-1].Name + "  (" + $arquivos[-1].LastWriteTime.ToString('yyyy-MM-dd') + ")")
    Info ""
    Info "Abra o Kyrios > Retencao, aponte o Destino para esta pasta e rode a Simulacao."
    Info "Com 'manter as 3 mais novas' a previa deve listar as 87 mais antigas e"
    Info "nunca a mais nova. Confira tambem que MinKeep nao e violado."
}

Write-Host ""
Write-Host "== Verificacao da arvore de testes ==" -ForegroundColor White
Write-Host ""

$raiz = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'retention-testes'
if (-not (Test-Path $raiz)) {
    Write-Host "Arvore ainda nao gerada. Rode antes:" -ForegroundColor Yellow
    Write-Host "  .\New-RetentionTestTree.ps1 -Clean" -ForegroundColor Yellow
    exit 1
}

Test-Arvore   $raiz
Test-Retencao $raiz

Write-Host ""
Write-Host "Tudo conferido. O roteiro de teste manual esta no README.md." -ForegroundColor Green
