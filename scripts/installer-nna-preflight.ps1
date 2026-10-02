# Verify the selected installed NNA before any NND package mutation.
function Assert-NndNnaCapabilities($SelectedNna) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $SelectedNna.Node
    $startInfo.Arguments = (ConvertTo-NndNativeArgument $SelectedNna.Cli) + ' nnd service capabilities ' + (ConvertTo-NndNativeArgument $SelectedNna.InstallRoot)
    $startInfo.WorkingDirectory = $SelectedNna.InstallRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    # Keep diagnostics on the installer's stderr. Capturing arbitrary stderr
    # would make a noisy or broken native child consume unbounded memory.
    $startInfo.RedirectStandardError = $false
    $startInfo.EnvironmentVariables['NNA_HOME'] = $SelectedNna.DataRoot
    foreach ($key in @('NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE')) { $startInfo.EnvironmentVariables.Remove($key) }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    $failure = 'Selected NNA cannot provide bounded native NND capabilities. Update that NNA installation, then rerun the NND installer.'
    try {
        if (!$process.Start()) { throw $failure }
        $started = $true
        $buffer = New-Object char[] 1024
        $output = New-Object System.Text.StringBuilder
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        while ($true) {
            $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -le 0) { throw $failure }
            $read = $process.StandardOutput.ReadAsync($buffer, 0, $buffer.Length)
            if (!$read.Wait($remaining)) { throw $failure }
            if ($read.Result -eq 0) { break }
            [void]$output.Append($buffer, 0, $read.Result)
            if ($output.Length -gt 8192) { throw $failure }
        }
        $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($remaining -le 0 -or !$process.WaitForExit($remaining) -or $process.ExitCode -ne 0) { throw $failure }
        try { $capability = $output.ToString() | ConvertFrom-Json }
        catch { throw $failure }
        $keys = @($capability.PSObject.Properties.Name)
        $expectedKeys = @('protocol', 'installation_id', 'data_id', 'native_version', 'capabilities', 'commands')
        if ($keys.Count -ne $expectedKeys.Count -or @($expectedKeys | Where-Object { $_ -notin $keys }).Count -ne 0 -or
            $capability.protocol -ne '1.0' -or
            $capability.installation_id -isnot [string] -or $capability.installation_id -cnotmatch '^nna_[a-f0-9]{64}$' -or
            $capability.data_id -isnot [string] -or $capability.data_id -cnotmatch '^data_[a-f0-9]{64}$' -or
            $capability.native_version -isnot [string] -or $capability.native_version -cne $SelectedNna.Version -or
            $capability.capabilities -isnot [array] -or $capability.commands -isnot [array]) { throw $failure }
        foreach ($required in @('service_supervision', 'setup_control_plane', 'atomic_ui_attach', 'installer_guard')) {
            if ($required -cnotin $capability.capabilities) { throw "Selected NNA lacks required NND capability '$required'. Update that NNA installation, then rerun the NND installer." }
        }
        foreach ($required in @('start', 'status', 'stop', 'attach', 'install-guard')) {
            if ($required -cnotin $capability.commands) { throw "Selected NNA lacks required NND command '$required'. Update that NNA installation, then rerun the NND installer." }
        }
        return $capability
    } catch {
        if ($_.Exception.Message -like 'Selected NNA lacks required*') { throw }
        throw $failure
    } finally {
        if ($started -and !$process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
        $process.Dispose()
    }
}
