# Uninstall cannot trust local anchor bytes alone. The native registration and
# native guard must independently report the same selected identity and slot.
function Get-NndRegistrationStatus($SelectedNna, [switch]$AllowInvalidForRepair) {
    $previousNnaHome = $env:NNA_HOME
    $env:NNA_HOME = $SelectedNna.DataRoot
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $statusOutput = @(& $SelectedNna.Node $SelectedNna.Cli 'nnd' 'package' 'status')
        if ($LASTEXITCODE -ne 0) { throw 'NNA rejected NND package status.' }
        $text = $statusOutput -join [Environment]::NewLine
        if ($text.Length -gt 32768) { throw 'NND package status exceeded its response bound.' }
        $status = $text | ConvertFrom-Json
        $keys = @($status.PSObject.Properties.Name)
        $isInactive = $keys.Count -eq 1 -and $status.registered -eq $false
        $isActive = $keys.Count -eq 4 -and
            $status.registered -eq $true -and $status.valid -eq $true -and
            $status.root -is [string] -and $status.root.Length -gt 0 -and
            $status.version -is [string] -and
            $status.version -cmatch '^\d{8}-[1-9]\d{0,5}$'
        $isRepairable = $AllowInvalidForRepair -and $keys.Count -eq 5 -and
            $status.registered -eq $true -and $status.valid -eq $false -and
            $status.root -is [string] -and $status.root.Length -gt 0 -and
            $status.version -is [string] -and
            $status.version -cmatch '^\d{8}-[1-9]\d{0,5}$' -and
            $status.reason -cin @('nnd_package_incomplete', 'nnd_package_manifest_invalid')
        if (!$isInactive -and !$isActive -and !$isRepairable) { throw 'NNA returned an invalid NND package status.' }
        return $status
    } catch {
        throw 'NND package status is unavailable or invalid; NND preservation was not changed.'
    } finally {
        $ErrorActionPreference = $previousPreference
        $env:NNA_HOME = $previousNnaHome
    }
}

function Assert-NndUninstallRegistrationStatus($Status, [string]$PackageRoot, [string]$Version) {
    $registeredRoot = if ($Status.root -is [string]) { [IO.Path]::GetFullPath($Status.root).TrimEnd('\', '/') } else { '' }
    $expectedRoot = [IO.Path]::GetFullPath($PackageRoot).TrimEnd('\', '/')
    if ($Status.registered -ne $true -or $Status.valid -ne $true -or
        $Status.version -cne $Version -or !$registeredRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Selected NNA does not report the expected registered NND package.'
    }
}

function Assert-NndUninstallGuardIdentity($Guard, $Capabilities) {
    if ($Guard.Frame.installation_id -cne $Capabilities.installation_id -or
        $Guard.Frame.data_id -cne $Capabilities.data_id) {
        throw 'NNA installation guard identity changed; NND removal was not attempted.'
    }
}
