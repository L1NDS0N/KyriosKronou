<#
.SYNOPSIS
    Gera uma arvore de arquivos de teste para o algoritmo de retencao do Kyrios Chronos.

.DESCRIPTION
    Cria snapshots datados em pastas e subpastas, nos formatos que o algoritmo
    realmente reconhece. Os padroes de data foram medidos em
    src\main\sync\retention.js (DATE_PATTERNS):

        2026-09-22          20260922          22-09-2026
        22.09.2026          22_09_2026

    O que a arvore inclui de proposito, para exercitar cada regra do algoritmo:

      * pastas com data no nome (padrao mais comum)
      * subpastas, cada uma com sua propria data - o algoritmo planeja
        subpastas separadamente, com contagem e padrao proprios
      * uma subpasta cujo proprio nome e a data
      * arquivos com data em pasta plana (sem subpasta por data)
      * copias periodicas sem data (semanais, mensais) - nao devem envelhecer
      * arquivos sem data e nao gerenciados (nao devem ser tocados)
      * formatos de arquivo misturados (.7z, .zip, .bak, .sql, .log, .txt)
      * uma subpasta com poucos arquivos datados, que NAO vira arquivo
        proprio (abaixo do limiar de data)

.PARAMETER Root
    Pasta raiz onde a arvore sera criada. Padrao: pasta do script.

.PARAMETER Days
    Quantos dias diarios gerar para tras. Padrao: 400.

.PARAMETER SizeKb
    Tamanho aproximado de cada arquivo, em KB. Padrao: 64.

.PARAMETER Clean
    Remove a arvore anterior antes de gerar. Use -Clean para recomecar.

.EXAMPLE
    .\New-RetentionTestTree.ps1 -Clean -Days 400

.NOTES
    Os arquivos sao falsos: o conteudo e preenchido para ocupar espaco, e a
    data de modificacao e ajustada para a data que esta no nome. O algoritmo
    usa a data do NOME quando encontra, e so cai no mtime quando o nome nao
    tem data - por isso os dois sao ajustados.
