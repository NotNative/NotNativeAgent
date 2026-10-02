// SPDX-License-Identifier: Apache-2.0
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ContractError } from './ids.js';

// Security: paths enter through stdin JSON. The fixed program never changes an existing directory ACL.
import { PRIVATE_ACL_PROGRAM, runPrivateWindowsProgram } from './nnd-service-private-windows.js';
const ACL_PROGRAM = PRIVATE_ACL_PROGRAM + String.raw`
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
export async function ensurePrivateNndRuntimeDirectory(dataRoot, { signal } = {}) {
  if (process.platform !== 'win32') throw failure('nnd_private_platform_unsupported');
  if (typeof dataRoot !== 'string' || dataRoot.length > 4096 || !/^[A-Za-z]:\\/u.test(dataRoot)
    || /[\u0000-\u001f]/u.test(dataRoot) || !isAbsolute(dataRoot)) throw failure('nnd_private_path_invalid');
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== 'string' || !isAbsolute(systemRoot)) throw failure('nnd_private_storage_unavailable');
  const result = await runPrivateWindowsProgram(ACL_PROGRAM, { data_root: dataRoot }, signal);
  try {
    const expected = join(await realpath(dataRoot), 'runtime', 'nnd');
    const actual = await realpath(result.path);
    if (actual.toLowerCase() !== expected.toLowerCase() || !(await stat(actual)).isDirectory()) throw failure('nnd_private_path_invalid');
    return Object.freeze({ path: actual, owner_sid: result.owner_sid });
  } catch { throw failure('nnd_private_path_invalid'); }
}
