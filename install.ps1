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
#
# Upgrade semantics (second run): the copy is merge-only (robocopy /E, never
# /MIR). Files deleted upstream linger until a full reinstall; every runtime
# artifact is regenerated wholesale by electron-package --no-nsis, so stale
# leftovers cannot change behavior, only disk. Clean reset = -Uninstall +
# reinstall. The install REFUSES to copy while the installed app is running
# (a running electron.exe would fail the copy mid-tree with exit 8 and no
# diagnosis); -Uninstall refuses the tree drop for the same reason and erases
# data gracefully (locked files stay behind with a warning, nothing half-dies
# silently).
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
# into the log file; the exit code stays authoritative. Robocopy prints its
# own diagnostics (access denied etc.) on STDOUT, not stderr - so callers that
# care pass -OutputLog to capture stdout as well (the default still sinks it).
function Invoke-Native([string]$Tool, [string[]]$ToolArgs, [string]$ErrorLog, [string]$OutputLog) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        if ($OutputLog) {
            & $Tool @ToolArgs 2>$ErrorLog 1>$OutputLog
        } else {
            & $Tool @ToolArgs 2>$ErrorLog 1>$null
        }
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Show-NativeFailures([string]$ErrorLog, [int]$Lines = 30, [switch]$FromTail) {
    if (Test-Path -LiteralPath $ErrorLog) {
        $rows = if ($FromTail) { Get-Content -LiteralPath $ErrorLog -Tail $Lines -ErrorAction SilentlyContinue }
                else { Get-Content -LiteralPath $ErrorLog -ErrorAction SilentlyContinue | Select-Object -First $Lines }
        $rows | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkYellow }
    }
}

# True when an electron.exe from THIS install tree is running. Robocopy and
# Remove-Item both die mid-tree on a locked running binary - refuse early with
# a readable message instead of aborting in an undefined half-state.
function Test-InstallRunning([string]$ExePath) {
    if (!(Test-Path -LiteralPath $ExePath)) { return $false }
    $procs = @(Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ExePath })
    return $procs.Count -gt 0
}

# The NND installer registers only with a validated co-installed NNA. The
# registration is metadata, not a daemon launch; the legacy desktop child
# remains available until NNA owns the GUI service lifecycle.
function Get-InstalledNna {
    $descriptorPath = Join-Path $env:LOCALAPPDATA 'NotNativeAgent\install.json'
    if (!(Test-Path -LiteralPath $descriptorPath -PathType Leaf)) { return $null }
    $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
    if ($descriptor.product -ne 'NotNativeAgent' -or
        ![IO.Path]::IsPathRooted([string]$descriptor.node) -or
        ![IO.Path]::IsPathRooted([string]$descriptor.install_root) -or
        ![IO.Path]::IsPathRooted([string]$descriptor.data_root)) {
        throw 'Installed NNA descriptor is invalid; NND registration was not attempted.'
    }
    $cli = Join-Path $descriptor.install_root 'installed\src\cli.js'
    if (!(Test-Path -LiteralPath $descriptor.node -PathType Leaf) -or !(Test-Path -LiteralPath $cli -PathType Leaf)) {
        throw 'Installed NNA runtime is incomplete; NND registration was not attempted.'
    }
    return @{ Node = $descriptor.node; Cli = $cli; DataRoot = $descriptor.data_root }
}

function Invoke-NndRegistration([string]$Action, [string]$Root) {
    $nna = Get-InstalledNna
    if (!$nna) {
        if ($Action -eq 'deactivate') {
            Write-Host '  NNA is not installed; no live registration can be deactivated. Preserved NNA data may retain a stale package record.' -ForegroundColor Yellow
        } else {
            Write-Host '  NNA is not installed; package registration deferred. Re-run this installer after NNA is installed.' -ForegroundColor Yellow
        }
        return
    }
    $previous = $env:NNA_HOME
    $env:NNA_HOME = $nna.DataRoot
    try {
        $oldPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { & $nna.Node $nna.Cli nnd package $Action $Root }
        finally { $ErrorActionPreference = $oldPreference }
        if ($LASTEXITCODE -ne 0) { throw "NNA rejected NND package $Action (exit $LASTEXITCODE)." }
    } finally { $env:NNA_HOME = $previous }
}

