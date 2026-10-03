<#
    Kyrios Chronos - Teste 08: compactacao de arquivos.

    A compactacao roda depois que a pasta termina de sincronizar. Ela apaga o
    original DEPOIS que o compactado e conferido - e nunca deve rodar com a
    pasta ainda recebendo arquivo.

    Este script monta a situation de um arquivo pela metade, para voce conferir
    que ele NAO e compactado.

    Como usar: Kyrios > Rede > pasta > aba Compactacao > modo + Compactar agora.
#>
param(
    [string]$Base = (Join-Path (Split-Path -Parent $PSScriptRoot) 'compactacao-teste')
)

$ErrorActionPreference = 'Stop'

$pasta = Join-Path $Base 'pasta-para-compactar'
if (Test-Path $pasta) { Remove-Item $pasta -Recurse -Force }
New-Item -ItemType Directory -Path $pasta -Force | Out-Null

Write-Host "Pasta: $pasta" -ForegroundColor Cyan
Write-Host ""

# --- casos que devem ser compactados ---
Write-Host "Casos que a compactacao DEVE processar:" -ForegroundColor Green
$alvos = @{
    'grande.sql'     = 2
    'relatorio.pdf'  = 3
    'backup-final.zip' = 1
}
foreach ($nome in $alvos.Keys) {
    $mb = $alvos[$nome]
    $arq = Join-Path $pasta $nome
    $fs = [System.IO.File]::Create($arq)
    try {
        $bloco = [System.Text.Encoding]::ASCII.GetBytes(('d' * 1024))
        for ($i = 0; $i -lt $mb * 1024; $i++) { $fs.Write($bloco, 0, $bloco.Length) }
    } finally { $fs.Dispose() }
    Write-Host ("  {0,-22} {1} MB" -f $nome, $mb) -ForegroundColor DarkGray
}

# --- casos que devem ser ignorados ---
Write-Host ""
Write-Host "Casos que a compactacao deve IGNORAR:" -ForegroundColor Yellow
foreach ($nome in @('nota.txt', 'minúsculo.dat')) {
    $arq = Join-Path $pasta $nome
    Set-Content -Path $arq -Value ("pequeno" * 10)
    Write-Host ("  {0,-22} {1:N0} bytes" -f $nome, (Get-Item $arq).Length) -ForegroundColor DarkGray
}

# --- arquivo pela metade: o cenario perigoso ---
# A compactacao so deve rodar com a pasta em 100%. Se ela rodar com arquivo
# em transito, compactar pela metade produz um .7z truncado que parece inteiro.
$parcial = Join-Path $pasta 'EM-TRANSITO.sql'
$fs = [System.IO.File]::Create($parcial)
try {
    $bloco = [System.Text.Encoding]::ASCII.GetBytes(('t' * 1024))
    for ($i = 0; $i -lt 1500; $i++) { $fs.Write($bloco, 0, $bloco.Length) }
} finally { $fs.Dispose() }
Write-Host ""
Write-Host "Arquivo em transito (nao pode ser compactado ainda):" -ForegroundColor Magenta
Write-Host ("  EM-TRANSITO.sql       {0:N1} MB" -f ((Get-Item $parcial).Length / 1MB)) -ForegroundColor DarkGray

Write-Host ""
Write-Host "Como testar no Kyrios:" -ForegroundColor Cyan
Write-Host "  1. Rede > abrir a pasta > aba Compactacao"
Write-Host "  2. Modo 'um arquivo por arquivo' > Compactar agora"
Write-Host "  3. O grande.sql vira grande.sql.7z e o original some"
Write-Host "  4. nota.txt NAO e compactado (extensao fora da lista)"
Write-Host "  5. Com a pasta ainda sincronizando, Compactar deve nao fazer nada"
Write-Host ""
Write-Host "No modo 'um arquivo para a pasta toda':" -ForegroundColor Cyan
Write-Host "  - tudo vai para um unico .7z com data no nome"
Write-Host "  - o caminho do .7z NAO pode ser dentro da pasta (o app recusa)"
Write-Host "  - apagar um arquivo da origem tira ele do .7z no proximo ciclo"
Write-Host ""
Write-Host "Para desfazer: use o botao 'Restaurar arquivos do compactado' na aba."
