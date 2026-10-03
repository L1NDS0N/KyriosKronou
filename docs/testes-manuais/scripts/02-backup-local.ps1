<#
    Kyrios Chronos - Teste 02: perfil de backup (motor local).

    Cria a estrutura de origem que o motor local espera e copia para o destino,
    para voce validar o fluxo completo sem depender de banco de dados.

    Como usar:
      1. Kyrios > Backups > Novo perfil
      2. Motor: local (pasta para pasta)
      3. Origem: aponte para a pasta "backup-origem" criada aqui
      4. Destino: aponte para "backup-destino"
#>
param(
    [string]$Base = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backup-teste'),
    [int]$Arquivos = 500,
    [int]$KbPorArquivo = 32
)

$ErrorActionPreference = 'Stop'

$origem = Join-Path $Base 'backup-origem'
$destino = Join-Path $Base 'backup-destino'

foreach ($p in @($origem, $destino)) {
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}

Write-Host "Origem : $origem" -ForegroundColor Cyan
Write-Host "Destino: $destino" -ForegroundColor Cyan
Write-Host ""

# Arquivos com NOME DE DATA, que e o que a retencao depois vai envelhecer.
# Cada um recebe a data de modificacao igual a do nome, senao o algoritmo cai
# no mtime e o cenario fica diferente do que voce ver na tela.
$bloco = ('d' * 1024)
for ($i = 0; $i -lt $Arquivos; $i++) {
    $d = (Get-Date).Date.AddDays(-($i % 120))
    $nome = '{0}-{1}-{2}' -f $d.Year, $d.ToString('MM'), $d.ToString('dd')
    $arq = Join-Path $origem "$nome-$i.txt"

    $fs = [System.IO.File]::Create($arq)
    try {
        for ($k = 0; $k -lt $KbPorArquivo; $k++) {
            $b = [System.Text.Encoding]::ASCII.GetBytes($bloco)
            $fs.Write($b, 0, $b.Length)
        }
    } finally { $fs.Dispose() }

    $st = Get-Item $arq
    $st.LastWriteTime = $d
}

# Subpastas: o backup tem que recursar nelas.
foreach ($sub in @('cliente-a', 'cliente-b')) {
    $p = Join-Path $origem $sub
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
    for ($i = 0; $i -lt 40; $i++) {
        $d = (Get-Date).Date.AddDays(-($i * 3))
        $nome = '{0}-{1}-{2}.zip' -f $d.Year, $d.ToString('MM'), $d.ToString('dd')
        $arq = Join-Path $p $nome
        Set-Content -Path $arq -Value ("conteudo de teste" * 500)
        (Get-Item $arq).LastWriteTime = $d
    }
}

$total = Get-ChildItem $origem -Recurse -File | Measure-Object Length -Sum
Write-Host ""
Write-Host "Origem criada: $($total.Count) arquivo(s), $([math]::Round($total.Sum / 1MB, 1)) MB" -ForegroundColor Green
Write-Host ""
Write-Host "Confira no Kyrios:" -ForegroundColor Cyan
Write-Host "  1. Backups > Novo perfil > motor local, origem e destino acima"
Write-Host "  2. Executar: os arquivos vao para o destino com data preservada"
Write-Host "  3. Historico > Backups: duracao, bytes e arquivos copiados"
Write-Host "  4. Agora aponte um perfil de Retencao para o DESTINO e rode a simulacao:"
Write-Host "     ela deve envelhecer por data e por contagem"
