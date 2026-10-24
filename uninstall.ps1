# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [string]$InstallRoot,
    [switch]$DeleteUserData,
    [switch]$KeepUserData,
    [int]$ParentProcessId = 0,
    [switch]$SkipPathUpdate
)

$ErrorActionPreference = 'Stop'

function New-UninstallChallenge {
    # Compatibility: powershell.exe uses .NET Framework, which has no RandomNumberGenerator.GetInt32.
    $Random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Bytes = New-Object byte[] 4
        $Random.GetBytes($Bytes)
        return 100000 + ([BitConverter]::ToUInt32($Bytes, 0) % 900000)
    } finally { $Random.Dispose() }
}

function Get-UninstallMutexHash([string]$Path) {
    # Compatibility: SHA256.HashData and Convert.ToHexString are unavailable in Windows PowerShell 5.1.
    # Security: Windows path casing cannot create a second lock for the same installation.
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $Digest = $Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Path.ToUpperInvariant()))
        return [BitConverter]::ToString($Digest).Replace('-', '').Substring(0, 24)
    } finally { $Hasher.Dispose() }
}

function Enter-UninstallMutex([string]$Name, [int]$TimeoutMs, [string]$TimeoutMessage) {
    $Mutex = [Threading.Mutex]::new($false, $Name)
    try {
        try { $Acquired = $Mutex.WaitOne($TimeoutMs) }
        catch [Threading.AbandonedMutexException] { $Acquired = $true }
        if (-not $Acquired) { throw $TimeoutMessage }
        return $Mutex
    } catch {
        $Mutex.Dispose()
        throw
    }
}

