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
#   .\install.ps1 -InstallNnaIfMissing -NnaDependencyRoot C:\NNA-release -NnaDependencyManifestSha256 <trusted SHA-256>
#   .\install.ps1 -StagePrebuiltPayload -PrebuiltPayloadRoot C:\NND-payload -PrebuiltManifestSha256 <trusted SHA-256>
#   .\install.ps1 -RecoverPrebuiltStageOperation <operation UUID>
#   .\install.ps1 -SkipBuild            # reuse an existing built install
#   .\install.ps1 -Uninstall            # remove shortcuts + installed tree
#   .\install.ps1 -Uninstall -PurgeData # also erase user data/logs/prefs
#
# Native-tool stderr (vite/pnpm chatter) is routed to log FILES, never the
# PowerShell error stream - $ErrorActionPreference Stop would otherwise abort
# on harmless build-tool output (proven failure mode).
#
# This source-build path performs a fresh install on a clean machine and an
# NNA-shaped in-place upgrade when a registration already exists: the running
# service is stopped, the old package is deactivated, and the copy/build/
# activate flow replaces it; a service that was not running stays stopped.
# A non-empty fresh target with no registration still requires diagnosis; this
# script never treats a merge-copy as a safe upgrade. Immutable prebuilt staging
# remains a separate operation and does not activate the staged slot.
# =============================================================================
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "NotNativeDesktop"),
    [string]$NnaInstallRoot,
    [string]$NnaDataRoot,
    [string]$NnaSourceRoot,
    [string]$NnaDependencyRoot,
    [string]$NnaDependencyManifestSha256,
    [string]$ShortcutRoot,
    [string]$PrebuiltPayloadRoot,
    [string]$PrebuiltManifestSha256,
    [string]$PrebuiltStageOperation,
    [switch]$StagePrebuiltPayload,
    [switch]$ActivatePrebuiltSlot,
    [string]$RecoverPrebuiltStageOperation,
    [switch]$InstallNnaIfMissing,
    [switch]$SkipNnaPathUpdate,
    [switch]$Uninstall,
    [switch]$PurgeData,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'scripts\installer-native-guard.ps1')
