# Stable shortcut entry. The selected NNA runtime runs the resolver; no slot path is saved here.
$ErrorActionPreference = 'Stop'
try {
$anchor = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$selectionFile = Join-Path $anchor 'nna-service-selection.json'
$selectionInfo = Get-Item -LiteralPath $selectionFile -Force
if ($selectionInfo.PSIsContainer -or $selectionInfo.Length -gt 16384 -or
    ($selectionInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'NND native selection is invalid.' }
$selection = Get-Content -LiteralPath $selectionFile -Raw | ConvertFrom-Json
if ($selection.schema_version -cne '1.0' -or $selection.nna_install_root -isnot [string] -or
    ![IO.Path]::IsPathRooted($selection.nna_install_root)) { throw 'NND native selection is invalid.' }
$descriptorFile = Join-Path $selection.nna_install_root 'install.json'
$descriptorInfo = Get-Item -LiteralPath $descriptorFile -Force
if ($descriptorInfo.PSIsContainer -or $descriptorInfo.Length -gt 16384 -or
    ($descriptorInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Selected NNA descriptor is invalid.' }
$descriptor = Get-Content -LiteralPath $descriptorFile -Raw | ConvertFrom-Json
if ($descriptor.product -cne 'NotNativeAgent' -or $descriptor.node -isnot [string] -or
    ![IO.Path]::IsPathRooted($descriptor.node) -or
    !(Test-Path -LiteralPath $descriptor.node -PathType Leaf)) { throw 'Selected NNA runtime is invalid.' }
$env:NODE_OPTIONS = ''
$env:ELECTRON_RUN_AS_NODE = ''
# Start the supervised desktop service (idempotent): the supervisor owns the
# service + tray + UI child, and an already-running service resolves to its
# live status. The NNA CLI surface (`nna desktop start`) owns the lifecycle.
$cliPath = Join-Path $selection.nna_install_root 'installed\src\cli.js'
if (!(Test-Path -LiteralPath $cliPath -PathType Leaf)) { $cliPath = Join-Path $selection.nna_install_root 'src\cli.js' }
if (!(Test-Path -LiteralPath $cliPath -PathType Leaf)) { throw 'Selected NNA CLI is unavailable.' }
& $descriptor.node $cliPath desktop start
if ($LASTEXITCODE -ne 0) { throw "Desktop service start failed (exit $LASTEXITCODE)." }
} catch {
    # Shortcut runs with a hidden console; surface a failed launch to the user.
    $message = "NotNativeDesktop could not start.`r`n`r`n$($_.Exception.Message)"
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($message, 'NotNativeDesktop',
            [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
    } catch { Write-Error $message }
    exit 1
}
