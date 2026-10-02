// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ContractError } from './ids.js';

const MAX_OUTPUT = 16 * 1024;
const TIMEOUT_MS = 5000;
// Security: paths enter through stdin JSON. The fixed program never changes an existing directory ACL.
const ACL_PROGRAM = String.raw`
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
    $acl = $info.GetAccessControl()
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
try {
    $source = [Console]::In.ReadToEnd()
    if ($source.Length -gt 8192) { throw 'nnd_private_path_invalid' }
    $request = $source | ConvertFrom-Json
    $root = [IO.Path]::GetFullPath([string] $request.data_root)
    if ($root -notmatch '^[A-Za-z]:\\') { throw 'nnd_private_path_invalid' }
    # Security: mapped network drives have remote ACL trustees and cannot share our host-local lock.
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'nnd_private_path_invalid' }
    Assert-Ancestors $root
    $runtime = [IO.Path]::Combine($root, 'runtime')
    Create-PrivateDirectory $runtime
    Assert-Ancestors $runtime
    $privatePath = [IO.Path]::Combine($runtime, 'nnd')
    Create-PrivateDirectory $privatePath
    Assert-Ancestors $privatePath
    Assert-Directory $privatePath $true
    [Console]::Out.WriteLine((@{path=$privatePath; owner_sid=$operatorSid} | ConvertTo-Json -Compress))
} catch {
    $code = [string] $_.Exception.Message
    if ($code -notmatch '^nnd_private_(path_invalid|namespace_unsafe|acl_unsafe)$') { $code = 'nnd_private_storage_unavailable' }
    [Console]::Out.WriteLine((@{error_code=$code} | ConvertTo-Json -Compress))
    exit 1
}
`;
function failure(code) { return new ContractError(code, 'NND private runtime storage could not be verified'); }
function runAclProgram(executable, dataRoot) {
  const input = JSON.stringify({ data_root: dataRoot });
  if (Buffer.byteLength(input, 'utf8') > 16 * 1024) return Promise.reject(failure('nnd_private_path_invalid'));
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]));
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ACL_PROGRAM],
      { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(failure('nnd_private_storage_unavailable')), TIMEOUT_MS);
    child.once('error', () => finish(failure('nnd_private_storage_unavailable')));
    child.stdin.on('error', () => finish(failure('nnd_private_storage_unavailable')));
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) finish(failure('nnd_private_storage_unavailable'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) finish(failure('nnd_private_storage_unavailable'));
    });
    child.once('close', (code) => {
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(failure('nnd_private_storage_unavailable')); }
      const allowed = ['nnd_private_path_invalid', 'nnd_private_namespace_unsafe', 'nnd_private_acl_unsafe'];
      if (code !== 0) return finish(failure(allowed.includes(result?.error_code) ? result.error_code : 'nnd_private_storage_unavailable'));
      if (typeof result?.path !== 'string' || typeof result.owner_sid !== 'string') return finish(failure('nnd_private_storage_unavailable'));
      finish(null, result);
    });
    child.stdin.end(input);
  });
}
export async function ensurePrivateNndRuntimeDirectory(dataRoot) {
  if (process.platform !== 'win32') throw failure('nnd_private_platform_unsupported');
  if (typeof dataRoot !== 'string' || dataRoot.length > 4096 || !/^[A-Za-z]:\\/u.test(dataRoot)
    || /[\u0000-\u001f]/u.test(dataRoot) || !isAbsolute(dataRoot)) throw failure('nnd_private_path_invalid');
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== 'string' || !isAbsolute(systemRoot)) throw failure('nnd_private_storage_unavailable');
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await runAclProgram(executable, dataRoot);
  try {
    const expected = join(await realpath(dataRoot), 'runtime', 'nnd');
    const actual = await realpath(result.path);
    if (actual.toLowerCase() !== expected.toLowerCase() || !(await stat(actual)).isDirectory()) throw failure('nnd_private_path_invalid');
    return Object.freeze({ path: actual, owner_sid: result.owner_sid });
  } catch { throw failure('nnd_private_path_invalid'); }
}