. (Join-Path $PSScriptRoot 'scripts\installer-nna-preflight.ps1')
. (Join-Path $PSScriptRoot 'scripts\installer-nna-dependency.ps1')
. (Join-Path $PSScriptRoot 'scripts\installer-prebuilt-stage.ps1')
. (Join-Path $PSScriptRoot 'scripts\installer-prebuilt-uninstall.ps1')
. (Join-Path $PSScriptRoot 'scripts\installer-prebuilt-uninstall-evidence.ps1')
if ($StagePrebuiltPayload -and (!$PrebuiltPayloadRoot -or !$PrebuiltManifestSha256 -or $ActivatePrebuiltSlot -or
    $PrebuiltStageOperation -or $Uninstall -or $PurgeData -or $SkipBuild)) {
    throw '-StagePrebuiltPayload requires -PrebuiltPayloadRoot and -PrebuiltManifestSha256 and cannot be combined with uninstall, source-build, or activation options.'
}
if (!$StagePrebuiltPayload -and !$ActivatePrebuiltSlot -and ($PrebuiltPayloadRoot -or $PrebuiltManifestSha256)) {
    throw 'Prebuilt payload options require -StagePrebuiltPayload.'
}
if ($ActivatePrebuiltSlot -and (!$PrebuiltPayloadRoot -or !$PrebuiltManifestSha256 -or !$PSBoundParameters.ContainsKey('PrebuiltStageOperation') -or
    $Uninstall -or $PurgeData -or $SkipBuild)) {
    throw '-ActivatePrebuiltSlot requires -PrebuiltPayloadRoot, -PrebuiltManifestSha256, and -PrebuiltStageOperation; it cannot be combined with uninstall or source-build options.'
}
if (!$ActivatePrebuiltSlot -and $PSBoundParameters.ContainsKey('PrebuiltStageOperation')) {
    throw '-PrebuiltStageOperation requires -ActivatePrebuiltSlot.'
}
if ($ActivatePrebuiltSlot) {
    $activationParameterKeys = @('InstallDir', 'NnaInstallRoot', 'PrebuiltPayloadRoot', 'PrebuiltManifestSha256',
        'ShortcutRoot', 'PrebuiltStageOperation', 'ActivatePrebuiltSlot')
    $unexpected = @($PSBoundParameters.Keys | Where-Object { $_ -notin $activationParameterKeys })
    if ($unexpected.Count -ne 0) {
        throw "-ActivatePrebuiltSlot accepts only the prebuilt payload, selected NNA root, and NND target arguments; unexpected: $($unexpected -join ', ')."
    }
}
if ($ActivatePrebuiltSlot -and $PrebuiltStageOperation -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') {
    throw '-PrebuiltStageOperation requires a canonical v4 operation UUID.'
}
$recoverPrebuiltStageRequested = $PSBoundParameters.ContainsKey('RecoverPrebuiltStageOperation')
if ($recoverPrebuiltStageRequested) {
    if ($RecoverPrebuiltStageOperation -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
        $StagePrebuiltPayload -or $Uninstall -or $PurgeData -or $SkipBuild -or $InstallNnaIfMissing -or
        $ActivatePrebuiltSlot -or $PSBoundParameters.ContainsKey('PrebuiltStageOperation') -or
        $NnaDependencyRoot -or $NnaDependencyManifestSha256 -or $NnaSourceRoot) {
        throw '-RecoverPrebuiltStageOperation requires a canonical v4 operation UUID and an existing selected NNA; it cannot be combined with other installer modes or dependency setup.'
    }
}
if ($NnaDependencyRoot -and $NnaSourceRoot) { throw 'Choose either a verified NNA dependency release or the development source fallback.' }
if ([bool]$NnaDependencyRoot -ne [bool]$NnaDependencyManifestSha256) {
    throw 'A carried NNA dependency requires both -NnaDependencyRoot and -NnaDependencyManifestSha256.'
}
$Source = $PSScriptRoot
$ElectronExe = Join-Path $InstallDir "packages\electron\node_modules\electron\dist\electron.exe"
$StableLauncher = Join-Path $InstallDir 'scripts\launch-selected-desktop.ps1'
$DesktopDir = [Environment]::GetFolderPath("Desktop")
$StartMenuDir = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$hasShortcutRoot = $PSBoundParameters.ContainsKey('ShortcutRoot')
if ($hasShortcutRoot) {
    if (!$ShortcutRoot -or ![IO.Path]::IsPathRooted($ShortcutRoot)) { throw '-ShortcutRoot must be absolute.' }
    $shortcutBase = [IO.Path]::GetFullPath($ShortcutRoot).TrimEnd('\', '/')
    if (!(Test-Path -LiteralPath $shortcutBase -PathType Container)) { throw '-ShortcutRoot must be an existing directory.' }
    $shortcutMarker = Join-Path $shortcutBase '.nnd-disposable-shortcuts'
    if (!(Test-Path -LiteralPath $shortcutMarker -PathType Leaf) -or
        (Get-Item -LiteralPath $shortcutMarker -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
        (Get-Content -LiteralPath $shortcutMarker -Raw).Trim() -cne 'nnd-disposable-shortcuts-v1') {
        throw '-ShortcutRoot requires a disposable shortcut fixture marker.'
    }
    $current = $shortcutBase
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '-ShortcutRoot cannot traverse a reparse point.' }
        $parent = [IO.Directory]::GetParent($current)
        $current = if ($parent) { $parent.FullName } else { $null }
    }
    $DesktopDir = Join-Path $shortcutBase 'Desktop'
    $StartMenuDir = Join-Path $shortcutBase 'StartMenu'
}

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

