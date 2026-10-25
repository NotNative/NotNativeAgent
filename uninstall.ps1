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

function Get-UninstallMarkerHash([string]$Path) {
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $Bytes = [IO.File]::ReadAllBytes($Path)
        return [BitConverter]::ToString($Hasher.ComputeHash($Bytes)).Replace('-', '')
    } finally { $Hasher.Dispose() }
}

function Test-UninstallRecoveryState([string]$StatePath, [string]$InstallRoot, [string]$MarkerPath) {
    try {
        $StateFile = Get-Item -LiteralPath $StatePath -Force -ErrorAction Stop
        if ($StateFile.PSIsContainer -or ($StateFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
        $State = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $Services = @($State.services_stopped | ForEach-Object { [string]$_ })
        $RootMatches = ([string]$State.install_root).Equals($InstallRoot, [StringComparison]::OrdinalIgnoreCase)
        $HashMatches = ([string]$State.install_marker_sha256).Equals((Get-UninstallMarkerHash $MarkerPath), [StringComparison]::OrdinalIgnoreCase)
        return ($State.format_version -eq 1 -and $State.product -ceq 'NotNativeAgent' -and
            $RootMatches -and $HashMatches -and $Services.Count -eq 2 -and
            $Services -contains 'gateway' -and $Services -contains 'opencode')
    } catch { return $false }
}

function Write-UninstallRecoveryState([string]$StatePath, [string]$InstallRoot, [string]$MarkerPath) {
    $State = [ordered]@{
        format_version = 1
        product = 'NotNativeAgent'
        install_root = $InstallRoot
        install_marker_sha256 = Get-UninstallMarkerHash $MarkerPath
        services_stopped = @('gateway', 'opencode')
    }
    $TemporaryPath = "$StatePath.tmp-$PID-$([guid]::NewGuid().ToString('N'))"
    $Stream = $null
    try {
        $Bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($State | ConvertTo-Json -Compress))
        $Stream = [IO.File]::Open($TemporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $Stream.Write($Bytes, 0, $Bytes.Length)
        $Stream.Flush($true)
        $Stream.Dispose(); $Stream = $null
        [IO.File]::Move($TemporaryPath, $StatePath)
    } catch {
        if ($null -ne $Stream) { $Stream.Dispose() }
        Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Assert-UninstallServicesNotRunning([string]$NodePath, [string]$CliPath) {
    try { $Processes = @(Get-WmiObject -Class Win32_Process -ErrorAction Stop) }
    catch { throw "Refusing to resume uninstall because service process state could not be verified ($($_.Exception.Message))." }
    foreach ($Process in $Processes) {
        if (-not $Process.ExecutablePath -or
            -not ([string]$Process.ExecutablePath).Equals($NodePath, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $CommandLine = [string]$Process.CommandLine
        if (-not $CommandLine) {
            throw 'Refusing to resume uninstall because an NNA Node process has no inspectable command line.'
        }
        if ($CommandLine.IndexOf($CliPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $CommandLine -match '(?i)(?:^|\s)(?:gateway|opencode)\s+run(?:\s|$)') {
            return $false
        }
    }
    return $true
}

function Remove-UninstallPayloadPreservingState([string]$InstallRoot) {
    $Preserved = @('install.json', '.nna-uninstall-state.json', 'uninstall.ps1')
    foreach ($Entry in @(Get-ChildItem -LiteralPath $InstallRoot -Force -ErrorAction Stop)) {
        if ($Preserved -contains $Entry.Name) { continue }
        Remove-Item -LiteralPath $Entry.FullName -Recurse -Force -ErrorAction Stop
    }
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

function Invoke-UninstallServiceStop([string]$NodePath, [string]$CliPath, [string]$Service, [switch]$PreserveEnvironment) {
    try {
        $Arguments = @($CliPath, $Service, 'stop')
        if ($PreserveEnvironment) { $Arguments += '--preserve-environment' }
        & $NodePath @Arguments 2>$null | Out-Null
        $ExitCode = $LASTEXITCODE
        if ($ExitCode -ne 0) {
            Write-Warning "The $Service service could not be stopped cleanly (exit code $ExitCode)."
            return $false
        }
    } catch {
        Write-Warning "The $Service service could not be stopped cleanly ($($_.Exception.Message))."
        return $false
    }
    return $true
}

function Get-UninstallOpenCodeEnvironment([object]$Config) {
    if (-not $Config -or -not $Config.hostname -or -not $Config.port -or -not $Config.password) { return $null }
    $HostName = ([string]$Config.hostname).Trim().Trim('[', ']')
    if ($HostName.Contains(':')) { $HostName = "[$HostName]" }
    $Username = ([string]$Config.username).Trim()
    if (-not $Username -or $Username -ceq 'opencode') { $Username = '' }
    return @{
        OPENCODE_SKIP_START = 'true'
        OPENCODE_HOST = ('http://{0}:{1}' -f $HostName, $Config.port)
        OPENCODE_SERVER_PASSWORD = [string]$Config.password
        OPENCODE_SERVER_USERNAME = $Username
    }
}

function Test-UninstallOpenCodeEnvironmentOwner([hashtable]$Expected, [hashtable]$Current) {
    if (-not $Expected -or -not $Current) { return $false }
    foreach ($Name in @('OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME')) {
        if ([string]$Current[$Name] -cne [string]$Expected[$Name]) { return $false }
    }
    return $true
}

function Clear-UninstallOpenCodeEnvironment([string]$DataRoot) {
    $ConfigPath = Join-Path $DataRoot 'config\opencode.json'
    try {
        $Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $Expected = Get-UninstallOpenCodeEnvironment $Config
        if (-not $Expected) {
            Write-Warning 'OpenCode user environment was preserved because this installation owner could not be verified.'
            return
        }
        $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $Mutex = Enter-UninstallMutex "Local\NotNativeAgent-OpenCodeEnvironment-$Sid" 30000 'Timed out waiting to update the OpenCode user environment.'
        try {
            $Current = @{}
            foreach ($Name in $Expected.Keys) { $Current[$Name] = [Environment]::GetEnvironmentVariable($Name, 'User') }
            if (-not (Test-UninstallOpenCodeEnvironmentOwner $Expected $Current)) {
                Write-Warning 'OpenCode user environment was preserved because it no longer matches this installation.'
                return
            }
            foreach ($Name in $Expected.Keys) { [Environment]::SetEnvironmentVariable($Name, $null, 'User') }
        } finally {
            $Mutex.ReleaseMutex()
            $Mutex.Dispose()
        }
    } catch {
        Write-Warning "OpenCode user environment was preserved because ownership could not be verified ($($_.Exception.Message))."
    }
}

function Assert-UninstallNodePath([string]$Path) {
    $Root = [IO.Path]::GetPathRoot($Path)
    if (-not [IO.Path]::IsPathRooted($Path) -or $Root -eq '\' -or $Root -match '^[A-Za-z]:$' -or
        $Path.StartsWith('\\?\') -or $Path.StartsWith('\\.\') -or
        -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Refusing to uninstall: the installed Node.js runtime path is missing or unsafe.'
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
$RecoveryStatePath = Join-Path $InstallRoot '.nna-uninstall-state.json'
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
$RecoveryStateValid = Test-UninstallRecoveryState $RecoveryStatePath $InstallRoot $MarkerPath
    if (Test-Path -LiteralPath $InstalledCli -PathType Leaf) {
    $NodePath = [string]$Marker.node
    Assert-UninstallNodePath $NodePath
    $ServiceProcessesAbsent = Assert-UninstallServicesNotRunning $NodePath $InstalledCli
    if (-not $RecoveryStateValid -or -not $ServiceProcessesAbsent) {
        if (-not $RecoveryStateValid -and (Test-Path -LiteralPath $RecoveryStatePath)) {
            $PriorState = Get-Item -LiteralPath $RecoveryStatePath -Force
            if ($PriorState.PSIsContainer -or ($PriorState.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
                throw 'Refusing to replace an unsafe uninstall recovery state file.'
            }
            Remove-Item -LiteralPath $RecoveryStatePath -Force
        }
        $PriorNnaHome = $env:NNA_HOME
        try {
            $env:NNA_HOME = [string]$Marker.data_root
            $GatewayStopped = Invoke-UninstallServiceStop $NodePath $InstalledCli 'gateway'
            $OpencodeStopped = Invoke-UninstallServiceStop $NodePath $InstalledCli 'opencode' -PreserveEnvironment
        }
        finally { $env:NNA_HOME = $PriorNnaHome }
        if (-not $GatewayStopped -or -not $OpencodeStopped) {
            throw 'Refusing to remove the application while a service could still be running. Resolve the stop failure and retry uninstall.'
        }
        if (-not (Assert-UninstallServicesNotRunning $NodePath $InstalledCli)) {
            throw 'Refusing to remove the application because a service process is still running after the stop request.'
        }
        if (-not $RecoveryStateValid) { Write-UninstallRecoveryState $RecoveryStatePath $InstallRoot $MarkerPath }
    }
} elseif ($RecoveryStateValid) {
    $NodePath = [string]$Marker.node
    if (-not (Assert-UninstallServicesNotRunning $NodePath $InstalledCli)) {
        throw 'Refusing to resume uninstall because an NNA service process is running; restore the installed CLI, stop the service, and retry.'
    }
} else {
    throw 'Refusing to remove the application because its installed CLI is missing and no matching recovery state proves service shutdown. Repair or remove the installation manually.'
}
if ($ParentProcessId -gt 0) {
    $ParentProcess = Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue
    if ($ParentProcess -and -not $ParentProcess.WaitForExit(15000)) {
        throw 'Refusing to remove the application while the NNA launcher is still running.'
    }
}
try { Remove-UninstallPayloadPreservingState $InstallRoot }
catch { throw "Partial removal of NotNativeAgent from '$InstallRoot' failed. The install marker and recovery state were retained; close locked processes and retry uninstall. $($_.Exception.Message)" }

# Why: only detach user-wide launch state after all app files are gone. OpenCode
# runtime stop above explicitly preserved its shared environment for this step.
foreach ($StartupName in @('NotNativeAgent-Telegram.vbs', 'NotNativeAgent-OpenCode.vbs')) {
    try {
        $StartupPath = Join-Path ([Environment]::GetFolderPath('Startup')) $StartupName
        if (Test-Path -LiteralPath $StartupPath) {
            $StartupSource = Get-Content -LiteralPath $StartupPath -Raw
            if ($StartupSource.IndexOf($InstalledCli, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Remove-Item -LiteralPath $StartupPath -Force
            } else {
                Write-Warning "The startup entry '$StartupName' belongs to another NNA installation and was preserved."
            }
        }
    } catch { Write-Warning "Could not clean the startup entry '$StartupName' ($($_.Exception.Message))." }
}
if (-not $SkipPathUpdate) {
    try {
        $CurrentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $PathMutex = Enter-UninstallMutex "Local\NotNativeAgent-UserPath-$CurrentSid" 30000 'Timed out waiting to update the user PATH.'
        try {
            $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            # Split only on semicolons outside quoted entries and preserve empty entries verbatim.
            $Entries = @([regex]::Split([string]$UserPath, ';(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)'))
            $NormalizedBinRoot = $BinRoot.Trim().Trim('"').TrimEnd('\', '/')
            $RetainedEntries = @($Entries | Where-Object { $_.Trim().Trim('"').TrimEnd('\', '/') -ine $NormalizedBinRoot })
            if ($RetainedEntries.Count -ne $Entries.Count) {
                [Environment]::SetEnvironmentVariable('Path', ($RetainedEntries -join ';'), 'User')
            }
        } finally { $PathMutex.ReleaseMutex(); $PathMutex.Dispose() }
    } catch { Write-Warning "Could not remove the NNA bin directory from user PATH ($($_.Exception.Message))." }
}
Clear-UninstallOpenCodeEnvironment $DataRoot
foreach ($FinalPath in @($RecoveryStatePath, $MarkerPath, (Join-Path $InstallRoot 'uninstall.ps1'))) {
    if (Test-Path -LiteralPath $FinalPath) { Remove-Item -LiteralPath $FinalPath -Force }
}
Remove-Item -LiteralPath $InstallRoot -Force
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
