# Kyrios Chronos - Build Production Installer
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
Write-Host "   Kyrios Chronos - Production Build" -ForegroundColor White
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

    $packageInfo = Get-Content "package.json" -Raw | ConvertFrom-Json
    $version = $packageInfo.version
    if (-not $version) {
        Write-Host "  [ERROR] package.json has no version!" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Version: $version" -ForegroundColor DarkGray
    Write-Host ""

    # Install dependencies if needed
    if (-not (Test-Path "node_modules")) {
        Write-Host "  Installing dependencies..." -ForegroundColor Yellow
        npm install
        Write-Host ""
    }

    # Run tests first
    Write-Host "  Running tests..." -ForegroundColor Yellow
    # stderr from a native command must not abort the build; $LASTEXITCODE is
    # the authoritative pass/fail signal.
    $ErrorActionPreference = 'Continue'
    npm test
    $testExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($testExit -ne 0) {
        Write-Host "  [ERROR] Tests failed! Fix errors before building." -ForegroundColor Red
        exit 1
    }
    Write-Host "  All tests passed!" -ForegroundColor Green
    Write-Host ""

    # Generate icon assets from logo.png
    if (Test-Path "logo.png") {
        Write-Host "  Generating icon assets from logo.png..." -ForegroundColor Yellow
        $ErrorActionPreference = 'Continue'
        node scripts/generate-icons.js
        $iconExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($iconExit -ne 0) {
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
        # Stop a running instance if there is one. taskkill writes to stderr
        # when the process is absent, which PowerShell 5.1 turns into a
        # terminating NativeCommandError under ErrorActionPreference=Stop.
        Get-Process -Name KyriosChronos -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1

        $ErrorActionPreference = 'Continue'
        # --icon is required: without it the packaged exe keeps the default
        # Electron icon, which then propagates to the installed app and every
        # shortcut the installer creates.
        # --ignore is essential: without it the packager bundles dist/ and
        # build/ into app.asar, so every build embeds the previous installer
        # and the artifact grows on each run. tests/ and .git/ are dead weight
        # in a shipped app too.
        # Driven by a script, not a command line: the packager's --ignore
        # values are regexes, and cmd.exe eats "^" (its escape character) and
        # reads "|" as a pipe, silently corrupting them. See scripts/package-app.js.
        node scripts/package-app.js
        $packExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($packExit -ne 0) {
            Write-Host "  [ERROR] electron-packager failed!" -ForegroundColor Red
            exit 1
        }
        $exePath = "build\KyriosChronos-win32-x64\KyriosChronos.exe"
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
        if (-not (Test-Path "build\KyriosChronos-win32-x64\KyriosChronos.exe")) {
            Write-Host "  [ERROR] Portable build not found! Run without -Installer flag first." -ForegroundColor Red
            exit 1
        }

        $ErrorActionPreference = 'Continue'
        & "$nsisPath" "/DAPP_VERSION=$version" installer\KyriosChronos-Installer.nsi
        $nsisExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($nsisExit -ne 0) {
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
    if (Test-Path "build\KyriosChronos-win32-x64\KyriosChronos.exe") {
        $sizeMB = [math]::Round((Get-Item "build\KyriosChronos-win32-x64\KyriosChronos.exe").Length / 1MB, 1)
        Write-Host "    KyriosChronos.exe (portable, $sizeMB MB)" -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "  Build complete!" -ForegroundColor Green
    Write-Host ""

} finally {
    Pop-Location
}
