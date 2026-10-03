// SPDX-License-Identifier: Apache-2.0
import { PRIVATE_ACL_PROGRAM, runPrivateWindowsProgram } from './nnd-service-private-windows.js';

// Security: discovery must not resolve PowerShell from a project's CWD or inherited PATH.
const PROCESS_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.pid -isnot [int] -or $request.pid -lt 1) { throw 'invalid pid' }
    $started = (Get-Process -Id $request.pid -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()
    [Console]::Out.WriteLine((@{version=1; pid=$request.pid; platform='win32'; start_id=$started} | ConvertTo-Json -Compress))
} catch {
    [Console]::Out.WriteLine('{"error_code":"nnd_discovery_invalid"}')
    exit 1
}
`;
export function captureDiscoveryProcessIdentity(signal, pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('NND process identity requires a live PID');
  return runPrivateWindowsProgram(PROCESS_PROGRAM, { pid }, signal);
}

const PROGRAM = PRIVATE_ACL_PROGRAM + String.raw`
function New-FileAcl {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($operatorSid))
    foreach ($sid in $trusted) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
          [Security.Principal.SecurityIdentifier]::new($sid),
          [Security.AccessControl.FileSystemRights]::FullControl,
          [Security.AccessControl.AccessControlType]::Allow))
    }
    return $acl
}
function Assert-File([string] $path) {
    $info = [IO.FileInfo]::new($path)
    if (-not $info.Exists -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'nnd_discovery_invalid' }
    Assert-Acl $info.GetAccessControl() $true
    if ($info.Length -gt 16384) { throw 'nnd_discovery_invalid' }
}
function Open-PrivateFile([string] $path, [IO.FileMode] $mode) {
    if ([IO.File]::Exists($path)) { Assert-File $path }
    $stream = [IO.FileStream]::new($path, $mode,
      [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::None,
      4096, [IO.FileOptions]::WriteThrough, (New-FileAcl))
    try { Assert-Acl $stream.GetAccessControl() $true; return $stream }
    catch { $stream.Dispose(); throw }
}
function Open-DiscoveryGate([string] $path) {
    $wait = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
        try { return Open-PrivateFile $path ([IO.FileMode]::OpenOrCreate) }
        catch [IO.IOException] {
            # Invariant: polling readers share this gate with publication and removal. Only
            # transient Windows sharing/lock contention permits a bounded retry.
            $nativeCode = $_.Exception.HResult -band 0xffff
            if ($nativeCode -notin @(32,33)) { throw }
            if ($wait.ElapsedMilliseconds -ge 2000) { throw 'nnd_discovery_busy' }
            Start-Sleep -Milliseconds 20
        }
    }
}
function Read-Record([string] $path) {
    if (-not [IO.File]::Exists($path)) { return $null }
    Assert-File $path
    $stream = Open-PrivateFile $path ([IO.FileMode]::Open)
    try {
        if ($stream.Length -gt 16384) { throw 'nnd_discovery_invalid' }
        $bytes = [byte[]]::new([int]$stream.Length)
        $offset = 0
        while ($offset -lt $bytes.Length) {
            $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
            if ($count -eq 0) { throw 'nnd_discovery_invalid' }
            $offset += $count
        }
        try { return [Text.UTF8Encoding]::new($false,$true).GetString($bytes) | ConvertFrom-Json }
        catch { throw 'nnd_discovery_invalid' }
    } finally { $stream.Dispose() }
}
function Write-New([string] $path, $record) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($record | ConvertTo-Json -Compress -Depth 8))
    if ($bytes.Length -gt 16384) { throw 'nnd_discovery_invalid' }
    $stream = Open-PrivateFile $path ([IO.FileMode]::CreateNew)
    try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
}
function Assert-Pointer($pointer) {
    if ($null -eq $pointer) { return }
    $keys = @($pointer.PSObject.Properties.Name | Sort-Object)
    if (($keys -join ',') -ne 'data_id,installation_id,instance_id,version' -or $pointer.version -ne '1.0' -or
        $pointer.data_id -ne $request.data_id -or $pointer.installation_id -notmatch '^nna_[a-f0-9]{64}$' -or
        $pointer.instance_id -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') {
        throw 'nnd_discovery_invalid'
    }
}
function Assert-Generation($value) {
    if ($null -eq $value) { throw 'nnd_discovery_invalid' }
    $keys = @($value.PSObject.Properties.Name | Sort-Object)
    if (($keys -join ',') -ne 'control_token,created_at,data_id,endpoint,installation_id,instance_id,process_identity,purpose,version' -or
        $value.version -ne '1.0' -or $value.purpose -ne 'nnd_service_control' -or
        $value.data_id -ne $request.data_id -or $value.installation_id -notmatch '^nna_[a-f0-9]{64}$' -or
        $value.instance_id -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' -or
        $value.control_token -cnotmatch '^[A-Za-z0-9_-]{43}$' -or $value.created_at -notmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$') {
        throw 'nnd_discovery_invalid'
    }
    $uri = $null
    if (-not [Uri]::TryCreate($value.endpoint, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'http' -or $uri.Host -notin @('127.0.0.1','[::1]') -or
        $uri.Port -lt 1 -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        throw 'nnd_discovery_invalid'
    }
    $processKeys = @($value.process_identity.PSObject.Properties.Name | Sort-Object)
    if (($processKeys -join ',') -ne 'pid,platform,start_id,version' -or $value.process_identity.version -ne 1 -or
        $value.process_identity.platform -ne 'win32' -or $value.process_identity.pid -isnot [int] -or
        $value.process_identity.pid -lt 1 -or $value.process_identity.start_id -notmatch '^\d{1,32}$') { throw 'nnd_discovery_invalid' }
}
function Read-Current {
    $pointer = Read-Record $current
    Assert-Pointer $pointer
    if ($null -eq $pointer) { return $null }
    $generation = Read-Record ([IO.Path]::Combine($directory, 'generation-'+$pointer.instance_id+'.json'))
    Assert-Generation $generation
    if ($null -eq $generation -or $generation.instance_id -ne $pointer.instance_id -or
        $generation.installation_id -ne $pointer.installation_id -or $generation.data_id -ne $pointer.data_id) {
        throw 'nnd_discovery_invalid'
    }
    return $generation
}
function Mutate-Current {
    $pointer = Read-Record $current
    Assert-Pointer $pointer
    $actual = if ($null -eq $pointer) { $null } else { $pointer.instance_id }
    if ($actual -cne $request.expected_instance_id) { throw 'nnd_discovery_conflict' }
    if ($request.action -eq 'remove') {
        if ($actual -ne $request.instance_id) { throw 'nnd_discovery_conflict' }
        [void](Read-Current)
        [IO.File]::Delete($current)
        [IO.File]::Delete([IO.Path]::Combine($directory, 'generation-'+$actual+'.json'))
        return @{removed=$true}
    }
    # Preserve corrupt predecessor evidence; retirement applies only to a validated prior generation.
    if ($null -ne $pointer) { [void](Read-Current) }
    $generation = Read-Record ([IO.Path]::Combine($directory, 'generation-'+$request.instance_id+'.json'))
    Assert-Generation $generation
    if ($null -eq $generation -or $generation.installation_id -ne $request.installation_id -or
        $generation.data_id -ne $request.data_id -or $generation.instance_id -ne $request.instance_id) {
        throw 'nnd_discovery_invalid'
    }
    $next = @{version='1.0'; installation_id=$request.installation_id; data_id=$request.data_id; instance_id=$request.instance_id}
    $temporary = [IO.Path]::Combine($directory, 'pointer-'+[Guid]::NewGuid().ToString()+'.tmp')
    try {
        Write-New $temporary $next
        if ($null -eq $pointer) { [IO.File]::Move($temporary, $current) }
        else { [IO.File]::Replace($temporary, $current, [NullString]::Value) }
    } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    $retired = $true
    if ($null -ne $pointer -and $actual -cne $request.instance_id) {
        try { [IO.File]::Delete([IO.Path]::Combine($directory, 'generation-'+$actual+'.json')) }
        catch { $retired = $false }
    }
    # Publication has committed. Cleanup failure never misreports that pointer switch as rolled back.
    return @{published=$true; retired_previous=$retired}
}
function Discard-Generation {
    $pointer = Read-Record $current
    Assert-Pointer $pointer
    if ($null -ne $pointer -and $pointer.instance_id -ceq $request.instance_id) {
        throw 'nnd_discovery_conflict'
    }
    $path = [IO.Path]::Combine($directory, 'generation-'+$request.instance_id+'.json')
    $generation = Read-Record $path
    if ($null -ne $generation) {
        Assert-Generation $generation
        if ($generation.instance_id -cne $request.instance_id -or
            $generation.installation_id -cne $request.installation_id -or
            $generation.data_id -cne $request.data_id) { throw 'nnd_discovery_invalid' }
        [IO.File]::Delete($path)
    }
    return @{discarded=$true}
}
try {
    $source = [Console]::In.ReadToEnd()
    if ([Text.Encoding]::UTF8.GetByteCount($source) -gt 16384) { throw 'nnd_discovery_invalid' }
    $request = $source | ConvertFrom-Json
    $directory = [string]$request.directory
    Assert-Ancestors $directory
    Assert-Directory $directory $true
    $current = [IO.Path]::Combine($directory,'current.json')
    $gatePath = [IO.Path]::Combine($directory,'publish.lock')
    $gate = Open-DiscoveryGate $gatePath
    try {
        switch ($request.action) {
            'create' {
                Assert-Generation $request.record
                $count = 0
                foreach ($existing in [IO.Directory]::EnumerateFiles($directory, 'generation-*.json')) {
                    $count++
                    if ($count -ge 64) { throw 'nnd_discovery_capacity' }
                }
                $path = [IO.Path]::Combine($directory,'generation-'+$request.record.instance_id+'.json')
                Write-New $path $request.record
                $result = @{created=$true}
            }
            'read' { $result = @{record=(Read-Current)} }
            'inspect' {
                $generation = Read-Record ([IO.Path]::Combine($directory,'generation-'+$request.instance_id+'.json'))
                Assert-Generation $generation
                if ($generation.instance_id -cne $request.instance_id -or
                    $generation.installation_id -cne $request.installation_id -or
                    $generation.data_id -cne $request.data_id) { throw 'nnd_discovery_invalid' }
                $result = @{record=$generation}
            }
            'publish' { $result = Mutate-Current }
            'remove' { $result = Mutate-Current }
            'discard' { $result = Discard-Generation }
            default { throw 'nnd_discovery_invalid' }
        }
    } finally { $gate.Dispose() }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress -Depth 8))
} catch {
    $code = [string]$_.Exception.Message
    if ($code -notmatch '^nnd_(private_(path_invalid|namespace_unsafe|acl_unsafe)|discovery_(conflict|invalid|busy|capacity))$') {
        $code = 'nnd_private_storage_unavailable'
    }
    [Console]::Out.WriteLine((@{error_code=$code} | ConvertTo-Json -Compress))
    exit 1
}
`;
export function runDiscoveryOperation(request, signal) { return runPrivateWindowsProgram(PROGRAM, request, signal); }
