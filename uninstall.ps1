# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [string]$InstallRoot,
    [switch]$DeleteUserData,
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
Remove-Item -LiteralPath $InstallRoot -Recurse -Force
Write-Output "Removed NotNativeAgent from $InstallRoot"

if ($DeleteUserData) {
    $DataRoot = [IO.Path]::GetFullPath([string]$Marker.data_root)
    $DataMarkerPath = Join-Path $DataRoot '.nna-install.json'
    if (-not (Test-Path -LiteralPath $DataMarkerPath)) { throw 'Application removed, but user data was retained because its marker is missing.' }
    $DataMarker = Get-Content -LiteralPath $DataMarkerPath -Raw | ConvertFrom-Json
    if ($DataMarker.product -ne 'NotNativeAgent' -or [IO.Path]::GetFullPath($DataMarker.data_root) -ne $DataRoot -or $DataMarker.deletable -ne $true) {
        throw 'Application removed, but user data was retained because its marker is invalid.'
    }
    Remove-Item -LiteralPath $DataRoot -Recurse -Force
    Write-Output "Deleted NotNativeAgent user data from $DataRoot; this cannot be recovered by the uninstaller."
} else {
    Write-Output "Retained user data at $($Marker.data_root)"
}