function Resolve-UninstallRoot([string]$Path, [string]$Role, [bool]$ForDeletion) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw "Refusing to uninstall: $Role root must be an absolute directory."
    }
    $GivenRoot = [IO.Path]::GetPathRoot($Path)
    if ($GivenRoot -eq '\' -or $GivenRoot -match '^[A-Za-z]:$' -or
        $Path.StartsWith('\\?\') -or $Path.StartsWith('\\.\')) {
        throw "Refusing to uninstall: $Role root must be a fully qualified directory."
    }
    $Resolved = [IO.Path]::GetFullPath($Path)
    $Identity = $Resolved.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $Forbidden = @([IO.Path]::GetPathRoot($Resolved), [Environment]::GetFolderPath('UserProfile'))
    if ($Role -eq 'install' -or $ForDeletion) {
        $Forbidden += [Environment]::GetFolderPath('LocalApplicationData')
    }
    foreach ($Candidate in $Forbidden) {
        if ($Identity.Equals(([IO.Path]::GetFullPath($Candidate)).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to uninstall: unsafe $Role root."
        }
    }
    # Security: a junction in any ancestor can redirect recursive removal outside the selected root.
    $Current = [IO.DirectoryInfo]::new($Resolved)
    for ($Depth = 0; $null -ne $Current -and $Depth -lt 128; $Depth++) {
        if ($Current.Exists -and ($Current.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing to uninstall: $Role root has a reparse-point ancestor."
        }
        $Current = $Current.Parent
    }
    if ($null -ne $Current) { throw "Refusing to uninstall: $Role root is too deep." }
    if ($ForDeletion -and -not [IO.Directory]::Exists($Resolved)) {
        throw "Refusing to uninstall: $Role root is not a directory."
    }
    return $Identity
}

if ($PSBoundParameters.ContainsKey('InstallRoot') -and [string]::IsNullOrWhiteSpace($InstallRoot)) {
    throw 'Refusing to uninstall: install root must be an absolute directory.'
}
if (-not $InstallRoot) { $InstallRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NotNativeAgent' }
$InstallRoot = Resolve-UninstallRoot $InstallRoot 'install' $true
$MarkerPath = Join-Path $InstallRoot 'install.json'
if (-not (Test-Path -LiteralPath $MarkerPath)) { throw 'Refusing to uninstall: NotNativeAgent install marker is missing.' }
$Marker = Get-Content -LiteralPath $MarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Marker.product -ne 'NotNativeAgent' -or
    (Resolve-UninstallRoot ([string]$Marker.install_root) 'install' $true) -ne $InstallRoot) {
    throw 'Refusing to uninstall: install marker does not match the requested directory.'
}
if ($DeleteUserData -and $KeepUserData) { throw 'Choose either -DeleteUserData or -KeepUserData, not both.' }
$DataRoot = Resolve-UninstallRoot ([string]$Marker.data_root) 'user data' $false

if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) {
    throw 'Refusing to uninstall without a directly attached interactive terminal. Run "nna uninstall" yourself and complete its confirmation challenge.'
}
$Challenge = New-UninstallChallenge
Write-Host ''
Write-Host "This will remove the NotNativeAgent application from '$InstallRoot'."
Write-Host 'An agent, script, redirected command, or command-line flag cannot approve this action.'
$UninstallConfirmation = Read-Host "To confirm, type exactly: UNINSTALL $Challenge"
if ($UninstallConfirmation -cne "UNINSTALL $Challenge") {
    throw 'Uninstall cancelled because the confirmation challenge did not match.'
}

$ShouldDeleteUserData = [bool]$DeleteUserData
if (-not $DeleteUserData -and -not $KeepUserData) {
    Write-Host ''
    Write-Host 'NotNativeAgent user data includes sessions, configuration, provider and MCP references,'
    Write-Host 'hooks, skills, logs, support bundles, reviewer ledgers, and locally stored credentials.'
    $Confirmation = Read-Host "Permanently delete all NNA user data at '$($Marker.data_root)'? [y/N]"
    $ShouldDeleteUserData = $Confirmation -match '^(?i:y|yes)$'
}

$DataRoot = Resolve-UninstallRoot $DataRoot 'user data' $ShouldDeleteUserData
$InstallPrefix = $InstallRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$DataInsideInstall = $DataRoot.Equals($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -or $DataRoot.StartsWith($InstallPrefix, [StringComparison]::OrdinalIgnoreCase)
if ($DataInsideInstall -and -not $ShouldDeleteUserData) {
    throw 'Refusing to uninstall because user data is inside the installation directory and cannot be retained safely.'
}
if ($ShouldDeleteUserData) {
    $DataMarkerPath = Join-Path $DataRoot '.nna-install.json'
    if (-not (Test-Path -LiteralPath $DataMarkerPath)) { throw 'Refusing full uninstall because the user-data marker is missing.' }
    $DataMarker = Get-Content -LiteralPath $DataMarkerPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($DataMarker.product -ne 'NotNativeAgent' -or
        (Resolve-UninstallRoot ([string]$DataMarker.data_root) 'user data' $true) -ne $DataRoot -or
        $DataMarker.deletable -ne $true) {
        throw 'Refusing full uninstall because the user-data marker is invalid or the directory predates this NNA installation.'
    }
}

$MutexHash = Get-UninstallMutexHash $InstallRoot
$UninstallMutex = Enter-UninstallMutex "Local\NotNativeAgent-Uninstall-$MutexHash" 0 'Another uninstall is already operating on this NotNativeAgent installation.'

try {
$BinRoot = Join-Path $InstallRoot 'bin'
$InstalledCli = Join-Path $InstallRoot 'installed\src\cli.js'
if (Test-Path -LiteralPath $InstalledCli) {
    $PriorNnaHome = $env:NNA_HOME
    try {
        $env:NNA_HOME = [string]$Marker.data_root
        & ([string]$Marker.node) $InstalledCli gateway stop 2>$null | Out-Null
        & ([string]$Marker.node) $InstalledCli opencode stop 2>$null | Out-Null
    } catch { Write-Warning 'A running Telegram gateway or OpenCode service could not be stopped cleanly; continuing uninstall.' }
    finally { $env:NNA_HOME = $PriorNnaHome }
}
$GatewayStartup = Join-Path ([Environment]::GetFolderPath('Startup')) 'NotNativeAgent-Telegram.vbs'
if (Test-Path -LiteralPath $GatewayStartup) {
    $GatewayStartupSource = Get-Content -LiteralPath $GatewayStartup -Raw
    if ($GatewayStartupSource.IndexOf($InstalledCli, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Remove-Item -LiteralPath $GatewayStartup -Force
    } else {
        Write-Warning 'The Telegram startup entry belongs to another NNA installation and was preserved.'
    }
}
$OpencodeStartup = Join-Path ([Environment]::GetFolderPath('Startup')) 'NotNativeAgent-OpenCode.vbs'
if (Test-Path -LiteralPath $OpencodeStartup) {
    $OpencodeStartupSource = Get-Content -LiteralPath $OpencodeStartup -Raw
    if ($OpencodeStartupSource.IndexOf($InstalledCli, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Remove-Item -LiteralPath $OpencodeStartup -Force
    } else {
        Write-Warning 'The OpenCode startup entry belongs to another NNA installation and was preserved.'
    }
}
# Why: OpenCode login wiring lives in user-scope environment variables, so an
# uninstall that leaves them dangling would make the next NNA install inherit
# credentials and a host URL for a service that no longer exists here. The
# four names carry no owner marker, hold a single owner per Windows user, and
# the startup entry above is already preserved for another installation; the
# clear therefore runs only when this install's data-root record proves
# enablement, because an absent, disabled, or unreadable record is proof of
# nothing and every stale value is rewritten by the next local
# `nna opencode enable` read-and-transmit anyway.
$OpencodeOwnedByThisInstall = $false
$OpencodeConfigPath = Join-Path $DataRoot 'config\opencode.json'
if (Test-Path -LiteralPath $OpencodeConfigPath) {
    try { $OpencodeOwnedByThisInstall = (Get-Content -LiteralPath $OpencodeConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json).enabled -eq $true } catch { }
}
if ($OpencodeOwnedByThisInstall) {
    foreach ($Name in @('OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_SERVER_PASSWORD')) {
        if ($null -ne [Environment]::GetEnvironmentVariable($Name, 'User')) {
            [Environment]::SetEnvironmentVariable($Name, $null, 'User')
        }
    }
}
if (-not $SkipPathUpdate) {
    $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $PathMutex = Enter-UninstallMutex "Local\NotNativeAgent-UserPath-$CurrentSid" 30000 'Timed out waiting to update the user PATH.'
    try {
        $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        # Split only on semicolons outside quoted entries and preserve empty entries verbatim.
        $Entries = @([regex]::Split([string]$UserPath, ';(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)'))
        $NormalizedBinRoot = $BinRoot.Trim().Trim('"').TrimEnd('\', '/')
        $RetainedEntries = @($Entries | Where-Object { $_.Trim().Trim('"').TrimEnd('\', '/') -ine $NormalizedBinRoot })
        # Invariant: an uninstall without a matching PATH entry does not rewrite unrelated user settings.
        if ($RetainedEntries.Count -ne $Entries.Count) {
            [Environment]::SetEnvironmentVariable('Path', ($RetainedEntries -join ';'), 'User')
        }
    } finally {
        $PathMutex.ReleaseMutex()
        $PathMutex.Dispose()
    }
}
if ($ParentProcessId -gt 0) {
    $ParentProcess = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
    if ($ParentProcess -and -not $ParentProcess.WaitForExit(15000)) {
        throw 'Refusing to remove the application while the NNA launcher is still running.'
    }
}
try { Remove-Item -LiteralPath $InstallRoot -Recurse -Force }
catch { throw "Failed to remove NotNativeAgent from '$InstallRoot'. Close running NNA processes and, if access was denied, run the uninstaller with sufficient privileges. $($_.Exception.Message)" }
Write-Output "Removed NotNativeAgent from $InstallRoot"

if ($ShouldDeleteUserData -and -not $DataInsideInstall) {
    try { Remove-Item -LiteralPath $DataRoot -Recurse -Force }
    catch { throw "The application was removed, but user data at '$DataRoot' could not be deleted. Remove it manually with sufficient privileges. $($_.Exception.Message)" }
    Write-Output "Deleted NotNativeAgent user data from $DataRoot; this cannot be recovered by the uninstaller."
} elseif ($ShouldDeleteUserData) {
    Write-Output "Deleted NotNativeAgent user data with the installation at $DataRoot; this cannot be recovered by the uninstaller."
} else {
    Write-Output "Retained user data at $($Marker.data_root)"
}
} finally {
    $UninstallMutex.ReleaseMutex()
    $UninstallMutex.Dispose()
}
