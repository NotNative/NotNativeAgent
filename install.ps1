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
#   .\install.ps1 -InstallNnaIfMissing   # unattended opt-in to local NNA bootstrap
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
    [string]$NnaInstallRoot,
    [string]$NnaDataRoot,
    [string]$NnaSourceRoot,
    [switch]$InstallNnaIfMissing,
    [switch]$SkipNnaPathUpdate,
    [switch]$Uninstall,
    [switch]$PurgeData,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'scripts\installer-native-guard.ps1')
. (Join-Path $PSScriptRoot 'scripts\installer-nna-preflight.ps1')
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
    $nnaRoot = if ($NnaInstallRoot) { $NnaInstallRoot } else { Join-Path $env:LOCALAPPDATA 'NotNativeAgent' }
    $selectionPath = Join-Path $InstallDir 'nna-service-selection.json'
    $hasSelection = !$NnaInstallRoot -and (Test-Path -LiteralPath $selectionPath)
    if ($hasSelection) {
        $selectionFile = Get-Item -LiteralPath $selectionPath -Force
        if ($selectionFile.PSIsContainer -or $selectionFile.Length -gt 16384 -or
            ($selectionFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installed NNA selection is invalid.' }
        $selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json
        if (@($selection.PSObject.Properties).Count -ne 2 -or $selection.schema_version -ne '1.0' -or
            $selection.nna_install_root -isnot [string] -or $selection.nna_install_root.Length -gt 4096 -or
            ![IO.Path]::IsPathRooted($selection.nna_install_root)) { throw 'Installed NNA selection is invalid.' }
        $nnaRoot = $selection.nna_install_root
    }
    if (!$NnaInstallRoot -and !$hasSelection -and !$Uninstall -and !(Test-Path -LiteralPath (Join-Path $nnaRoot 'install.json') -PathType Leaf)) {
        $launcher = Get-Command 'nna.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($launcher) {
            $binRoot = Split-Path -Parent $launcher.Source
            if ((Split-Path -Leaf $binRoot) -eq 'bin') { $nnaRoot = Split-Path -Parent $binRoot }
        }
    }
    $descriptorPath = Join-Path $nnaRoot 'install.json'
    if (!(Test-Path -LiteralPath $descriptorPath -PathType Leaf)) { return $null }
    $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
    if ($descriptor.product -ne 'NotNativeAgent' -or
        ![IO.Path]::IsPathRooted([string]$descriptor.node) -or
        ![IO.Path]::IsPathRooted([string]$descriptor.install_root) -or
        ![IO.Path]::IsPathRooted([string]$descriptor.data_root) -or
        !([IO.Path]::GetFullPath([string]$descriptor.install_root).TrimEnd('\', '/')).Equals(
            [IO.Path]::GetFullPath($nnaRoot).TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installed NNA descriptor is invalid; NND registration was not attempted.'
    }
    $cli = Join-Path $descriptor.install_root 'installed\src\cli.js'
    if (!(Test-Path -LiteralPath $descriptor.node -PathType Leaf) -or !(Test-Path -LiteralPath $cli -PathType Leaf)) {
        throw 'Installed NNA runtime is incomplete; NND registration was not attempted.'
    }
    return @{ Node = $descriptor.node; Cli = $cli; DataRoot = $descriptor.data_root; InstallRoot = $descriptor.install_root; Version = $descriptor.version }
}

function Assert-NndRemovalTarget([string]$Candidate, [string]$SourceRoot) {
    $resolved = [IO.Path]::GetFullPath($Candidate).TrimEnd('\', '/')
    $sourceResolved = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\', '/')
    if ($resolved.Length -le [IO.Path]::GetPathRoot($resolved).Length -or
        $resolved.Equals($sourceResolved, [StringComparison]::OrdinalIgnoreCase) -or
        $resolved.StartsWith("$sourceResolved\", [StringComparison]::OrdinalIgnoreCase) -or
        $sourceResolved.StartsWith("$resolved\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Recursive removal target overlaps the source checkout or a filesystem root.'
    }
    # Resolve conservatively: an alias in either ancestry defeats lexical overlap checks.
    foreach ($start in @($resolved, $sourceResolved)) {
        $current = $start
        while ($current) {
            if (Test-Path -LiteralPath $current) {
                $item = Get-Item -LiteralPath $current -Force
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw 'Recursive removal refuses reparse points in target or source ancestry.'
                }
            }
            $parent = [IO.Directory]::GetParent($current)
            $current = if ($parent) { $parent.FullName } else { $null }
        }
    }
    return $resolved
}

function Remove-NndTree([string]$Candidate, [string]$SourceRoot) {
    $root = Assert-NndRemovalTarget $Candidate $SourceRoot
    if (!(Test-Path -LiteralPath $root)) { return }
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($root)
    $visited = 0
    while ($pending.Count) {
        $directory = $pending.Pop()
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
            $visited++
            if ($visited -gt 500000) { throw 'Removal inventory exceeded its bound; installation evidence was preserved.' }
            $entry = [IO.Path]::GetFullPath($item.FullName)
            if (!$entry.StartsWith("$root\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Removal entry escaped its target.' }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                # Delete the link itself, never recursively enumerate a pnpm junction target.
                if ($item.PSIsContainer) { [IO.Directory]::Delete($entry, $false) }
                else { [IO.File]::Delete($entry) }
            } elseif ($item.PSIsContainer) { $pending.Push($entry) }
        }
    }
    $verified = Assert-NndRemovalTarget $root $SourceRoot
    Remove-Item -LiteralPath $verified -Recurse -Force
}

function Install-RequiredNna {
    $candidate = if ($NnaSourceRoot) { $NnaSourceRoot } else { Join-Path (Split-Path -Parent $Source) 'NotNativeAgent' }
    $installer = Join-Path $candidate 'install.ps1'
    $manifestPath = Join-Path $candidate 'package.json'
    if (!(Test-Path -LiteralPath $installer -PathType Leaf) -or !(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "NNA is not installed and no local NNA installer was found at $candidate. Install NNA first, or supply -NnaSourceRoot."
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -ne 'not-native-agent') { throw "Local NNA source identity is invalid at $candidate." }
    if (!$InstallNnaIfMissing) {
        if (![Environment]::UserInteractive -or [Console]::IsInputRedirected) {
            throw 'NNA is not installed. Run interactively to confirm its installation, or pass -InstallNnaIfMissing for an unattended local-source bootstrap.'
        }
        $answer = Read-Host "NNA is required. Install it from $candidate now? [y/N]"
        if ($answer -notin @('y', 'Y', 'yes', 'YES')) { throw 'NNA installation declined; NND was not installed.' }
    }
    Write-Heading "Installing required NNA from $candidate"
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer)
    if ($NnaInstallRoot) { $arguments += @('-InstallRoot', $NnaInstallRoot) }
    if ($NnaDataRoot) { $arguments += @('-DataRoot', $NnaDataRoot) }
    if ($SkipNnaPathUpdate) { $arguments += '-SkipPathUpdate' }
    if ($InstallNnaIfMissing) {
        $arguments += @('-SkipProviderSetup', '-SkipWebSearchSetup', '-SkipPlaywrightSetup', '-SkipGatewaySetup', '-SkipRipgrepSetup')
    }
    & powershell @arguments
    if ($LASTEXITCODE -ne 0) { throw "NNA installation failed (exit $LASTEXITCODE); NND was not installed." }
    if (!(Get-InstalledNna)) { throw 'NNA installer finished without a valid installed runtime; NND was not installed.' }
}

function Invoke-NndRegistration([string]$Action, [string]$Root, $SelectedNna) {
    $nna = $SelectedNna
    if (!$nna) {
        if ($Action -eq 'deactivate') {
            Write-Host '  NNA is not installed; no live registration can be deactivated. Preserved NNA data may retain a stale package record.' -ForegroundColor Yellow
        } else {
            throw 'NotNativeAgent must be installed before NND. Install NNA first, then rerun this installer (or provide -NnaInstallRoot for a custom NNA install).'
        }
        return
    }
    $previous = $env:NNA_HOME
    $env:NNA_HOME = $nna.DataRoot
    try {
        $oldPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            if ($Action -eq 'status') { & $nna.Node $nna.Cli nnd package status | Out-Null }
            else { & $nna.Node $nna.Cli nnd package $Action $Root }
        }
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
    $targetPath = Assert-NndRemovalTarget $targetPath $sourcePath
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
    $uninstallNna = Get-InstalledNna
    if (!$uninstallNna) { throw 'Cannot verify native service ownership. Restore the selected NNA runtime before uninstalling NND.' }
    $uninstallGuard = Start-NndInstallationGuard $uninstallNna
    $uninstallComplete = $false
    try {
    # Do not delete an installed package while NNA still points at it. A
    # failed deactivation leaves the install intact for an explicit retry.
    Invoke-NndRegistration 'deactivate' $targetPath $uninstallNna
    foreach ($name in @("NotNativeDesktop")) {
        $links = @((Join-Path $DesktopDir "$name.lnk"), (Join-Path $StartMenuDir "$name.lnk"))
        foreach ($link in $links) { if (Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link -Force; Write-Host "  removed shortcut $link" } }
    }
    Assert-NndInstallationGuard $uninstallGuard
    $removeTarget = Assert-NndRemovalTarget $targetPath $sourcePath
    if (Test-Path -LiteralPath $removeTarget) { Remove-NndTree $removeTarget $sourcePath; Write-Host "  removed install tree" }
    if ($PurgeData) {
        $partial = $false
        foreach ($data in @((Join-Path $env:USERPROFILE ".notnative-desktop"), (Join-Path $env:APPDATA "NotNativeDesktop"), (Join-Path $env:APPDATA "NotNativeDesktop Dev"))) {
            $removeData = Assert-NndRemovalTarget $data $sourcePath
            if (Test-Path -LiteralPath $removeData) {
                # Any removal failure preserves the native guard evidence for recovery.
                Assert-NndInstallationGuard $uninstallGuard
                Remove-NndTree $removeData $sourcePath
                if (Test-Path -LiteralPath $removeData) { $partial = $true; Write-Host "  partially erased $data (some files locked by a running instance)" -ForegroundColor Yellow }
                else { Write-Host "  erased data $data" }
            }
        }
        if ($partial) { Write-Host "  user data erased except the locked files listed above" -ForegroundColor Yellow }
        else { Write-Host "  user data erased" -ForegroundColor Yellow }
    }
    $uninstallComplete = $true
    } finally {
        if ($uninstallComplete) { Stop-NndInstallationGuard $uninstallGuard }
        else { Abandon-NndInstallationGuard $uninstallGuard }
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
foreach ($check in @(@("node", "node version"), @("pnpm", "pnpm version"))) {
    # A missing command leaves LASTEXITCODE unchanged in PowerShell, so a
    # successful node probe could otherwise mask an absent pnpm executable.
    if (!(Get-Command $check[0] -ErrorAction SilentlyContinue)) {
        throw "$($check[0]) is required on PATH (empty $($check[1]))"
    }
    # pnpm may emit non-fatal deprecation warnings on stderr. Under EAP=Stop
    # PowerShell turns them into terminating NativeCommandError records.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $probe = & $check[0] --version 2>$null
        $probeExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previous }
    if ($probeExit -ne 0) { throw "$($check[0]) is required on PATH (empty $($check[1]))" }
    Write-Host "  using $($check[0]) $probe"
}
$nna = Get-InstalledNna
if (!$nna) {
    Install-RequiredNna
    $nna = Get-InstalledNna
}

Write-Heading "Installing NotNativeDesktop"
Write-Host "  source : $Source"
Write-Host "  target : $InstallDir"
Write-Good "NNA found at $($nna.Cli)"
$nnaCapabilities = Assert-NndNnaCapabilities $nna
Write-Good "NNA native NND protocol $($nnaCapabilities.protocol) is compatible"
Invoke-NndRegistration 'status' $targetPath $nna

$installationGuard = Start-NndInstallationGuard $nna
$guardMatchesPreflight = $installationGuard.Frame.installation_id -ceq $nnaCapabilities.installation_id -and
    $installationGuard.Frame.data_id -ceq $nnaCapabilities.data_id
if (!$guardMatchesPreflight) {
    Stop-NndInstallationGuard $installationGuard
    throw 'Selected NNA identity changed between compatibility preflight and installation guard; NND was not installed.'
}
$installationComplete = $false
try {
Write-Heading "Copying source"
$copyExit = Invoke-Native "robocopy" @(
    $Source, $InstallDir, "/E", "/NFL", "/NDL", "/NJH", "/NP", "/R:2", "/W:1",
    "/XD", "node_modules", ".pnpm-store", ".git", ".vite", "coverage", "dist", "dist-server",
    "dist-electron", "resources", "__pycache__",
    "/XF", "*.log", ".env.local", "packaging-*.log", "install-mode.txt"
) "robocopy-errors.log" "robocopy-out.log"
Assert-NndInstallationGuard $installationGuard
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
    # Electron carries Chromium. Verify that the installed executable launches
    # and reports its embedded Chromium version; UI rendering is checked later.
    $chromiumOut = [IO.Path]::GetTempFileName()
    $chromiumErr = [IO.Path]::GetTempFileName()
    $previousRunAsNode = $env:ELECTRON_RUN_AS_NODE
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        $chromiumProbe = Start-Process -FilePath $ElectronExe -ArgumentList @('-p', 'process.versions.chrome') -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $chromiumOut -RedirectStandardError $chromiumErr
        $chromiumVersion = (Get-Content -LiteralPath $chromiumOut -Raw).Trim()
        if ($chromiumProbe.ExitCode -ne 0 -or $chromiumVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') {
            $chromiumFailure = (Get-Content -LiteralPath $chromiumErr -Raw).Trim()
            throw "Installed Electron Chromium runtime failed verification (exit $($chromiumProbe.ExitCode)): $chromiumFailure"
        }
        Write-Good "Electron reports embedded Chromium $chromiumVersion"
    } finally {
        $env:ELECTRON_RUN_AS_NODE = $previousRunAsNode
        Remove-Item -LiteralPath $chromiumOut, $chromiumErr -Force -ErrorAction SilentlyContinue
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
        $stampExit = Invoke-Native "node" @("scripts\electron-build-stamp.mjs", "check") "stamp-errors.log" "stamp-out.log"
        if ($stampExit -ne 0) {
            Show-NativeFailures "stamp-errors.log" 12
            Show-NativeFailures "stamp-out.log" 12 -FromTail
            Write-Host "  -SkipBuild ignored: build stamp is stale, missing, or invalid - rebuilding" -ForegroundColor Yellow
            $reusable = $false
        } else {
            Write-Good "verified build reused (-SkipBuild)"
        }
    }
    if (!$reusable) {
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

Assert-NndInstallationGuard $installationGuard
Write-Heading 'Registering NND package with NNA'
& $nna.Node (Join-Path $InstallDir 'scripts\installed-service-package.mjs') $InstallDir
if ($LASTEXITCODE -ne 0) { throw "Installed NND service manifest validation failed (exit $LASTEXITCODE)." }
Invoke-NndRegistration 'activate' $targetPath $nna
& $nna.Node (Join-Path $InstallDir 'scripts\write-nna-selection.mjs') $InstallDir $nna.InstallRoot $nnaCapabilities.installation_id $nnaCapabilities.data_id
if ($LASTEXITCODE -ne 0) { throw "Installed NNA selection could not be saved (exit $LASTEXITCODE)." }

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
$installationComplete = $true
} finally {
    if ($installationComplete) { Stop-NndInstallationGuard $installationGuard }
    else { Abandon-NndInstallationGuard $installationGuard }
}
