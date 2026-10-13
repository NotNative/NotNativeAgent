# A staged payload is inert. Native NNA owns its immutable slot and recovery evidence.
function Assert-NndPrebuiltPayload([string]$PayloadRoot, [string]$ManifestSha256, [string]$TargetPath) {
    if ($ManifestSha256 -cnotmatch '^[a-fA-F0-9]{64}$' -or ![IO.Path]::IsPathRooted($PayloadRoot)) {
        throw 'Prebuilt staging requires an absolute payload root and an independently obtained manifest SHA-256.'
    }
    $payload = [IO.Path]::GetFullPath($PayloadRoot).TrimEnd('\', '/')
    $target = [IO.Path]::GetFullPath($TargetPath).TrimEnd('\', '/')
    if ($payload.Equals($target, [StringComparison]::OrdinalIgnoreCase) -or
        $payload.StartsWith("$target\", [StringComparison]::OrdinalIgnoreCase) -or
        $target.StartsWith("$payload\", [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Prebuilt payload and NND installation target must be separate.'
    }
    $manifest = Join-Path $payload 'NND_PAYLOAD.json'
    $item = Get-Item -LiteralPath $manifest -Force -ErrorAction Stop
    if ($item.PSIsContainer -or $item.Length -gt 33554432 -or
        ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Prebuilt payload manifest is not a bounded regular file.'
    }
    $stream = [IO.File]::Open($manifest, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
    finally { $hasher.Dispose(); $stream.Dispose() }
    if (!$actual.Equals($ManifestSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Prebuilt payload manifest SHA-256 does not match the trusted digest; nothing was staged.'
    }
    $metadata = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($metadata.version -isnot [string] -or $metadata.version -cnotmatch '^\d{8}-[1-9]\d{0,5}$') {
        throw 'Prebuilt payload manifest version is invalid; nothing was staged.'
    }
    $schemaMember = $metadata.PSObject.Properties['data_schema']
    if ($null -ne $schemaMember -and ($schemaMember.Value -isnot [string] -or $schemaMember.Value -cnotmatch '^[a-z0-9._-]{1,64}$')) {
        throw 'Prebuilt payload manifest data schema is invalid; nothing was staged.'
    }
    # Absent means the historical first data schema; the anchor records what
    # the operator's existing package uses.
    return @{ Root = $payload; Sha256 = $actual.ToLowerInvariant(); Version = $metadata.version;
        DataSchema = $(if ($null -eq $schemaMember) { '1' } else { $schemaMember.Value }) }
}

function Invoke-NndPrebuiltStage($SelectedNna, $CheckedPayload) {
    $payload = $CheckedPayload.Root
    $actual = $CheckedPayload.Sha256
    $operation = [Guid]::NewGuid().ToString()
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $SelectedNna.Node
    $startInfo.Arguments = (ConvertTo-NndNativeArgument $SelectedNna.Cli) + ' nnd service stage-payload ' +
        (ConvertTo-NndNativeArgument $SelectedNna.InstallRoot) + ' ' +
        (ConvertTo-NndNativeArgument $payload) + ' ' + $operation
    $startInfo.WorkingDirectory = $SelectedNna.InstallRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $false
    $startInfo.EnvironmentVariables['NNA_HOME'] = $SelectedNna.DataRoot
    foreach ($key in @('NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE')) { $startInfo.EnvironmentVariables.Remove($key) }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    try {
        if (!$process.Start()) { throw 'Native staging did not start.' }
        $started = $true
        $buffer = New-Object char[] 1024
        $output = New-Object System.Text.StringBuilder
        $deadline = [DateTime]::UtcNow.AddMinutes(5)
        while ($true) {
            $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -le 0) { throw 'Native staging exceeded its deadline.' }
            $read = $process.StandardOutput.ReadAsync($buffer, 0, $buffer.Length)
            if (!$read.Wait($remaining)) { throw 'Native staging exceeded its deadline.' }
            if ($read.Result -eq 0) { break }
            [void]$output.Append($buffer, 0, $read.Result)
            if ($output.Length -gt 8192) { throw 'Native staging response exceeded its bound.' }
        }
        $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($remaining -le 0 -or !$process.WaitForExit($remaining) -or $process.ExitCode -ne 0) {
            throw 'Native staging did not confirm completion.'
        }
        $result = $output.ToString() | ConvertFrom-Json
        $keys = @($result.PSObject.Properties.Name)
        $expected = @('state', 'operation_id', 'version', 'payload_sha256', 'slot', 'replay_window')
        if ($keys.Count -ne $expected.Count -or @($expected | Where-Object { $_ -notin $keys }).Count -ne 0 -or
            $result.state -cne 'slot_ready' -or $result.operation_id -cne $operation -or
            $result.payload_sha256 -cne $actual.ToLowerInvariant() -or
            $result.version -cne $CheckedPayload.Version -or
            $result.slot -isnot [string] -or ![IO.Path]::IsPathRooted($result.slot) -or
            $result.replay_window -cne 'last_16_terminal_operations') {
            throw 'Native staging response did not confirm the selected payload.'
        }
        return $result
    } catch {
        throw "NND payload was not activated. Native staging outcome may be uncertain for operation $operation. Run install.ps1 -RecoverPrebuiltStageOperation $operation with the same NNA and NND selection before retrying. $($_.Exception.Message)"
    } finally {
        if ($started -and !$process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
        $process.Dispose()
    }
}

function Invoke-NndPrebuiltActivationPreflight($SelectedNna, $CheckedPayload, $SelectedCapability, $StageOperation, [string]$ActivationOperation) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $SelectedNna.Node
    $startInfo.Arguments = (ConvertTo-NndNativeArgument $SelectedNna.Cli) + ' nnd service activation-preflight ' +
        (ConvertTo-NndNativeArgument $SelectedNna.InstallRoot) + ' ' +
        (ConvertTo-NndNativeArgument $StageOperation) + ' ' + (ConvertTo-NndNativeArgument $ActivationOperation)
    $startInfo.WorkingDirectory = $SelectedNna.InstallRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $false
    $startInfo.EnvironmentVariables['NNA_HOME'] = $SelectedNna.DataRoot
    foreach ($key in @('NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE')) { $startInfo.EnvironmentVariables.Remove($key) }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    try {
        if (!$process.Start()) { throw 'Native activation preflight did not start.' }
        $started = $true
        $buffer = New-Object char[] 1024
        $output = New-Object System.Text.StringBuilder
        $deadline = [DateTime]::UtcNow.AddMinutes(5)
        while ($true) {
            $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -le 0) { throw 'Native activation preflight exceeded its deadline.' }
            $read = $process.StandardOutput.ReadAsync($buffer, 0, $buffer.Length)
            if (!$read.Wait($remaining)) { throw 'Native activation preflight exceeded its deadline.' }
            if ($read.Result -eq 0) { break }
            [void]$output.Append($buffer, 0, $read.Result)
            if ($output.Length -gt 8192) { throw 'Native activation preflight response exceeded its bound.' }
        }
        $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($remaining -le 0 -or !$process.WaitForExit($remaining) -or $process.ExitCode -ne 0) {
            throw 'Native activation preflight did not confirm completion.'
        }
        $result = $output.ToString() | ConvertFrom-Json
        $keys = @($result.PSObject.Properties.Name)
        $expected = @('state', 'operation_id', 'stage_operation_id', 'installation_id', 'data_id',
            'version', 'payload_sha256', 'candidate_sha256')
        if ($keys.Count -ne $expected.Count -or @($expected | Where-Object { $_ -notin $keys }).Count -ne 0 -or
            $result.state -cne 'slot_ready' -or $result.operation_id -cne $ActivationOperation -or
            $result.stage_operation_id -cne $StageOperation -or
            $result.installation_id -cne $SelectedCapability.installation_id -or
            $result.data_id -cne $SelectedCapability.data_id -or
            $result.version -cne $CheckedPayload.Version -or
            $result.payload_sha256 -cne $CheckedPayload.Sha256 -or
            $result.candidate_sha256 -isnot [string] -or $result.candidate_sha256 -cnotmatch '^[a-f0-9]{64}$') {
            throw 'Native activation preflight response did not confirm the staged candidate.'
        }
        return $result
    } catch {
        throw "Native activation preflight remains unresolved for stage operation $StageOperation and activation operation $ActivationOperation. Inspect the selected NNA before retrying. $($_.Exception.Message)"
    } finally {
        if ($started -and !$process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
        $process.Dispose()
    }
}

function Invoke-NndPrebuiltActivation($SelectedNna, $CheckedPayload, $Capabilities, [string]$StageOperation, [string]$CandidateSha256) {
    if ($CandidateSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Native activation requires the exact preflight candidate SHA-256.'
    }
    $activationOperation = [Guid]::NewGuid().ToString()
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $SelectedNna.Node
    $startInfo.Arguments = (ConvertTo-NndNativeArgument (Join-Path $PSScriptRoot 'installer-prebuilt-activation.mjs')) + ' ' +
        (ConvertTo-NndNativeArgument $SelectedNna.InstallRoot) + ' ' + (ConvertTo-NndNativeArgument $StageOperation)
    $startInfo.WorkingDirectory = $SelectedNna.InstallRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $false
    $startInfo.EnvironmentVariables['NNA_HOME'] = $SelectedNna.DataRoot
    $startInfo.EnvironmentVariables['NND_PREFLIGHT_CANDIDATE_SHA256'] = $CandidateSha256
    foreach ($key in @('NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE')) { $startInfo.EnvironmentVariables.Remove($key) }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    try {
        if (!$process.Start()) { throw 'Native activation orchestration did not start.' }
        $started = $true
        $buffer = New-Object char[] 1024
        $output = New-Object System.Text.StringBuilder
        # Native slot activation performs several serialized durable proof steps.
        $deadline = [DateTime]::UtcNow.AddMinutes(45)
        while ($true) {
            $read = $process.StandardOutput.ReadAsync($buffer, 0, $buffer.Length)
            while (!$read.IsCompleted) {
                $remaining = [int][Math]::Min(30000, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
                if ($remaining -le 0) { throw 'Native activation orchestration exceeded its deadline; the retained owner remains uncertain.' }
                [void]$read.Wait($remaining)
            }
            if ($read.Result -eq 0) { break }
            [void]$output.Append($buffer, 0, $read.Result)
            if ($output.Length -gt 8192) { throw 'Native activation orchestration response exceeded its bound; the retained owner remains uncertain.' }
        }
        while (!$process.HasExited) {
            $remaining = [int][Math]::Min(30000, ($deadline - [DateTime]::UtcNow).TotalMilliseconds)
            if ($remaining -le 0) { throw 'Native activation orchestration exceeded its deadline; the retained owner remains uncertain.' }
            [void]$process.WaitForExit($remaining)
        }
        if ($process.ExitCode -ne 0) {
            throw "Native activation orchestration did not confirm public attachment; the retained owner remains uncertain (stage operation $StageOperation)."
        }
        $result = $output.ToString() | ConvertFrom-Json
        $keys = @($result.PSObject.Properties.Name)
        $expected = @('state', 'operation_id', 'stage_operation_id', 'generation', 'endpoint',
            'candidate_sha256', 'root', 'version', 'installation_id', 'data_id', 'pid')
        if ($keys.Count -ne $expected.Count -or @($expected | Where-Object { $_ -notin $keys }).Count -ne 0 -or
            $result.state -cne 'public_controller_attached' -or
            $result.stage_operation_id -cne $StageOperation -or
            $result.candidate_sha256 -cne $CandidateSha256 -or
            $result.operation_id -isnot [string] -or $result.operation_id -cnotmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
            $result.generation -isnot [string] -or $result.generation.Length -gt 128 -or
            $result.endpoint -isnot [string] -or
            $result.endpoint -cnotmatch '^http://(?:127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}(?:/)?$' -or
            $result.root -isnot [string] -or ![IO.Path]::IsPathRooted($result.root) -or
            $result.version -cne $CheckedPayload.Version -or
            $result.installation_id -cne $Capabilities.installation_id -or
            $result.data_id -cne $Capabilities.data_id -or
            ($result.pid -isnot [int] -and $result.pid -isnot [long])) {
            throw "Native activation orchestration response did not confirm the selected package (stage operation $StageOperation)."
        }
        return $result
    } catch {
        throw "NND prebuilt activation remains unresolved for stage operation $StageOperation. The retained owner may be live; do not retry blindly. $($_.Exception.Message)"
    } finally {
        if ($started -and !$process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
        $process.Dispose()
    }
}

# Reconcile an interrupted native staging operation without touching the active
# NND package. Recovery must target the same selected installed NNA identity.
function Invoke-NndPrebuiltStageRecover($SelectedNna, [string]$Operation) {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $SelectedNna.Node
    $startInfo.Arguments = (ConvertTo-NndNativeArgument $SelectedNna.Cli) + ' nnd service stage-recover ' +
        (ConvertTo-NndNativeArgument $SelectedNna.InstallRoot) + ' ' + $Operation
    $startInfo.WorkingDirectory = $SelectedNna.InstallRoot
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $false
    $startInfo.EnvironmentVariables['NNA_HOME'] = $SelectedNna.DataRoot
    foreach ($key in @('NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE')) { $startInfo.EnvironmentVariables.Remove($key) }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    try {
        if (!$process.Start()) { throw 'Native recovery did not start.' }
        $started = $true
        $buffer = New-Object char[] 1024
        $output = New-Object System.Text.StringBuilder
        $deadline = [DateTime]::UtcNow.AddMinutes(5)
        while ($true) {
            $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
            if ($remaining -le 0) { throw 'Native recovery exceeded its deadline.' }
            $read = $process.StandardOutput.ReadAsync($buffer, 0, $buffer.Length)
            if (!$read.Wait($remaining)) { throw 'Native recovery exceeded its deadline.' }
            if ($read.Result -eq 0) { break }
            [void]$output.Append($buffer, 0, $read.Result)
            if ($output.Length -gt 8192) { throw 'Native recovery response exceeded its bound.' }
        }
        $remaining = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
        if ($remaining -le 0 -or !$process.WaitForExit($remaining) -or $process.ExitCode -ne 0) {
            throw 'Native recovery did not confirm completion.'
        }
        $result = $output.ToString() | ConvertFrom-Json
        $keys = @($result.PSObject.Properties.Name)
        if ($result.operation_id -cne $Operation) { throw 'Native recovery response did not match the requested operation.' }
        if ($result.state -ceq 'slot_ready') {
            $expected = @('state', 'operation_id', 'version', 'payload_sha256', 'slot', 'replay_window')
            if ($keys.Count -ne $expected.Count -or @($expected | Where-Object { $_ -notin $keys }).Count -ne 0 -or
                $result.version -isnot [string] -or $result.version -cnotmatch '^\d{8}-[1-9]\d{0,5}$' -or
                $result.payload_sha256 -isnot [string] -or $result.payload_sha256 -cnotmatch '^[a-f0-9]{64}$' -or
                $result.slot -isnot [string] -or ![IO.Path]::IsPathRooted($result.slot) -or
                $result.replay_window -cne 'last_16_terminal_operations') {
                throw 'Native recovery response did not confirm a staged slot.'
            }
        } elseif ($result.state -ceq 'unpublished') {
            $expected = @('state', 'operation_id')
            if ($keys.Count -ne $expected.Count -or @($expected | Where-Object { $_ -notin $keys }).Count -ne 0) {
                throw 'Native recovery response did not confirm an unpublished operation.'
            }
        } else { throw 'Native recovery returned an unrecognized state.' }
        return $result
    } catch {
        throw "NND stage recovery remains unresolved for operation $Operation. Inspect the selected NNA before retrying. $($_.Exception.Message)"
    } finally {
        if ($started -and !$process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
        $process.Dispose()
    }
}
