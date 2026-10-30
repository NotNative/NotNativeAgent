// SPDX-License-Identifier: Apache-2.0
// OpenChamber launch: the OpenCode binding reaches OpenChamber through the
// environment of the process NNA starts, never through the user profile.
//
// Why: OpenChamber attaches to an external OpenCode server only when
// OPENCODE_HOST, OPENCODE_PORT, or OPENCODE_SKIP_START appear in its own
// process environment; otherwise it starts a private server. A user-scope
// registry write would outlive the server it points at, so a reboot or logoff
// would leave an orphan binding that suppresses the fallback launch. Injecting
// the binding into one child process bounds its lifetime to that process.
//
// Invariant: this module never writes OPENCODE_* names to a user or machine
// scope. The only persistent launch state is the login startup script that
// `enable` owns, and it runs `opencode start`, which re-derives the binding.
import { existsSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { ContractError } from '../ids.js';

const LAUNCHER_NAMES = Object.freeze(['openchamber.cmd', 'openchamber.exe', 'openchamber']);

/** Build the child process environment that binds OpenChamber to this
 *  installation. The default Basic username stays absent so OpenChamber keeps
 *  its own default instead of receiving an empty override. */
export function openchamberEnvironment(config, bindUrl) {
  return {
    OPENCODE_SKIP_START: 'true',
    OPENCODE_HOST: bindUrl,
    OPENCODE_SERVER_PASSWORD: config.password,
    ...(config.username === 'opencode' ? {} : { OPENCODE_SERVER_USERNAME: config.username }),
  };
}

/** Resolve the OpenChamber launcher. An explicit path is honoured only when it
 *  exists; otherwise PATH and the per-user npm prefix are searched. */
export function resolveOpenchamberLauncher(scope = {}) {
  const platform = scope.platform ?? process.platform;
  const exists = scope.fileExists ?? existsSync;
  const explicit = typeof scope.openchamberPath === 'string' ? scope.openchamberPath.trim() : '';
  if (explicit) {
    if (exists(explicit)) return explicit;
    throw new ContractError('opencode_openchamber_unavailable', 'the configured OpenChamber launcher does not exist');
  }
  // Why: path joining follows the platform under test, so entries from that
  // platform's own PATH list are combined with its own separator instead of the
  // separator of the host running the tests.
  const pathModule = platform === 'win32' ? win32 : posix;
  const directories = String(scope.pathValue ?? scope.environment?.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':').filter((entry) => entry.length > 0);
  const prefix = scope.appData ?? scope.environment?.APPDATA;
  if (typeof prefix === 'string' && prefix) directories.push(pathModule.join(prefix, 'npm'));
  const names = platform === 'win32' ? LAUNCHER_NAMES : ['openchamber'];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = pathModule.join(directory, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Launch OpenChamber bound to this installation, or report why the launch was
 *  skipped. A missing launcher is never an error: the server is already up, and
 *  the operator may launch OpenChamber themselves with the same binding. */
export async function launchOpenchamber(config, bindUrl, scope = {}) {
  if ((scope.platform ?? process.platform) !== 'win32') return { launched: false, reason: 'unsupported_platform' };
  let launcher;
  try {
    launcher = resolveOpenchamberLauncher(scope);
  } catch (error) {
    return { launched: false, reason: 'launcher_unavailable', error: error.code ?? 'opencode_openchamber_unavailable' };
  }
  if (!launcher) return { launched: false, reason: 'launcher_not_found' };
  const spawnProcess = scope.launchProcess ?? scope.spawnProcess;
  if (typeof spawnProcess !== 'function') return { launched: false, reason: 'launch_unavailable' };
  const binding = openchamberEnvironment(config, bindUrl);
  try {
    const child = spawnProcess(launcher, [], {
      detached: true, stdio: 'ignore', windowsHide: false,
      // Why: the binding is merged over the inherited environment so PATH,
      // APPDATA, and the operator's own settings still reach OpenChamber.
      env: { ...(scope.environment ?? process.env), ...binding },
    });
    child?.unref?.();
    return {
      launched: true, pid: Number.isSafeInteger(child?.pid) ? child.pid : null,
      host: binding.OPENCODE_HOST, environment: Object.keys(binding),
    };
  } catch (error) {
    // Why: a failed OpenChamber launch must not fail `start`; the server is
    // running and the operator can relaunch OpenChamber by hand.
    return { launched: false, reason: 'launch_failed', error: error.code ?? 'opencode_openchamber_launch_failed' };
  }
}

/** Absolute launcher paths are echoed back only as their resolved form so a
 *  receipt never carries a relative path that depends on the caller's cwd. */
export function resolvedLauncher(launcher) {
  return typeof launcher === 'string' && launcher.length > 0 ? resolve(launcher) : null;
}
