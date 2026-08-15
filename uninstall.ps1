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
if (-not $InstallRoot) { $InstallRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NotNativeAgent' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$MarkerPath = Join-Path $InstallRoot 'install.json'
if (-not (Test-Path -LiteralPath $MarkerPath)) { throw 'Refusing to uninstall: NotNativeAgent install marker is missing.' }
$Marker = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
if ($Marker.product -ne 'NotNativeAgent' -or [IO.Path]::GetFullPath($Marker.install_root) -ne $InstallRoot) {
    throw 'Refusing to uninstall: install marker does not match the requested directory.'
}
if ($DeleteUserData -and $KeepUserData) { throw 'Choose either -DeleteUserData or -KeepUserData, not both.' }

if ([Console]::IsInputRedirected -or -not [Environment]::UserInteractive) {
    throw 'Refusing to uninstall without a directly attached interactive terminal. Run "nna uninstall" yourself and complete its confirmation challenge.'
}
$Challenge = [Security.Cryptography.RandomNumberGenerator]::GetInt32(100000, 1000000)
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

$DataRoot = [IO.Path]::GetFullPath([string]$Marker.data_root)
$InstallPrefix = $InstallRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$DataInsideInstall = $DataRoot.Equals($InstallRoot, [StringComparison]::OrdinalIgnoreCase) -or $DataRoot.StartsWith($InstallPrefix, [StringComparison]::OrdinalIgnoreCase)
if ($DataInsideInstall -and -not $ShouldDeleteUserData) {
    throw 'Refusing to uninstall because user data is inside the installation directory and cannot be retained safely.'
}
if ($ShouldDeleteUserData) {
    $DataMarkerPath = Join-Path $DataRoot '.nna-install.json'
    if (-not (Test-Path -LiteralPath $DataMarkerPath)) { throw 'Refusing full uninstall because the user-data marker is missing.' }
    $DataMarker = Get-Content -LiteralPath $DataMarkerPath -Raw | ConvertFrom-Json
    if ($DataMarker.product -ne 'NotNativeAgent' -or [IO.Path]::GetFullPath($DataMarker.data_root) -ne $DataRoot -or $DataMarker.deletable -ne $true) {
        throw 'Refusing full uninstall because the user-data marker is invalid or the directory predates this NNA installation.'
    }
}

$MutexHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($InstallRoot))).Substring(0, 24)
$UninstallMutex = [Threading.Mutex]::new($false, "Local\NotNativeAgent-Uninstall-$MutexHash")
if (-not $UninstallMutex.WaitOne(0)) {
    $UninstallMutex.Dispose()
    throw 'Another uninstall is already operating on this NotNativeAgent installation.'
}

try {
$BinRoot = Join-Path $InstallRoot 'bin'
$InstalledCli = Join-Path $InstallRoot 'installed\src\cli.js'
if (Test-Path -LiteralPath $InstalledCli) {
    $PriorNnaHome = $env:NNA_HOME
    try {
        $env:NNA_HOME = [string]$Marker.data_root
        & ([string]$Marker.node) $InstalledCli gateway stop 2>$null | Out-Null
    } catch { Write-Warning 'The Telegram gateway could not be stopped cleanly; continuing uninstall.' }
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
if (-not $SkipPathUpdate) {
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    # Split only on semicolons outside quoted entries and preserve empty entries verbatim.
    $Entries = @([regex]::Split([string]$UserPath, ';(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)'))
    $NormalizedBinRoot = $BinRoot.Trim().Trim('"').TrimEnd('\', '/')
    $Entries = @($Entries | Where-Object { $_.Trim().Trim('"').TrimEnd('\', '/') -ine $NormalizedBinRoot })
    [Environment]::SetEnvironmentVariable('Path', ($Entries -join ';'), 'User')
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