# Source installation registers only with a validated co-installed NNA.
# Prebuilt staging delegates to NNA but does not select or launch its slot.
function Get-InstalledNna {
    $nnaRoot = if ($NnaInstallRoot) { $NnaInstallRoot } else { Join-Path $env:LOCALAPPDATA 'NotNativeAgent' }
    $selectionPin = $null
    $selectionPath = Join-Path $InstallDir 'nna-service-selection.json'
    $hasSelection = Test-Path -LiteralPath $selectionPath
    if ($hasSelection) {
        $selectionFile = Get-Item -LiteralPath $selectionPath -Force
        if ($selectionFile.PSIsContainer -or $selectionFile.Length -gt 16384 -or
            ($selectionFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installed NNA selection is invalid.' }
        $selection = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json
        $selectionKeys = @($selection.PSObject.Properties.Name)
        $legacyKeys = @('schema_version', 'nna_install_root')
        $pinnedKeys = @('schema_version', 'nna_install_root', 'installation_id', 'data_id')
        $isLegacy = $selectionKeys.Count -eq $legacyKeys.Count -and @($legacyKeys | Where-Object { $_ -notin $selectionKeys }).Count -eq 0
        $pinnedWithIncarnation = $selectionKeys -contains 'incarnation_id'
        $requiredKeys = if ($pinnedWithIncarnation) { $pinnedKeys + 'incarnation_id' } else { $pinnedKeys }
        $isPinned = $selectionKeys.Count -eq $requiredKeys.Count -and @($requiredKeys | Where-Object { $_ -notin $selectionKeys }).Count -eq 0
        if ((!$isLegacy -and !$isPinned) -or $selection.schema_version -ne '1.0' -or
            $selection.nna_install_root -isnot [string] -or $selection.nna_install_root.Length -gt 4096 -or
            ![IO.Path]::IsPathRooted($selection.nna_install_root) -or
            ($pinnedWithIncarnation -and ($selection.incarnation_id -isnot [string] -or
                $selection.incarnation_id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) -or
            ($isPinned -and ($selection.installation_id -isnot [string] -or
                $selection.installation_id -cnotmatch '^nna_[a-f0-9]{64}$' -or
                $selection.data_id -isnot [string] -or
                $selection.data_id -cnotmatch '^data_[a-f0-9]{64}$'))) { throw 'Installed NNA selection is invalid.' }
        if ($NnaInstallRoot -and !([IO.Path]::GetFullPath($NnaInstallRoot).TrimEnd('\', '/')).Equals(
            [IO.Path]::GetFullPath($selection.nna_install_root).TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Explicit NNA root conflicts with the installed NND selection; restore the selected NNA installation.'
        }
        $nnaRoot = $selection.nna_install_root
        if ($isPinned) {
            $selectionPin = @{ InstallationId = $selection.installation_id; DataId = $selection.data_id }
            if ($pinnedWithIncarnation) { $selectionPin.IncarnationId = $selection.incarnation_id }
        }
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
    return @{ Node = $descriptor.node; Cli = $cli; DataRoot = $descriptor.data_root; InstallRoot = $descriptor.install_root; Version = $descriptor.version; SelectionPin = $selectionPin; IncarnationId = $descriptor.incarnation_id }
}

function Assert-NndSelectedPin($SelectedNna, $Capabilities) {
    $pin = $SelectedNna.SelectionPin
    if ($pin -and ($pin.InstallationId -cne $Capabilities.installation_id -or $pin.DataId -cne $Capabilities.data_id)) {
        throw 'Installed NNA selection identity changed; restore the selected NNA installation before changing NND.'
    }
    # ADR 0070: a pinned incarnation that the live descriptor no longer reports means the NNA installation was replaced.
    if ($pin -and $pin.IncarnationId -and $SelectedNna.IncarnationId -and $pin.IncarnationId -cne [string]$SelectedNna.IncarnationId) {
        throw 'Installed NNA incarnation changed; restore the selected NNA installation before changing NND.'
    }
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
    $stage = $null
    try {
        $candidate = if ($NnaDependencyRoot) {
            $stage = Stage-NndNnaDependency $NnaDependencyRoot $NnaDependencyManifestSha256 $targetPath
            $stage
        } elseif ($NnaSourceRoot) { $NnaSourceRoot } else { Join-Path (Split-Path -Parent $Source) 'NotNativeAgent' }
        $installer = Join-Path $candidate 'install.ps1'
        $manifestPath = Join-Path $candidate 'package.json'
        if (!(Test-Path -LiteralPath $installer -PathType Leaf) -or !(Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
            throw "NNA is not installed and no local NNA installer was found at $candidate. Install NNA first, or supply -NnaDependencyRoot."
        }
        $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($manifest.name -ne 'not-native-agent') { throw "Local NNA source identity is invalid at $candidate." }
        if (!$InstallNnaIfMissing) {
            if (![Environment]::UserInteractive -or [Console]::IsInputRedirected) {
                throw 'NNA is not installed. Run interactively to confirm its installation, or pass -InstallNnaIfMissing for unattended setup.'
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
        & (Join-Path $PSHOME 'powershell.exe') @arguments
        if ($LASTEXITCODE -ne 0) { throw "NNA installation failed (exit $LASTEXITCODE); NND was not installed." }
        if (!(Get-InstalledNna)) { throw 'NNA installer finished without a valid installed runtime; NND was not installed.' }
    } finally { if ($stage) { Remove-NndDependencyStage $stage } }
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

# The dumb installer shape: a clean machine gets a plain copy; an existing
# registration is replaced in place - stop the running service first, then
# deactivate the old package and fall through to copy/build/activate. The
# service is never started here; the desktop shortcut and `nna nnd start` own
# that. A non-empty fresh target with no registration is still refused.
function Resolve-NndInstallPlan($SelectedNna, [string]$Root) {
    $status = Get-NndRegistrationStatus $SelectedNna
    if ($status.registered -ne $true) {
        if (Test-Path -LiteralPath $Root) {
            throw 'Fresh NND target already exists without a registration; remove it or recover the previous installation explicitly. No files were copied.'
        }
        Write-Good 'Fresh target confirmed'
        return @{ Mode = 'fresh'; PreviousVersion = $null }
    }
    if (!$status.root) { throw 'Native registration exists but is unreadable; resolve it explicitly before installing NND.' }
    $wasRunning = $false
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $SelectedNna.Node $SelectedNna.Cli nnd service status $SelectedNna.InstallRoot *> $null
        $wasRunning = ($LASTEXITCODE -eq 0)
    } finally { $ErrorActionPreference = $oldPreference }
    if ($wasRunning) {
        Write-Host "  Existing NND $status.version service is running; stopping it for the in-place replacement."
        Request-NndServiceStopForUninstall $SelectedNna (Join-Path $Source 'scripts\installer-wait-stopped.mjs')
    } else {
        Write-Host "  Existing NND $status.version registration found; the service is not running and will not be started."
    }
    # Transactional refinement: the previous package stays registered until the
    # replacement is built and validated, so a copy/build failure leaves the
    # prior registration active (execution guide 02 L5). The unguarded window
    # shrinks to deactivate-then-activate immediately before the swap.
    return @{ Mode = 'upgrade'; PreviousVersion = $status.version; PreviousRoot = $status.root }
}

# Prepared-transaction evidence for an interrupted upgrade: the previous
# version/root and how far the run reached, retained on failure for operator
# recovery and removed only after successful activation.
function Write-NndTransactionRecord([string]$Stage, $Plan) {
    if ($Plan.Mode -ne 'upgrade') { return }
    $script:TransactionStage = $Stage
    $dir = Join-Path $env:APPDATA 'NotNativeDesktop'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Set-Content -Path (Join-Path $dir 'install-transaction.json') -Value (
        @{ stage = $Stage; previous_version = $Plan.PreviousVersion; previous_root = $Plan.PreviousRoot;
           recorded_at = (Get-Date).ToString('o') } | ConvertTo-Json -Compress) -NoNewline
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
    $runningExe = $ElectronExe
    $uninstallCapabilities = Assert-NndNnaCapabilities $uninstallNna
    Assert-NndSelectedPin $uninstallNna $uninstallCapabilities
    if (Test-Path -LiteralPath (Join-Path $targetPath 'nnd-anchor.json') -PathType Leaf) {
        $uninstallAnchor = Resolve-NndPrebuiltAnchorForUninstall $targetPath $uninstallNna $uninstallCapabilities
        $uninstallPackageRoot = $uninstallAnchor.root
        $uninstallPackageVersion = $uninstallAnchor.version
        $runningExe = Join-Path $uninstallPackageRoot 'packages\electron\node_modules\electron\dist\electron.exe'
    } else {
        $uninstallPackageRoot = $targetPath
        $versionFile = Join-Path $targetPath 'VERSION'
        if (!(Test-Path -LiteralPath $versionFile -PathType Leaf)) { throw 'Selected NND version is unavailable; removal was not attempted.' }
        $uninstallPackageVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
        if ($uninstallPackageVersion -cnotmatch '^\d{8}-[1-9]\d{0,5}$') { throw 'Selected NND version is invalid; removal was not attempted.' }
    }
    if (Test-InstallRunning $runningExe) {
        Write-Host "  NOT deleted: the app is running from $runningExe (its electron.exe is locked while alive)." -ForegroundColor Yellow
        Write-Host "  quit it from the tray menu, then re-run -Uninstall." -ForegroundColor Yellow
        exit 2
    }
    $preStopStatus = Get-NndRegistrationStatus $uninstallNna
    Assert-NndUninstallRegistrationStatus $preStopStatus $uninstallPackageRoot $uninstallPackageVersion
    Request-NndServiceStopForUninstall $uninstallNna (Join-Path $Source 'scripts\installer-wait-stopped.mjs')
    $uninstallGuard = Start-NndInstallationGuard $uninstallNna
    $uninstallComplete = $false
    try {
    # Do not delete an installed package while NNA still points at it. A
    # failed deactivation leaves the install intact for an explicit retry.
    $uninstallStatus = Get-NndRegistrationStatus $uninstallNna
    Assert-NndUninstallRegistrationStatus $uninstallStatus $uninstallPackageRoot $uninstallPackageVersion
    Assert-NndUninstallGuardIdentity $uninstallGuard $uninstallCapabilities
    if (Test-InstallRunning $runningExe) { throw 'NND started from the selected install during uninstall; removal was stopped.' }
    Invoke-NndRegistration 'deactivate' $uninstallPackageRoot $uninstallNna
    if (Test-InstallRunning $runningExe) { throw 'NND started during deactivation; the anchor and registration evidence were preserved.' }
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
if ($recoverPrebuiltStageRequested) {
    $nna = Get-InstalledNna
    if (!$nna) { throw 'Selected NNA is not installed; restore it before recovering the NND stage operation.' }
    $capabilities = Assert-NndNnaCapabilities $nna
    Assert-NndSelectedPin $nna $capabilities
    $recovered = Invoke-NndPrebuiltStageRecover $nna $RecoverPrebuiltStageOperation
    Write-Heading 'Prebuilt NND staging recovery'
    Write-Host "  selected NNA : $($capabilities.installation_id) / $($capabilities.data_id)"
    Write-Host "  operation    : $($recovered.operation_id)"
    Write-Host "  state        : $($recovered.state)"
    if ($recovered.state -eq 'slot_ready') {
        Write-Host "  version      : $($recovered.version)"
        Write-Host "  slot         : $($recovered.slot)"
        Write-Host '  The slot is staged; activation remains pending.'
    } else {
        Write-Host '  The operation was unpublished; the NND installation was not changed.'
    }
    exit 0
}
if ($StagePrebuiltPayload) {
    # This branch does not change the current NND install or registration. It
    # delegates immutable slot preparation to the selected installed NNA.
    $checkedPayload = Assert-NndPrebuiltPayload $PrebuiltPayloadRoot $PrebuiltManifestSha256 $targetPath
    $nna = Get-InstalledNna
    if (!$nna) { Install-RequiredNna; $nna = Get-InstalledNna }
    $capabilities = Assert-NndNnaCapabilities $nna
    Assert-NndSelectedPin $nna $capabilities
    $slot = Invoke-NndPrebuiltStage $nna $checkedPayload
    $activationOperation = [Guid]::NewGuid().ToString()
    Invoke-NndPrebuiltActivationPreflight $nna $checkedPayload $capabilities $slot.operation_id $activationOperation
    Write-Heading 'Prebuilt NND payload staged; activation remains pending'
    Write-Host "  selected NNA : $($capabilities.installation_id) / $($capabilities.data_id)"
    Write-Host "  operation    : $($slot.operation_id)"
    Write-Host "  preflight    : $activationOperation"
    Write-Host "  version      : $($slot.version)"
    Write-Host "  slot         : $($slot.slot)"
    Write-Host '  The active NND package and shortcuts were not changed.'
    exit 0
}
function New-NndPrebuiltShortcut($AnchorPath, [string]$IconPath) {
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path $AnchorPath "NotNativeAgent.lnk"))
    $link.TargetPath = Join-Path $PSHOME 'powershell.exe'
    $link.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $StableLauncher + '"'
    $link.WorkingDirectory = $AnchorPath
    $link.IconLocation = $IconPath + ',0'
    $link.Description = 'NotNativeAgent desktop'
    $link.Save()
}
if ($ActivatePrebuiltSlot) {
    # A stable selection/launcher anchor is committed after proven activation,
    # then operator shortcuts. A failed shortcut phase can roll back only the
    # just-created fresh target; it never mutates a prior installation.
    $checkedPayload = Assert-NndPrebuiltPayload $PrebuiltPayloadRoot $PrebuiltManifestSha256 $targetPath
    $nna = Get-InstalledNna
    if (!$nna) { throw 'Selected NNA is not installed; restore it before activating the NND slot.' }
    $capabilities = Assert-NndNnaCapabilities $nna
    Assert-NndSelectedPin $nna $capabilities
    $preflightOperation = [Guid]::NewGuid().ToString()
    $preflight = Invoke-NndPrebuiltActivationPreflight $nna $checkedPayload $capabilities $PrebuiltStageOperation $preflightOperation
    $activated = Invoke-NndPrebuiltActivation $nna $checkedPayload $capabilities $PrebuiltStageOperation $preflight.candidate_sha256
    # Only a freshly created anchor may be removed on failure; a rebound
    # upgrade anchor keeps the launcher path alive for the new slot.
    $anchorFresh = -not (Test-Path -LiteralPath $targetPath)
    $anchorCreated = $false
    try {
        & $nna.Node (Join-Path $Source 'scripts\installer-prebuilt-anchor.mjs') $targetPath $Source $nna.InstallRoot $activated.root $capabilities.installation_id $capabilities.data_id $activated.version $PrebuiltStageOperation $activated.operation_id $checkedPayload.Sha256 $preflight.candidate_sha256
        if ($LASTEXITCODE -ne 0) { throw "Stable NND launcher anchor could not be created (exit $LASTEXITCODE)." }
        $anchorCreated = $true
        foreach ($shortcutRoot in @($DesktopDir, $StartMenuDir)) {
            if ($hasShortcutRoot -and !(Test-Path -LiteralPath $shortcutRoot -PathType Container)) {
                New-Item -ItemType Directory -Path $shortcutRoot | Out-Null
            }
            New-NndPrebuiltShortcut $shortcutRoot (Join-Path $activated.root 'packages\electron\node_modules\electron\dist\electron.exe')
            Write-Good "shortcut: $shortcutRoot\NotNativeAgent.lnk"
        }
    } catch {
        if ($anchorCreated -and $anchorFresh -and (Test-Path -LiteralPath $targetPath)) {
            Remove-Item -LiteralPath $targetPath -Recurse -Force
        }
        throw
    }
    Write-Heading 'Prebuilt NND activated; public controller attached'
    Write-Host "  selected NNA : $($capabilities.installation_id) / $($capabilities.data_id)"
    Write-Host "  stage        : $PrebuiltStageOperation"
    Write-Host "  operation    : $($activated.operation_id)"
    Write-Host "  version      : $($activated.version)"
    Write-Host "  slot         : $($activated.root)"
    Write-Host "  generation   : $($activated.generation)"
    Write-Host "  endpoint     : $($activated.endpoint)"
    Write-Host '  The launcher and operator shortcuts now point at this fresh stable anchor.'
    exit 0
}
if (Test-InstallRunning $ElectronExe) {
    # Legacy takeover (execution guide 02 L5): an Electron-owned backend from
    # this install tree is still a live catalog writer. The new supervised
    # service must not open the same queue/schedule/session state while it
    # runs, and we never kill a process by guessed name or port - the
    # operator drains it and the installer refuses with recovery instructions.
    throw @"
A legacy Electron-owned NotNativeDesktop backend is still running from $InstallDir.
It owns the session/queue/schedule catalogs the new service must take over.
Recovery instructions:
  1. Open the running desktop app and quit it from its tray menu (Close window is not enough).
  2. Verify no electron.exe is running from $InstallDir.
  3. Re-run this installer. The new service then takes over the existing data root safely.
The installer killed nothing and changed no files; the legacy backend keeps its state.
"@
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
Assert-NndSelectedPin $nna $nnaCapabilities
Write-Good "NNA native NND protocol $($nnaCapabilities.protocol) is compatible"
Invoke-NndRegistration 'status' $targetPath $nna

# The plan may stop a running service. The copy/build/activate flow owns the
# rest; the service is started later by the shortcut or `nna nnd start`.
$installPlan = Resolve-NndInstallPlan $nna $targetPath
Write-NndTransactionRecord 'prepared' $installPlan

$installationComplete = $false
try {
Write-Heading "Copying source"
Write-NndTransactionRecord 'copied' $installPlan
$copyExit = Invoke-Native "robocopy" @(
    $Source, $InstallDir, "/E", "/NFL", "/NDL", "/NJH", "/NP", "/R:2", "/W:1",
    "/XD", "node_modules", ".pnpm-store", ".git", ".tmp", ".agents-workspace", ".vite", "coverage", "dist", "dist-server",
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

# Remove the pre-rename shortcut so the stale entry can never start the old way.
foreach ($anchor in @($DesktopDir, $StartMenuDir)) {
    $staleShortcut = Join-Path $anchor 'NotNativeDesktop.lnk'
    if (Test-Path -LiteralPath $staleShortcut -PathType Leaf) {
        Remove-Item -LiteralPath $staleShortcut -Force
        Write-Host "  removed stale shortcut: $staleShortcut"
    }
}

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

Write-Heading 'Registering NND package with NNA'
# The unguarded transaction window opens here: deactivate the previous
# package only once the replacement is built and validated.
if ($installPlan.Mode -eq 'upgrade') {
    Invoke-NndRegistration 'deactivate' $installPlan.PreviousRoot $nna
    Write-Good "Previous NND package $($installPlan.PreviousVersion) deactivated"
    Write-NndTransactionRecord 'deactivated' $installPlan
}
& $nna.Node (Join-Path $InstallDir 'scripts\installed-service-package.mjs') $InstallDir
if ($LASTEXITCODE -ne 0) { throw "Installed NND service manifest validation failed (exit $LASTEXITCODE)." }
Invoke-NndRegistration 'activate' $targetPath $nna
& $nna.Node (Join-Path $InstallDir 'scripts\write-nna-selection.mjs') $InstallDir $nna.InstallRoot $nnaCapabilities.installation_id $nnaCapabilities.data_id
if ($LASTEXITCODE -ne 0) { throw "Installed NNA selection could not be saved (exit $LASTEXITCODE)." }

Write-Heading "Creating shortcuts"
# Brand shortcut as NotNativeAgent: the NNA installation ships the icon asset.
$nnaIcon = Join-Path $nna.InstallRoot 'resources\icons\notnative-agent.ico'
$shortcutIcon = if (Test-Path -LiteralPath $nnaIcon -PathType Leaf) { "$nnaIcon,0" } else { "$ElectronExe,0" }
foreach ($anchor in @($DesktopDir, $StartMenuDir)) {
    if ($hasShortcutRoot) {
        if (!(Test-Path -LiteralPath $anchor)) { New-Item -ItemType Directory -Path $anchor | Out-Null }
        if (!(Test-Path -LiteralPath $anchor -PathType Container) -or
            (Get-Item -LiteralPath $anchor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
            ($installPlan.Mode -eq 'fresh' -and (Test-Path -LiteralPath (Join-Path $anchor 'NotNativeAgent.lnk')))) {
            throw 'Disposable shortcut target is not fresh and safe.'
        }
    }
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path $anchor "NotNativeAgent.lnk"))
    $link.TargetPath = Join-Path $PSHOME 'powershell.exe'
    $link.Arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$StableLauncher`""
    $link.WorkingDirectory = $InstallDir
    $link.IconLocation = $shortcutIcon
    $link.Description = "NotNativeAgent desktop"
    $link.Save()
    Write-Good "shortcut: $anchor\NotNativeAgent.lnk"
}

$installationComplete = $true
} finally {
    if (!$installationComplete) {
        if ($installPlan.Mode -eq 'upgrade') {
            if ($script:TransactionStage -eq 'prepared') {
                Write-Host '  Installation failed before any change; the previous package registration is intact. Fix the reported problem and rerun.' -ForegroundColor Yellow
            } elseif ($script:TransactionStage -eq 'copied') {
                Write-Host '  Installation failed during copy/build; the previous package is still registered but its files were partially replaced. Rerun this installer to retry; it rebuilds in place.' -ForegroundColor Yellow
            } else {
                Write-Host '  Installation failed inside the activation transaction: the previous package was deactivated. Rerun this installer to retry; recovery evidence is in %APPDATA%\NotNativeDesktop\install-transaction.json.' -ForegroundColor Yellow
            }
        } else {
            Write-Host '  Installation incomplete; no prior package was replaced. Rerun this installer to retry.' -ForegroundColor Yellow
        }
    } else {
        Remove-Item -LiteralPath (Join-Path $env:APPDATA 'NotNativeDesktop\install-transaction.json') -Force -ErrorAction SilentlyContinue
    }
}

# The package is registered but the service is intentionally not started here.
Write-Heading "NotNativeDesktop installed"
Write-Host "  version   : $((Get-Content -LiteralPath (Join-Path $InstallDir 'VERSION') -Raw).Trim())"
Write-Host "  start     : desktop or Start Menu shortcut (starts the service + tray), or: nna desktop start"
Write-Host "  stop      : nna desktop stop;  auto-start at logon: nna desktop enable / disable"
Write-Host "  status    : nna desktop status"
Write-Host "  NNA node  : $($nna.Node)"
Write-Host "  NNA CLI   : $($nna.Cli)"
Write-Host "  NNA root  : $($nna.InstallRoot)"
Write-Host "  logs      : %APPDATA%\NotNativeDesktop\logs\main.log"
Write-Host "  data      : %USERPROFILE%\.notnative-desktop"
Write-Host "  uninstall : .\install.ps1 -Uninstall [-PurgeData]"
