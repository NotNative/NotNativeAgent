# The source installer holds native ownership while copying and building NND.
function ConvertTo-NndNativeArgument([string]$Value) {
    if ($Value.Contains('"') -or $Value.Contains([char]0)) { throw 'Invalid native command argument.' }
    return '"' + [regex]::Replace($Value, '(\\+)$', '$1$1') + '"'
}
function Start-NndInstallationGuard($SelectedNna) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $SelectedNna.Node
    $startInfo.Arguments = (ConvertTo-NndNativeArgument $SelectedNna.Cli) + ' nnd service install-guard ' + (ConvertTo-NndNativeArgument $SelectedNna.InstallRoot)
    $startInfo.WorkingDirectory = $SelectedNna.InstallRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['NNA_HOME'] = $SelectedNna.DataRoot
    foreach ($key in @('NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE')) { $startInfo.EnvironmentVariables.Remove($key) }
    $guardProcess = New-Object System.Diagnostics.Process
    $guardProcess.StartInfo = $startInfo
    if (!$guardProcess.Start()) { throw 'Native installation guard failed to start.' }
    $diagnostics = $guardProcess.StandardError.ReadToEndAsync()
    try {
        $characters = New-Object char[] 8193
        $guardText = ''
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while (!$guardText.Contains("`n")) {
            $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -le 0) { throw 'Native installation guard startup timed out.' }
            $read = $guardProcess.StandardOutput.ReadAsync($characters, 0, $characters.Length)
            if (!$read.Wait($remaining) -or $read.Result -eq 0) { throw 'Native installation guard did not provide readiness.' }
            $guardText += -join $characters[0..($read.Result - 1)]
            if ($guardText.Length -gt 8192) { throw 'Native installation guard output exceeded its bound.' }
        }
        $frame = $guardText.Trim() | ConvertFrom-Json
        if ($frame.type -ne 'install_guard' -or $frame.protocol -ne '1.0' -or
            $frame.installation_id -notmatch '^nna_[a-f0-9]{64}$' -or $frame.data_id -notmatch '^data_[a-f0-9]{64}$' -or
            @($frame.PSObject.Properties).Count -ne 4 -or $guardProcess.HasExited) {
            throw 'Native installation guard identity or protocol is invalid.'
        }
        return @{ Process = $guardProcess; Frame = $frame; Diagnostics = $diagnostics }
    } catch {
        # No package mutation started. Terminate only this exact owned child.
        if (!$guardProcess.HasExited) { $guardProcess.Kill(); [void]$guardProcess.WaitForExit(5000) }
        $guardProcess.Dispose()
        throw 'NNA installation guard is unavailable. Update NNA, and stop its NND service before installing NND. Interrupted guard evidence may require recovery.'
    }
}
function Assert-NndInstallationGuard($Guard) {
    if ($Guard.Process.HasExited) { throw 'Native installation ownership was lost. Package mutation was stopped; recovery is required.' }
}
function Stop-NndInstallationGuard($Guard) {
    Assert-NndInstallationGuard $Guard
    $release = [ordered]@{ type = 'release'; installation_id = $Guard.Frame.installation_id; data_id = $Guard.Frame.data_id } | ConvertTo-Json -Compress
    $Guard.Process.StandardInput.WriteLine($release)
    $Guard.Process.StandardInput.Flush()
    $Guard.Process.StandardInput.Close()
    if (!$Guard.Process.WaitForExit(20000)) { throw 'Native installation guard did not release ownership. Its evidence was preserved for recovery.' }
    $guardExit = $Guard.Process.ExitCode
    $Guard.Process.Dispose()
    if ($guardExit -ne 0) { throw 'Native installation guard failed to release ownership. Recovery is required.' }
}
function Abandon-NndInstallationGuard($Guard) {
    # A failed mutation can leave a mixed package even after its writers stop.
    # EOF without release preserves native ownership and its durable marker.
    try { $Guard.Process.StandardInput.Close() }
    finally {
        $Guard.Process.Dispose()
        Write-Warning 'NND installation did not complete. Native installation evidence was preserved; service startup remains blocked until verified recovery.'
    }
}
