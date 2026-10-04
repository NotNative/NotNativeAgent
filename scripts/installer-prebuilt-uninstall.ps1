# Prebuilt uninstall resolves the immutable package owned by NNA; it never
# removes that slot and never accepts the public launcher anchor as package root.
function Resolve-NndPrebuiltAnchorForUninstall($InstallDirectory, $SelectedNna, $Capabilities) {
    $targetPath = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\', '/')
    $bindingPath = Join-Path $targetPath 'nnd-anchor.json'
    $bindingFile = Get-Item -LiteralPath $bindingPath -Force -ErrorAction Stop
    if ($bindingFile.PSIsContainer -or $bindingFile.Length -gt 16384 -or
        ($bindingFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Prebuilt uninstall binding is invalid.'
    }
    $binding = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json
    $keys = @($binding.PSObject.Properties.Name)
    $expectedKeys = @('schema_version', 'nna_install_root', 'nnd_package_root', 'version',
        'payload_sha256', 'candidate_sha256', 'stage_operation_id', 'activation_operation_id',
        'installation_id', 'data_id')
    if ($keys.Count -ne $expectedKeys.Count -or @($expectedKeys | Where-Object { $_ -notin $keys }).Count -ne 0 -or
        $binding.schema_version -ne '1.0' -or
        $binding.nna_install_root -isnot [string] -or $binding.nna_install_root.Length -gt 4096 -or
        $binding.nnd_package_root -isnot [string] -or $binding.nnd_package_root.Length -gt 1024 -or
        ![IO.Path]::IsPathRooted($binding.nnd_package_root) -or
        $binding.version -isnot [string] -or $binding.version -cnotmatch '^\d{8}-[1-9]\d{0,5}$' -or
        $binding.payload_sha256 -isnot [string] -or $binding.payload_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $binding.candidate_sha256 -isnot [string] -or $binding.candidate_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $binding.stage_operation_id -isnot [string] -or
        $binding.stage_operation_id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
        $binding.activation_operation_id -isnot [string] -or
        $binding.activation_operation_id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
        $binding.installation_id -isnot [string] -or $binding.installation_id -cnotmatch '^nna_[a-f0-9]{64}$' -or
        $binding.data_id -isnot [string] -or $binding.data_id -cnotmatch '^data_[a-f0-9]{64}$') {
        throw 'Prebuilt uninstall binding is invalid.'
    }
    $nativeRoot = [IO.Path]::GetFullPath($SelectedNna.InstallRoot).TrimEnd('\', '/')
    $boundNativeRoot = [IO.Path]::GetFullPath($binding.nna_install_root).TrimEnd('\', '/')
    if (!$boundNativeRoot.Equals($nativeRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $binding.installation_id -cne $Capabilities.installation_id -or
        $binding.data_id -cne $Capabilities.data_id) {
        throw 'Prebuilt uninstall binding no longer matches the selected NNA.'
    }
    $packageRoot = [IO.Path]::GetFullPath($binding.nnd_package_root).TrimEnd('\', '/')
    $versionsRoot = [IO.Path]::GetFullPath(
        (Join-Path $SelectedNna.DataRoot 'runtime\nnd\install-slots\versions')).TrimEnd('\', '/')
    if (!$packageRoot.StartsWith("$versionsRoot\", [StringComparison]::OrdinalIgnoreCase) -or
        ([IO.Directory]::GetParent($packageRoot)).FullName.TrimEnd('\', '/') -ne $versionsRoot -or
        ([IO.Path]::GetFileName($packageRoot)) -cne "$($binding.version)-$($binding.payload_sha256)" -or
        $targetPath.Equals($packageRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $targetPath.StartsWith("$packageRoot\", [StringComparison]::OrdinalIgnoreCase) -or
        $packageRoot.StartsWith("$targetPath\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Prebuilt uninstall package root is invalid.'
    }
    $checkPath = $packageRoot
    while (!$checkPath.Equals($versionsRoot, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $checkPath) {
            $item = Get-Item -LiteralPath $checkPath -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Prebuilt uninstall package ancestry contains a reparse point.'
            }
        }
        $checkPath = [IO.Directory]::GetParent($checkPath).FullName
    }
    return $packageRoot
}
