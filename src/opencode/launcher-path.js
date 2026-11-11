// SPDX-License-Identifier: Apache-2.0
/**
 * The launcher path a host should spawn to get NNA in place of its own OpenCode.
 *
 * Why derive rather than store it: NNA can be installed anywhere, and a stored path
 * goes stale the moment the payload moves. The running script already knows where it
 * lives — a launcher is written beside the `installed` payload by the installer — so
 * the answer is one directory hop from this file, and it is correct for whatever
 * installation is executing.
 *
 * Invariant: the answer is a path that exists. A launcher that has been removed is
 * reported as unavailable rather than written into the operator's environment, where
 * it would make a host fail to start its OpenCode at all.
 */
import { accessSync, constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractError } from '../ids.js';

const LAUNCHER_NAMES = Object.freeze(['nna.cmd', 'nna.ps1', 'nna']);

/**
 * The launcher beside the running installation.
 *
 * @param {{scriptPath?: string, fileExists?: (path: string) => boolean}} [scope]
 * @returns {string|null} an absolute launcher path, or null when none is installed
 */
export function installedLauncherPath(scope = {}) {
  const scriptPath = scope.scriptPath ?? process.argv[1] ?? fileURLToPath(import.meta.url);
  const exists = scope.fileExists ?? existsExecutable;
  // Why three hops: `<install>/installed/src/<this file>` → `<install>/bin/`.
  const installRoot = resolve(dirname(scriptPath), '..', '..');
  for (const name of LAUNCHER_NAMES) {
    const candidate = join(installRoot, 'bin', name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The launcher path, or a typed refusal when this installation has none. */
export function requireInstalledLauncherPath(scope = {}) {
  const launcher = installedLauncherPath(scope);
  if (!launcher) {
    throw new ContractError('opencode_launcher_unavailable',
      'this installation has no NNA launcher for a host to spawn; reinstall NNA to create it');
  }
  return launcher;
}

function existsExecutable(path) {
  try { accessSync(path, constants.F_OK); return true; } catch { return false; }
}
