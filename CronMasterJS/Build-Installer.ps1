# Kyrion Kronou - Build Production Installer
# Run this script to build the NSIS installer + portable .exe
#
# Requirements:
#   - Node.js >= 16
#   - npm install (already done)
#   - NSIS 3.x (installed via: choco install nsis)
#
# Usage:
#   .\Build-Installer.ps1              # Build both installer + portable
#   .\Build-Installer.ps1 -Portable    # Build portable .exe only
#   .\Build-Installer.ps1 -Installer   # Build NSIS installer only
#   .\Build-Installer.ps1 -Package     # Build portable via electron-packager

param(
    [switch]$Portable,
    [switch]$Installer,
    [switch]$Package
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "  ========================================" -ForegroundColor DarkGray
Write-Host "   Kyrion Kronou - Production Build" -ForegroundColor White
Write-Host "  ========================================" -ForegroundColor DarkGray
Write-Host ""

# Ensure we're in the right directory
Push-Location $ProjectRoot

try {
    # Check Node.js
    $nodeVersion = node --version 2>$null
    if (-not $nodeVersion) {
        Write-Host "  [ERROR] Node.js not found. Install from https://nodejs.org" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Node.js: $nodeVersion" -ForegroundColor DarkGray

    # Check npm
    $npmVersion = npm --version 2>$null
    Write-Host "  npm: $npmVersion" -ForegroundColor DarkGray
    Write-Host ""

    # Install dependencies if needed
    if (-not (Test-Path "node_modules")) {
        Write-Host "  Installing dependencies..." -ForegroundColor Yellow
        npm install
        Write-Host ""
    }

    # Run tests first
    Write-Host "  Running tests..." -ForegroundColor Yellow
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Tests failed! Fix errors before building." -ForegroundColor Red
        exit 1
    }
    Write-Host "  All tests passed!" -ForegroundColor Green
    Write-Host ""

    # Generate icon assets from logo.png
    if (Test-Path "logo.png") {
        Write-Host "  Generating icon assets from logo.png..." -ForegroundColor Yellow
        node scripts/generate-icons.js
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [ERROR] Icon generation failed!" -ForegroundColor Red
            exit 1
        }
        Write-Host ""
    }

    # Ensure dist directory exists
    if (-not (Test-Path "dist")) {
        New-Item -ItemType Directory -Path "dist" | Out-Null
    }

    # ── Build with electron-packager (portable unpacked) ──
    if ($Package -or (-not $Portable -and -not $Installer) -or $Portable) {
        Write-Host "  Building portable app (electron-packager)..." -ForegroundColor Cyan

        # Kill any running instance
        taskkill /F /IM KyrionKronou.exe 2>$null
        Start-Sleep -Seconds 1

        npx electron-packager . KyrionKronou --platform=win32 --arch=x64 --out=build --overwrite --asar
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [ERROR] electron-packager failed!" -ForegroundColor Red
            exit 1
        }
        $exePath = "build\KyrionKronou-win32-x64\KyrionKronou.exe"
        if (Test-Path $exePath) {
            $size = (Get-Item $exePath).Length / 1MB
            Write-Host "  Portable build successful!" -ForegroundColor Green
            Write-Host "  Output: $exePath ($([math]::Round($size, 1)) MB)" -ForegroundColor White
        } else {
            Write-Host "  [ERROR] Build failed!" -ForegroundColor Red
            exit 1
        }
        Write-Host ""
    }

    # ── Build NSIS Installer ──
    if ($Installer -or (-not $Portable -and -not $Package)) {
        # Find NSIS
        $nsisPath = $null
        $possiblePaths = @(
            "C:\Program Files (x86)\NSIS\makensis.exe",
            "C:\Program Files\NSIS\makensis.exe",
            "$env:ProgramFiles(x86)\NSIS\makensis.exe",
            "$env:ProgramFiles\NSIS\makensis.exe"
        )
        foreach ($p in $possiblePaths) {
            if (Test-Path $p) {
                $nsisPath = $p
                break
            }
        }
        if (-not $nsisPath) {
            $nsisPath = (Get-Command makensis.exe -ErrorAction SilentlyContinue).Source
        }
        if (-not $nsisPath) {
            Write-Host "  [ERROR] NSIS not found!" -ForegroundColor Red
            Write-Host "  Install NSIS: choco install nsis" -ForegroundColor Yellow
            exit 1
        }

        Write-Host "  Building NSIS installer..." -ForegroundColor Cyan
        Write-Host "  NSIS: $nsisPath" -ForegroundColor DarkGray

        # Verify the portable build exists
        if (-not (Test-Path "build\KyrionKronou-win32-x64\KyrionKronou.exe")) {
            Write-Host "  [ERROR] Portable build not found! Run without -Installer flag first." -ForegroundColor Red
            exit 1
        }

        & "$nsisPath" installer\CronMaster-Installer.nsi
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [ERROR] NSIS compilation failed!" -ForegroundColor Red
            exit 1
        }
        Write-Host ""
    }

    # Show output
    Write-Host ""
    if (Test-Path "dist") {
        Write-Host "  Build artifacts:" -ForegroundColor White
        Get-ChildItem "dist" -File | ForEach-Object {
            $sizeMB = [math]::Round($_.Length / 1MB, 1)
            Write-Host "    $($_.Name) ($sizeMB MB)" -ForegroundColor DarkGray
        }
    }
    if (Test-Path "build\KyrionKronou-win32-x64\KyrionKronou.exe") {
        $sizeMB = [math]::Round((Get-Item "build\KyrionKronou-win32-x64\KyrionKronou.exe").Length / 1MB, 1)
        Write-Host "    KyrionKronou.exe (portable, $sizeMB MB)" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "  Build complete!" -ForegroundColor Green
    Write-Host ""

} finally {
    Pop-Location
}