# Normalize before either operation. Raw string equality misses `..`, case,
# and relative spellings; uninstall in particular must never recurse over the
# source checkout or an ancestor of it.
$sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd('\', '/')
$targetPath = [IO.Path]::GetFullPath(
    $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
).TrimEnd('\', '/')

if ($Uninstall) {
    if ($sourcePath.Equals($targetPath, [StringComparison]::OrdinalIgnoreCase) -or
        $sourcePath.StartsWith("$targetPath\", [StringComparison]::OrdinalIgnoreCase) -or
        $targetPath.StartsWith("$sourcePath\", [StringComparison]::OrdinalIgnoreCase)) {
        throw "-InstallDir cannot overlap the source repo (got $InstallDir)"
    }
    Write-Heading "Uninstalling NotNativeDesktop from $InstallDir"
    if (Test-InstallRunning $ElectronExe) {
        Write-Host "  NOT deleted: the app is running from $InstallDir (its electron.exe is locked while alive)." -ForegroundColor Yellow
        Write-Host "  quit it from the tray menu, then re-run -Uninstall." -ForegroundColor Yellow
        exit 2
    }
    # Do not delete an installed package while NNA still points at it. A
    # failed deactivation leaves the install intact for an explicit retry.
    Invoke-NndRegistration 'deactivate' $targetPath
    foreach ($name in @("NotNativeDesktop")) {
        $links = @((Join-Path $DesktopDir "$name.lnk"), (Join-Path $StartMenuDir "$name.lnk"))
        foreach ($link in $links) { if (Test-Path $link) { Remove-Item $link -Force; Write-Host "  removed shortcut $link" } }
    }
    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Write-Host "  removed install tree" }
    if ($PurgeData) {
        $partial = $false
        foreach ($data in @((Join-Path $env:USERPROFILE ".notnative-desktop"), (Join-Path $env:APPDATA "NotNativeDesktop"), (Join-Path $env:APPDATA "NotNativeDesktop Dev"))) {
            if (Test-Path $data) {
                # Locked data files (a running dev instance shares these dirs) must
                # not abort the purge half-way with EAP=Stop - erase what is loose.
                Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
                if (Test-Path $data) { $partial = $true; Write-Host "  partially erased $data (some files locked by a running instance)" -ForegroundColor Yellow }
                else { Write-Host "  erased data $data" }
            }
        }
        if ($partial) { Write-Host "  user data erased except the locked files listed above" -ForegroundColor Yellow }
        else { Write-Host "  user data erased" -ForegroundColor Yellow }
    }
    Write-Heading "Uninstall complete"; exit 0
}

# Robocopy /E follows a destination placed inside its source tree. Refuse
# before copying or installing dependencies (a sibling prefix remains valid).
if ($targetPath.Equals($sourcePath, [StringComparison]::OrdinalIgnoreCase) -or
    $targetPath.StartsWith("$sourcePath\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "-InstallDir must be outside the source repo (got $InstallDir)"
}
if (Test-InstallRunning $ElectronExe) {
    throw "NotNativeDesktop appears to be running from $InstallDir - quit it from the tray menu, then re-run the install (robocopy + pnpm would mutate a tree the running process still holds; robocopy /E cannot touch the binary itself since node_modules is excluded, but a lockfile change makes pnpm relink node_modules under it)"
}

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
    $Source, $InstallDir, "/E", "/NFL", "/NDL", "/NJH", "/NP", "/R:2", "/W:1",
    "/XD", "node_modules", ".pnpm-store", ".git", ".vite", "coverage", "dist", "dist-server",
    "dist-electron", "resources", "__pycache__",
    "/XF", "*.log", ".env.local", "packaging-*.log", "install-mode.txt"
) "robocopy-errors.log" "robocopy-out.log"
if ($copyExit -ge 8) {
    # robocopy diagnostics ("access denied", stat failures) go to STDOUT. The
    # old call sank stdout to $null, so a failure printed only the exit code;
    # the out log keeps the failure lines whole for diagnosis.
    Show-NativeFailures "robocopy-out.log" 20 -FromTail
    Show-NativeFailures "robocopy-errors.log" 10
    throw "robocopy failed with code $copyExit"
}
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
    # -SkipBuild integrity check: a torn earlier build (crash between esbuild,
    # sibling JSON/native staging and icon generation) used to be reused
    # silently. The server and terminal runtime must both be complete.
    $reusable = $false
    if ($SkipBuild -and (Test-Path $bundle)) {
        $reusable = $true
        foreach ($artifact in @(
            (Join-Path $InstallDir "packages\electron\dist-server\settings-registry.json"),
            (Join-Path $InstallDir "packages\electron\dist-server\node_modules\node-pty\package.json"),
            (Join-Path $InstallDir "packages\electron\dist-server\node_modules\node-pty\lib\index.js"),
            (Join-Path $InstallDir "packages\electron\dist-server\node_modules\node-pty\prebuilds\win32-x64\conpty.node"),
            (Join-Path $InstallDir "packages\electron\dist-server\node_modules\node-pty\prebuilds\win32-x64\conpty_console_list.node"),
            (Join-Path $InstallDir "packages\electron\dist-server\node_modules\node-pty\prebuilds\win32-x64\pty.node"),
            (Join-Path $InstallDir "packages\electron\dist-server\node_modules\node-pty\prebuilds\win32-x64\winpty-agent.exe"),
            (Join-Path $InstallDir "packages\electron\dist-server\node_modules\node-pty\prebuilds\win32-x64\winpty.dll"),
            (Join-Path $InstallDir "packages\electron\dist-server\node_modules\node-pty\prebuilds\win32-x64\conpty\conpty.dll"),
            (Join-Path $InstallDir "packages\electron\dist-server\node_modules\node-pty\prebuilds\win32-x64\conpty\OpenConsole.exe"),
            (Join-Path $InstallDir "packages\electron\assets\tray-running.png"),
            (Join-Path $InstallDir "packages\electron\assets\tray-stopped.png")
        )) { if (!(Test-Path -LiteralPath $artifact)) { $reusable = $false } }
        if (!$reusable) { Write-Host "  -SkipBuild ignored: stored artifacts incomplete - rebuilding" -ForegroundColor Yellow }
    }
    if ($reusable) {
        # Freshness probe (no build-stamp system exists): if any watched source
        # is newer than the stored bundle the artifacts may be stale - warn, do
        # not override -SkipBuild's explicit intent to reuse.
        $bundleStamp = (Get-Item -LiteralPath $bundle).LastWriteTimeUtc
        $watched = Get-ChildItem -Path @(
            (Join-Path $InstallDir "packages\web\src"),
            (Join-Path $InstallDir "scripts"),
            (Join-Path $InstallDir "packages\electron")
        ) -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\(dist-server|dist|resources|assets|node_modules)\\' }
        $newest = $watched | Sort-Object LastWriteTimeUtc | Select-Object -Last 1
        if ($newest -and $newest.LastWriteTimeUtc -gt $bundleStamp) {
            Write-Host "  WARNING: sources are newer than the stored artifacts (newest: $($newest.FullName))" -ForegroundColor Yellow
            Write-Host "  the reused build may be stale - re-run install.ps1 without -SkipBuild to rebuild" -ForegroundColor Yellow
        } else {
            Write-Good "existing artifacts reused (-SkipBuild)"
        }
    } else {
        # -OutputLog keeps the integrity oracle + vite chatter readable after
        # the run; the console only echoes the short digest lines.
        $buildExit = Invoke-Native "node" @("scripts\electron-package.mjs", "--no-nsis") "build-errors.log" "build-out.log"
        if ($buildExit -ne 0) {
            Show-NativeFailures "build-errors.log" 30
            Show-NativeFailures "build-out.log" 30 -FromTail
            throw "electron-package failed (exit $buildExit)"
        }
        Show-NativeFailures "build-out.log" 8 -FromTail # trailing lines = integrity digest
        Write-Good "build green"
    }
} finally { Pop-Location }

Write-Heading 'Registering NND package with NNA'
$manifestDir = Join-Path $InstallDir 'nna-integration\nnd-local'
New-Item -ItemType Directory -Path $manifestDir -Force | Out-Null
$release = (Get-Content -LiteralPath (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).nnd_version
if ([string]::IsNullOrWhiteSpace([string]$release)) { throw 'Installed NND version is missing.' }
$manifest = [ordered]@{ id = 'nnd-local'; ownership = 'nnd'; scope = 'local-gui'; nna_integration_protocol = '1.0'; version = $release } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $manifestDir 'integration.json'), $manifest, (New-Object Text.UTF8Encoding($false)))
Invoke-NndRegistration 'activate' $targetPath

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
