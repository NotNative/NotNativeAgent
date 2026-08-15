// SPDX-License-Identifier: Apache-2.0
import { access } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError } from './ids.js';

const WINDOWS_ARGUMENTS = new Map([
  ['--delete-user-data', '-DeleteUserData'],
  ['--keep-user-data', '-KeepUserData'],
]);

export async function runUninstallCommand(args, output = process.stdout, platform = process.platform) {
  const forwarded = validateArguments(args, platform);
  const { script, installRoot } = await installedUninstaller(platform);
  if (platform === 'win32') {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      ...(installRoot ? ['-InstallRoot', installRoot] : []),
      '-ParentProcessId', String(process.pid), ...forwarded,
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolveLaunch, rejectLaunch) => {
      child.once('spawn', resolveLaunch);
      child.once('error', (error) => rejectLaunch(new ContractError('uninstaller_launch_failed', 'PowerShell uninstaller could not be launched', { cause: error })));
    });
    child.unref();
    output.write('NotNativeAgent uninstaller opened in a separate PowerShell window.\n');
    return 0;
  }
  const result = spawnSync('sh', [script, ...(installRoot ? ['--install-root', installRoot] : []), ...forwarded], { stdio: 'inherit' });
  if (result.error) throw new ContractError('uninstaller_launch_failed', result.error.message);
  return Number.isInteger(result.status) ? result.status : 1;
}

function validateArguments(args, platform) {
  const allowed = new Set(['--delete-user-data', '--keep-user-data']);
  for (const value of args) {
    if (!allowed.has(value)) throw new ContractError('uninstall_option_invalid', `unknown uninstall option ${value}`);
  }
  if (args.includes('--delete-user-data') && args.includes('--keep-user-data')) {
    throw new ContractError('uninstall_option_conflict', 'choose either --delete-user-data or --keep-user-data');
  }
  if (platform === 'win32') {
    return args.map((value) => WINDOWS_ARGUMENTS.get(value));
  }
  return [...args];
}

async function installedUninstaller(platform) {
  const name = platform === 'win32' ? 'uninstall.ps1' : 'uninstall.sh';
  const sourceDirectory = dirname(fileURLToPath(import.meta.url));
  const installRoot = resolve(sourceDirectory, '..', '..');
  const installedScript = resolve(installRoot, name);
  try {
    await access(installedScript); await access(resolve(installRoot, 'install.json'));
    return { script: installedScript, installRoot };
  } catch (error) {
    if (error.code !== 'ENOENT') throw new ContractError('uninstaller_inspection_failed', 'installed uninstaller could not be inspected', { cause: error });
    // Try the source-tree recovery script when the installed copy is absent.
  }
  const sourceScript = resolve(sourceDirectory, '..', name);
  try { await access(sourceScript); return { script: sourceScript, installRoot: null }; }
  catch (error) {
    if (error.code !== 'ENOENT') throw new ContractError('uninstaller_inspection_failed', 'source-tree uninstaller could not be inspected', { cause: error });
  }
  throw new ContractError('uninstaller_missing', 'the installed uninstaller is missing; rerun the NNA installer to repair it');
}