#>
[CmdletBinding()]
param(
    [string]$Root = '',
    [int]$Days = 400,
    [int]$SizeKb = 64,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# $PSScriptRoot nao econfiavel no bloco param() quando o script chega por
# -File; resolver aqui evita a falha de "caminho vazio" logo na primeira linha.
if (-not $Root) {
    $aqui = $PSScriptRoot
    if (-not $aqui) { $aqui = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $script:Root = Join-Path $aqui 'retention-testes'
}

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

function New-PaddedFile {
    <# Cria um arquivo com tamanho aproximado e mtime = a data do snapshot.
       O algoritmo le a data do NOME primeiro; o mtime so importa quando o
       nome nao tem data. Ajustar os dois deixa o cenario realista. #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][datetime]$Date,
        [int]$Kb = 64,
        [string]$Fill = 'x'
    )

    $dir = Split-Path $Path -Parent
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    # 1 KB de conteudo ficticio por vez, para nao estourar memoria em lotes grandes.
    $bloco = ($Fill * 1024)
    $escritos = [int][math]::Max(1, [math]::Floor($Kb))
    $fs = [System.IO.File]::Create($Path)
    try {
        for ($i = 0; $i -lt $escritos; $i++) {
            $bytes = [System.Text.Encoding]::ASCII.GetBytes($bloco)
            $fs.Write($bytes, 0, $bytes.Length)
        }
    } finally {
        $fs.Dispose()
    }

    $st = Get-Item $Path
    $st.CreationTime  = $Date
    $st.LastWriteTime = $Date
    $st.LastAccessTime = $Date
}

function Get-Dt {
    param([int]$DaysAgo)
    (Get-Date).Date.AddDays(-$DaysAgo)
}

function New-SnapshotFolder {
    <# Pasta de snapshot diaria no formato AAAA-MM-DD. #>
    param([int]$DaysAgo, [string]$Ext = '7z', [string]$Prefix = 'dump')
    $d = Get-Dt $DaysAgo
    $nome = '{0}-{1}-{2}' -f $d.Year, $d.ToString('MM'), $d.ToString('dd')
    New-PaddedFile -Path (Join-Path $script:Root "$nome\$Prefix.$Ext") -Date $d -Kb $script:SizeKb
}

# ---------------------------------------------------------------------------
# geracao
# ---------------------------------------------------------------------------

if ($Clean -and (Test-Path $Root)) {
    Write-Host "Removendo arvore anterior: $Root" -ForegroundColor Yellow
    Remove-Item $Root -Recurse -Force
}
if (-not (Test-Path $Root)) {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
}

Write-Host "Gerando arvore de testes de retencao em: $Root" -ForegroundColor Cyan
Write-Host "  $Days dias diarios, arquivos de ~${SizeKb} KB" -ForegroundColor DarkGray

# --- 1) Snapshots diarios na raiz (padrao principal) ---
# Do mais novo para o mais antigo: e assim que a arvore fica no disco.
for ($i = 0; $i -lt $Days; $i++) {
    New-SnapshotFolder -DaysAgo $i -Ext '7z'
}

# --- 2) Subpastas independentes (cada uma e seu proprio arquivo) ---
# O algoritmo trata cada subpasta com 60%+ de arquivos datados como um
# arquivo separado, com contagem e regra proprias. Estas duas tem alta
# densidade de datas e por isso DEVEM virar arquivos independentes.
foreach ($sub in @('cliente-a', 'cliente-b')) {
    $subDir = Join-Path $Root $sub
    New-Item -ItemType Directory -Path $subDir -Force | Out-Null
    for ($i = 0; $i -lt 90; $i++) {
        $d = Get-Dt ($i * 4)
        $nome = '{0}-{1}-{2}' -f $d.Year, $d.ToString('MM'), $d.ToString('dd')
        New-PaddedFile -Path (Join-Path $subDir "$nome.$sub-arquivo.zip") -Date $d -Kb 32
    }
}

# --- 3) Subpasta cujo proprio nome e a data ---
# Variante: o nome da pasta carrega a data, e os arquivos dentro dela tambem.
for ($i = 0; $i -lt 20; $i++) {
    $d = Get-Dt ($i * 15)
    $nome = '{0}-{1}-{2}' -f $d.Year, $d.ToString('MM'), $d.ToString('dd')
    New-PaddedFile -Path (Join-Path $Root "$nome\$nome-backup.zip") -Date $d -Kb 48
}

# --- 4) Pasta plana com data nos NOMES dos arquivos (sem pasta por data) ---
$plana = Join-Path $Root 'flat-por-nome'
New-Item -ItemType Directory -Path $plana -Force | Out-Null
for ($i = 0; $i -lt 60; $i++) {
    $d = Get-Dt ($i * 6)
    # Usa o formato DD-MM-AAAA: exercita um padrao diferente do das pastas.
    $nome = 'log-{0}-{1}-{2}.log' -f $d.ToString('dd'), $d.ToString('MM'), $d.Year
    New-PaddedFile -Path (Join-Path $plana $nome) -Date $d -Kb 8 -Fill 'l'
}

# --- 5) Copias periodicas SEM data (nao devem envelhecer por data) ---
# Estas nao tem data no nome. O algoritmo so as trata pela data de modificacao,
# e o que importa aqui e que elas NAO sejam confundidas com as datadas.
$periodicas = Join-Path $Root 'periodicas-sem-data'
New-Item -ItemType Directory -Path $periodicas -Force | Out-Null
$nomes = @('semanal-01.zip', 'semanal-02.zip', 'mensal-01.zip', 'trimestral-01.zip', 'ultimo- backup.zip')
foreach ($n in $nomes) {
    # Data spread no passado recente: se o algoritmo as tratar por mtime, elas
    # envelhecem; se as tratar por "sem data no nome", nao. Este e o teste.
    New-PaddedFile -Path (Join-Path $periodicas $n) -Date (Get-Dt 200) -Kb 96
}

# --- 6) Subpasta com POUCOS datados (nao deve virar arquivo proprio) ---
# Fica abaixo do limiar de 60% de arquivos datados: o algoritmo deve tratar
# como conteudo solto da raiz, nao como um arquivo separado.
$esparsa = Join-Path $Root 'esparsa'
New-Item -ItemType Directory -Path $esparsa -Force | Out-Null
for ($i = 0; $i -lt 3; $i++) {
    $d = Get-Dt ($i * 30)
    $nome = '{0}-{1}-{2}.7z' -f $d.Year, $d.ToString('MM'), $d.ToString('dd')
    New-PaddedFile -Path (Join-Path $esparsa $nome) -Date $d -Kb 16
}
for ($i = 0; $i -lt 12; $i++) {
    New-PaddedFile -Path (Join-Path $esparsa "avulso-$i.txt") -Date (Get-Dt ($i * 10)) -Kb 4 -Fill 'a'
}

# --- 7) Nao gerenciados: nao devem ser tocados pela retencao ---
# Sem data, formato fora da lista (.txt nao esta em .7z/.zip por padrao).
$soltos = Join-Path $Root 'nao-gerenciados'
New-Item -ItemType Directory -Path $soltos -Force | Out-Null
for ($i = 0; $i -lt 10; $i++) {
    New-PaddedFile -Path (Join-Path $soltos "nota-$i.txt") -Date (Get-Dt 500) -Kb 2 -Fill 'n'
}

# --- 8) Formatos extras dentro dos snapshots (para testar o filtro) ---
# Alguns .bak dentro das pastas datadas: se o perfil deixar o filtro aberto,
# eles tambem envelhecem; se filtrar so .7z/.zip, ficam.
for ($i = 0; $i -lt 15; $i++) {
    $d = Get-Dt ($i * 20)
    $nome = '{0}-{1}-{2}' -f $d.Year, $d.ToString('MM'), $d.ToString('dd')
    New-PaddedFile -Path (Join-Path $Root "$nome\outro-$nome.bak") -Date $d -Kb 24 -Fill 'b'
}

# ---------------------------------------------------------------------------
# resumo
# ---------------------------------------------------------------------------

$total = Get-ChildItem $Root -Recurse -File
$mb = [math]::Round((($total | Measure-Object Length -Sum).Sum / 1MB), 1)

Write-Host ""
Write-Host "Arvore criada." -ForegroundColor Green
Write-Host "  Pasta   : $Root"
Write-Host "  Arquivos: $($total.Count)"
Write-Host "  Tamanho : $mb MB"
Write-Host ""
Write-Host "Subpastas:" -ForegroundColor Cyan
Get-ChildItem $Root -Directory | ForEach-Object {
    $c = (Get-ChildItem $_.FullName -Recurse -File | Measure-Object).Count
    "  {0,-28} {1} arquivo(s)" -f $_.Name, $c
}
Write-Host ""
Write-Host "Leia o README.md nesta pasta para o tutorial de como testar a retencao." -ForegroundColor DarkGray
