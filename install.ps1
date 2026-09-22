# =============================================================================
# install.ps1 - NotNativeDesktop simple source installation (Windows).
#
# Copies the source tree into the installed working directory, installs
# dependencies, builds the shell artifacts (web dist + server bundle + tray
# icons), and creates Desktop + Start Menu shortcuts that start the service
# with a tray icon (open web / open desktop / quit). No admin rights needed.
#
# Usage:
#   .\install.ps1                       # install to %LOCALAPPDATA%\NotNativeDesktop
#   .\install.ps1 -InstallDir D:\apps\nnd
#   .\install.ps1 -SkipBuild            # reuse an existing built install
#   .\install.ps1 -Uninstall            # remove shortcuts + installed tree
#   .\install.ps1 -Uninstall -PurgeData # also erase user data/logs/prefs
#
# Native-tool stderr (vite/pnpm chatter) is routed to log FILES, never the
# PowerShell error stream - $ErrorActionPreference Stop would otherwise abort
# on harmless build-tool output (proven failure mode).
# =============================================================================
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "NotNativeDesktop"),
    [switch]$Uninstall,
    [switch]$PurgeData,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$Source = $PSScriptRoot
$ElectronExe = Join-Path $InstallDir "packages\electron\node_modules\electron\dist\electron.exe"
$MainScript = "packages\electron\main.mjs"
$DesktopDir = [Environment]::GetFolderPath("Desktop")
$StartMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"

function Write-Heading([string]$Text) { Write-Host "" ; Write-Host $Text -ForegroundColor Cyan }
function Write-Good([string]$Text) { Write-Host "  $Text" -ForegroundColor Green }

# Native processes emit warnings on stderr; in PowerShell those become error
# records, and Stop would terminate on any of them. Continue lets stderr flow
# into the log file; the exit code stays authoritative.
function Invoke-Native([string]$Tool, [string[]]$ToolArgs, [string]$ErrorLog) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Tool @ToolArgs 2>$ErrorLog 1>$null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Show-NativeFailures([string]$ErrorLog, [int]$Lines = 30) {
    if (Test-Path $ErrorLog) {
        Get-Content $ErrorLog -ErrorAction SilentlyContinue | Select-Object -First $Lines | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    }
}

if ($Uninstall) {
    Write-Heading "Uninstalling NotNativeDesktop from $InstallDir"
    foreach ($name in @("NotNativeDesktop")) {
        $links = @((Join-Path $DesktopDir "$name.lnk"), (Join-Path $StartMenuDir "$name.lnk"))
        foreach ($link in $links) { if (Test-Path $link) { Remove-Item $link -Force; Write-Host "  removed shortcut $link" } }
    }
    if ($InstallDir -ne $Source) {
        if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Write-Host "  removed install tree" }
    }
    if ($PurgeData) {
        foreach ($data in @((Join-Path $env:USERPROFILE ".notnative-desktop"), (Join-Path $env:APPDATA "NotNativeDesktop"), (Join-Path $env:APPDATA "NotNativeDesktop Dev"))) {
            if (Test-Path $data) { Remove-Item $data -Recurse -Force; Write-Host "  erased data $data" }
        }
        Write-Host "  user data erased" -ForegroundColor Yellow
    }
    Write-Heading "Uninstall complete"; exit 0
}

if ($Source -eq $InstallDir) { throw "-InstallDir must differ from the source repo (got $InstallDir)" }

Write-Heading "Installing NotNativeDesktop"
Write-Host "  source : $Source"
Write-Host "  target : $InstallDir"

foreach ($check in @(@("node", "node version"), @("pnpm", "pnpm version"))) {
    $probe = & $check[0] --version 2>$null
    if ($LASTEXITCODE -ne 0) { throw "$($check[0]) is required on PATH (empty $($check[1]))" }
    Write-Host "  using $($check[0]) $probe"
}

Write-Heading "Copying source"
$copyExit = Invoke-Native "robocopy" @(
    $Source, $InstallDir, "/E", "/NFL", "/NDL", "/NJH", "/NP",
    "/XD", "node_modules", ".git", ".vite", "coverage", "dist", "dist-server",
    "dist-electron", "resources", "__pycache__",
    "/XF", "*.log", ".env.local", "packaging-*.log", "install-mode.txt"
) "robocopy-errors.log"
if ($copyExit -ge 8) { Show-NativeFailures "robocopy-errors.log"; throw "robocopy failed with code $copyExit" }
Write-Good "source copied"

Push-Location $InstallDir
try {
    Write-Heading "Installing dependencies (pnpm install --frozen-lockfile)"
    $pnpmExit = Invoke-Native "pnpm" @("install", "--frozen-lockfile") "pnpm-errors.log"
    if ($pnpmExit -ne 0) { Show-NativeFailures "pnpm-errors.log" 20; throw "pnpm install exited $pnpmExit" }
    if (!(Test-Path (Join-Path $InstallDir "packages\electron\node_modules\electron\dist\electron.exe"))) {
        Write-Host "  re-running electron postinstall (pnpm skips it for unlisted builds)"
        Push-Location (Join-Path $InstallDir "packages\electron\node_modules\electron")
        try {
            $fixExit = Invoke-Native "node" @("install.js") "electron-errors.log"
            if ($fixExit -ne 0) { Show-NativeFailures "electron-errors.log" 20; throw "electron install.js exited $fixExit" }
        } finally { Pop-Location }
    }
    Write-Good "dependencies ready"

    Set-Content -Path (Join-Path $InstallDir "packages\electron\install-mode.txt") -Value "script" -NoNewline

    Write-Heading "Building shell artifacts (web dist + server bundle + tray icons)"
    $bundle = Join-Path $InstallDir "packages\electron\dist-server\server.mjs"
    if ($SkipBuild -and (Test-Path $bundle)) {
        Write-Good "existing artifacts reused (-SkipBuild)"
    } else {
        $buildExit = Invoke-Native "node" @("scripts\electron-package.mjs", "--no-nsis") "build-errors.log"
        if ($buildExit -ne 0) { Show-NativeFailures "build-errors.log" 30; throw "electron-package failed (exit $buildExit)" }
        Write-Good "build green"
    }
} finally { Pop-Location }

Write-Heading "Creating shortcuts"
foreach ($anchor in @($DesktopDir, $StartMenuDir)) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path $anchor "NotNativeDesktop.lnk"))
    $link.TargetPath = $ElectronExe
    $link.Arguments = "`"$InstallDir\$MainScript`""
    $link.WorkingDirectory = $InstallDir
    $link.IconLocation = "$ElectronExe,0"
    $link.Description = "NotNativeDesktop - local service + tray"
    $link.Save()
    Write-Good "shortcut: $anchor\NotNativeDesktop.lnk"
}

Write-Heading "Done"
Write-Host "  start     : desktop or Start Menu shortcut (tray icon appears immediately)"
Write-Host "  logs      : %APPDATA%\NotNativeDesktop\logs\main.log"
Write-Host "  data      : %USERPROFILE%\.notnative-desktop"
Write-Host "  uninstall : .\install.ps1 -Uninstall [-PurgeData]"
