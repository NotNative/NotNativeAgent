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
$Challenge = Get-Random -Minimum 100000 -Maximum 1000000
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
if ($ShouldDeleteUserData) {
    $DataMarkerPath = Join-Path $DataRoot '.nna-install.json'
    if (-not (Test-Path -LiteralPath $DataMarkerPath)) { throw 'Refusing full uninstall because the user-data marker is missing.' }
    $DataMarker = Get-Content -LiteralPath $DataMarkerPath -Raw | ConvertFrom-Json
    if ($DataMarker.product -ne 'NotNativeAgent' -or [IO.Path]::GetFullPath($DataMarker.data_root) -ne $DataRoot -or $DataMarker.deletable -ne $true) {
        throw 'Refusing full uninstall because the user-data marker is invalid or the directory predates this NNA installation.'
    }
}

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
    $Entries = @($UserPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $BinRoot.TrimEnd('\') })
    [Environment]::SetEnvironmentVariable('Path', ($Entries -join ';'), 'User')
}
if ($ParentProcessId -gt 0) {
    try { Wait-Process -Id $ParentProcessId -Timeout 15 -ErrorAction Stop } catch {
        if (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
            throw 'Refusing to remove the application while the NNA launcher is still running.'
        }
    }
}
Remove-Item -LiteralPath $InstallRoot -Recurse -Force
Write-Output "Removed NotNativeAgent from $InstallRoot"

if ($ShouldDeleteUserData) {
    Remove-Item -LiteralPath $DataRoot -Recurse -Force
    Write-Output "Deleted NotNativeAgent user data from $DataRoot; this cannot be recovered by the uninstaller."
} else {
    Write-Output "Retained user data at $($Marker.data_root)"
}
