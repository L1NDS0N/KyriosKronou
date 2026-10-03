<#
    Kyrios Chronos - Teste 04: retencao, a roteiro de simulacao.

    Este script NAO apaga nada. Ele calcula, com a mesma logica do Kyrios, o
    que cada politica de retencao faria, para voce comparar com a previa que
    aparece na tela.

    Se os dois concordarem, a tela esta certa. Se divergirem, algo esta errado
    em um dos dois - e este e o ponto do teste.

    Como comparar:
      Kyrios > Retencao > Novo perfil > Destino = pasta desta arvore > Simulacao
#>
param(
    [string]$Raiz = (Join-Path (Split-Path -Parent $PSScriptRoot) 'retention-testes')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Raiz)) {
    Write-Host "Arvore nao encontrada: $Raiz" -ForegroundColor Red
    Write-Host "Rode antes: .\New-RetentionTestTree.ps1 -Clean" -ForegroundColor Yellow
    exit 1
}

# Os mesmos padroes de data que o Kyrios reconhece (DATE_PATTERNS).
$padroes = @(
    @{ re = '(?:^|[^\d])(\d{4})-(\d{2})-(\d{2})(?:[^\d]|$)'; ordem = @('y','m','d') }
    @{ re = '(?:^|[^\d])(\d{4})(\d{2})(\d{2})(?:[^\d]|$)'; ordem = @('y','m','d') }
    @{ re = '(?:^|[^\d])(\d{2})-(\d{2})-(\d{4})(?:[^\d]|$)'; ordem = @('d','m','y') }
    @{ re = '(?:^|[^\d])(\d{2})\.(\d{2})\.(\d{4})(?:[^\d]|$)'; ordem = @('d','m','y') }
    @{ re = '(?:^|[^\d])(\d{2})_(\d{2})_(\d{4})(?:[^\d]|$)'; ordem = @('d','m','y') }
)

function Get-Data {
    param([string]$Nome)
    foreach ($p in $padroes) {
        $m = [regex]::Match($Nome, $p.re)
        if (-not $m.Success) { continue }
        $partes = @{}
        for ($i = 0; $i -lt $p.ordem.Count; $i++) { $partes[$p.ordem[$i]] = [int]$m.Groups[$i + 1].Value }
        if ($partes.m -lt 1 -or $partes.m -gt 12) { continue }
        if ($partes.d -lt 1 -or $partes.d -gt 31) { continue }
        try {
            $d = Get-Date -Year $partes.y -Month $partes.m -Day $partes.d
        } catch { continue }
        # 30 de fevereiro rejeitado: a data precisa existir no calendario.
        if ($d.Day -ne $partes.d -or $d.Month -ne $partes.m) { continue }
        if ($partes.y -lt 1970 -or $d -gt (Get-Date).AddDays(1)) { continue }
        return $d
    }
    return $null
}

Write-Host ""
Write-Host "Politicas aplicadas a arvore" -ForegroundColor Cyan
Write-Host ""

# 1. Idade: manter 90 dias
$limiteDias = 90
$corte = (Get-Date).AddDays(-$limiteDias)
$porIdade = 0
(Get-ChildItem $Raiz -Recurse -File) | ForEach-Object {
    $d = Get-Data $_.Name
    if (-not $d) { $d = $_.LastWriteTime }
    if ($d -lt $corte) { $porIdade++ }
}
Write-Host ("  manter 90 dias       -> apaga {0} de {1} arquivo(s)" -f $porIdade, (Get-ChildItem $Raiz -Recurse -File | Measure-Object).Count) -ForegroundColor DarkGray

# 2. Contagem: manter 30 mais novos por pasta
Write-Host ""
$porPasta = @{}
(Get-ChildItem $Raiz -Recurse -File) | ForEach-Object {
    $rel = $_.FullName.Substring($Raiz.Length).TrimStart('\')
    $chave = if ($rel.Contains('\')) { $rel.Split('\')[0] } else { '(raiz)' }
    if (-not $porPasta.ContainsKey($chave)) { $porPasta[$chave] = @() }
    $porPasta[$chave] += $_
}
foreach ($chave in ($porPasta.Keys | Sort-Object)) {
    $lista = $porPasta[$chave] | Sort-Object LastWriteTime -Descending
    if ($lista.Count -le 30) { continue }
    Write-Host ("  manter 30 em {0,-22} -> apaga {1}" -f $chave, ($lista.Count - 30)) -ForegroundColor DarkGray
}

# 3. O que NUNCA deve ser apagado
Write-Host ""
Write-Host "Arquivos sem data (dependem so do mtime, cuidado na regra):" -ForegroundColor Yellow
$semData = (Get-ChildItem $Raiz -Recurse -File) | Where-Object { -not (Get-Data $_.Name) }
Write-Host ("  {0} arquivo(s)" -f $semData.Count) -ForegroundColor DarkGray
$semData | Group-Object { $_.Directory.Name } | Select-Object -First 6 | ForEach-Object {
    Write-Host ("    {0,-24} {1}" -f $_.Name, $_.Count) -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Confira no Kyrios:" -ForegroundColor Cyan
Write-Host "  1. Retencao > Novo perfil > Destino = $Raiz"
Write-Host "  2. Simular: os numeros acima devem bater com a previa"
Write-Host "  3. Ligar MinKeep: nenhum dos mais novos pode sumir"
Write-Host "  4. Aplicar: so entao o que a previa mandou e apagado"
