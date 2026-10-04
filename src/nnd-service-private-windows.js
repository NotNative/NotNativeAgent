// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { ContractError } from './ids.js';
const MAX_OUTPUT = 16 * 1024;
// Bound cold Windows OS helper startup; this failure does not assert private storage corruption.
const TIMEOUT_MS = 30000;
export const PRIVATE_ACL_PROGRAM = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($operatorSid, 'S-1-5-18', 'S-1-5-32-544')
$ancestorTrusted = $trusted + @('S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$dangerous = 0x100D0040
function Assert-Directory([string] $path, [bool] $private) {
    $info = [IO.DirectoryInfo]::new($path)
    if (-not $info.Exists -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'nnd_private_path_invalid'
    }
    Assert-Acl $info.GetAccessControl() $private
}
function Assert-Acl($acl, [bool] $private) {
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'nnd_private_namespace_unsafe' }
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ancestorTrusted -notcontains $owner) { throw 'nnd_private_namespace_unsafe' }
    if ($private -and ($owner -ne $operatorSid -or -not $acl.AreAccessRulesProtected)) {
        throw 'nnd_private_acl_unsafe'
    }
    $ownFull = $false
    $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    if ($rules.Count -gt 256) { throw 'nnd_private_acl_unsafe' }
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        $rights = [int] $rule.FileSystemRights
        $allow = $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow
        if ($private -and ((-not $allow) -or ($trusted -notcontains $sid))) { throw 'nnd_private_acl_unsafe' }
        if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        if ($allow -and ($ancestorTrusted -notcontains $sid) -and ($rights -band $dangerous)) {
            throw 'nnd_private_namespace_unsafe'
        }
        if ($allow -and $sid -eq $operatorSid -and (($rights -band 0x1F01FF) -eq 0x1F01FF)) { $ownFull = $true }
    }
    if ($private -and -not $ownFull) { throw 'nnd_private_acl_unsafe' }
}
function Assert-Ancestors([string] $path) {
    $current = [IO.DirectoryInfo]::new($path)
    for ($index = 0; $null -ne $current -and $index -lt 128; $index++) {
        Assert-Directory $current.FullName $false
        $current = $current.Parent
    }
    if ($null -ne $current) { throw 'nnd_private_path_invalid' }
}
function Create-PrivateDirectory([string] $path) {
    if ([IO.Directory]::Exists($path)) { return }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($operatorSid))
    foreach ($sid in $trusted) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            [Security.Principal.SecurityIdentifier]::new($sid),
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    [void] [IO.Directory]::CreateDirectory($path, $acl)
}
`;
function failure(code) { return new ContractError(code, 'NND private runtime storage could not be verified'); }
export function runPrivateWindowsProgram(program, request, signal) {
  if (signal?.aborted) return Promise.reject(failure('nnd_lock_lost'));
  const input = JSON.stringify(request);
  const executable = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (Buffer.byteLength(input, 'utf8') > 16 * 1024) return Promise.reject(failure('nnd_private_path_invalid'));
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]));
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', program],
      { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, settled = false, stopError = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const stop = (error) => {
      if (settled || stopError) return;
      stopError = error;
      // Security: kill requests termination; only close proves this helper can no longer write.
      child.kill();
    };
    const timer = setTimeout(() => stop(failure('nnd_private_storage_unavailable')), TIMEOUT_MS);
    const abort = () => stop(failure('nnd_lock_lost'));
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => stop(failure('nnd_private_storage_unavailable')));
    child.stdin.on('error', () => stop(failure('nnd_private_storage_unavailable')));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) stop(failure('nnd_private_storage_unavailable'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) stop(failure('nnd_private_storage_unavailable'));
    });
    child.once('close', (code) => {
      if (stopError) return finish(stopError);
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(failure('nnd_private_storage_unavailable')); }
      const allowed = ['nnd_private_path_invalid', 'nnd_private_namespace_unsafe', 'nnd_private_acl_unsafe',
        'nnd_discovery_conflict', 'nnd_discovery_invalid', 'nnd_discovery_busy', 'nnd_discovery_capacity'];
      if (code !== 0) return finish(failure(allowed.includes(result?.error_code) ? result.error_code : 'nnd_private_storage_unavailable'));
      finish(null, result);
    });
    child.stdin.end(input);
  });
}
