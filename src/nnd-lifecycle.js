// SPDX-License-Identifier: Apache-2.0
/** Gateway-shaped operator lifecycle for the registered NND GUI package.
 * No INSTALL_ROOT arguments: the registered package and the NNA installation
 * descriptor are resolved internally. start/enable fail gracefully when NND
 * is not installed; stop/disable/status are silent no-ops without one. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join, resolve } from 'node:path';
import { ContractError } from './ids.js';
import { readNndPackageRegistration } from './nnd-package-registration.js';
import { readNndServiceIdentity } from './nnd-service-identity.js';
import { readNndServiceDiscovery } from './nnd-service-discovery.js';
import { requestNndController } from './nnd-service-controller.js';
import { nativeEnvironment } from './nnd-service-cli.js';
import { persistAtomicJson } from './persistence/atomic-json.js';

const ENABLED_FILE = 'nnd-service.json';
const LIMIT = 4096;
const ACTIONS = ['start', 'stop', 'enable', 'disable', 'status'];
const STARTUP_SCRIPT_NAME = 'NotNativeAgent-NND.vbs';
const POWERSHELL_TIMEOUT_MS = 20_000;

export async function runNndLifecycleCommand(args, paths, options = {}) {
  const [action] = args;
  if (!ACTIONS.includes(action) || args.length !== 1) {
    throw new ContractError('nnd_command_invalid', `desktop supports ${ACTIONS.join('|')}`);
  }
  const stored = await readNndPackageRegistration(paths);
  if (!stored) {
    if (action === 'start' || action === 'enable') {
      throw new ContractError('nnd_plugin_not_installed', 'The NND plugin is not installed; install NotNativeDesktop first');
    }
    return null; // stop/disable/status without an installation are silent no-ops
  }
  if (!isBoundedRegistration(stored)) throw new ContractError('nnd_package_registry_invalid', 'NND package registry is invalid');
  if (action === 'enable') return enableWithLoginWiring(paths, options);
  if (action === 'disable') return disableWithLoginWiring(paths, options);
  const enabled = await readEnabled(paths);
  const identity = await resolveIdentity();
  if (action === 'start') return startService(identity);
  if (action === 'stop') {
    const record = await readNndServiceDiscovery(identity);
    if (!record) return { running: false };
    return requestNndController(record, 'stop');
  }
  const record = await readNndServiceDiscovery(identity);
  const base = { root: stored.root, version: stored.version, enabled, login: await loginWiringStatus(options.wiring) };
  if (!record) return { ...base, running: false };
  return { ...base, running: true, service: await requestNndController(record, 'status') };
}

function isBoundedRegistration(stored) {
  return typeof stored?.root === 'string' && stored.root.length > 0
    && typeof stored?.version === 'string' && /^\d{8}-[1-9]\d{0,5}$/u.test(stored.version);
}

async function readEnabled(paths) {
  try {
    const text = await readFile(join(paths.config, ENABLED_FILE), 'utf8');
    if (text.length > LIMIT) throw new ContractError('nnd_lifecycle_state_invalid', 'NND lifecycle state exceeds its bound');
    const value = JSON.parse(text);
    return value?.version === 1 && typeof value.enabled === 'boolean' ? value.enabled : false;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    if (error?.code === 'ENOENT') return false;
    throw new ContractError('nnd_lifecycle_state_invalid', 'NND lifecycle state is invalid');
  }
}

async function writeEnabled(paths, enabled) {
  await persistAtomicJson(join(paths.config, ENABLED_FILE), { version: 1, enabled, updated_at: new Date().toISOString() });
  return { enabled };
}

/** Login auto-start mirrors the opencode surface: a VBScript in the user's
 * Startup folder runs `nna nnd start` hidden at logon. Enable owns only the
 * wiring — a failed install reverts the flag; disable removes the script. */
async function enableWithLoginWiring(paths, options) {
  const scope = options.wiring ?? {};
  assertWindowsWiring(scope);
  const priorExisted = existsSync(join(paths.config, ENABLED_FILE));
  const prior = await readEnabled(paths);
  await writeEnabled(paths, true);
  let login;
  try {
    const identity = await resolveIdentity();
    login = await installLoginStartup(paths, { ...scope, nodePath: scope.nodePath ?? identity.node,
      cliPath: scope.cliPath ?? identity.cli_path });
  } catch (error) {
    if (priorExisted) await writeEnabled(paths, prior);
    else await unlink(join(paths.config, ENABLED_FILE)).catch(() => undefined);
    throw error;
  }
  return { enabled: true, login };
}

async function disableWithLoginWiring(paths, options) {
  const scope = options.wiring ?? {};
  assertWindowsWiring(scope);
  await writeEnabled(paths, false);
  const login = await removeLoginStartup(scope);
  return { enabled: false, login };
}

function assertWindowsWiring(scope) {
  if ((scope.platform ?? process.platform) !== 'win32') {
    throw new ContractError('nnd_login_wiring_unsupported', 'NND login auto-start is Windows-only');
  }
}

async function installLoginStartup(paths, scope) {
  const startupFolder = await resolveStartupFolder(scope);
  const scriptPath = join(startupFolder, STARTUP_SCRIPT_NAME);
  const script = [
    "' SPDX-License-Identifier: Apache-2.0",
    "' NotNativeAgent NND plugin: start the registered desktop service at login.",
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Environment("PROCESS")("NNA_HOME") = "${quoteForVbs(paths.root)}"`,
    `shell.Run """${quoteForVbs(scope.nodePath)}"" `
      // Why: the Startup script runs with an arbitrary working directory, so
      // the CLI path must be absolute to resolve at login time.
      + `--disable-warning=ExperimentalWarning ""${quoteForVbs(resolve(scope.cliPath))}"" nnd start", 0, False`,
  ].join('\r\n');
  // Why: wscript detects UTF-16 through the byte order mark, so non-ASCII
  // data-root or install paths survive without code-page interpretation.
  const encoded = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(script, 'utf16le')]);
  const write = scope.fileWriter ?? ((destination, bytes) => writeFile(destination, bytes));
  await write(scriptPath, encoded);
  return { supported: true, installed: true, script_path: scriptPath };
}

async function removeLoginStartup(scope = {}) {
  const startupFolder = await resolveStartupFolder(scope);
  const scriptPath = join(startupFolder, STARTUP_SCRIPT_NAME);
  const remove = scope.fileRemove ?? (target => unlink(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  }));
  await remove(scriptPath);
  return { supported: true, installed: false, script_path: scriptPath };
}

async function resolveStartupFolder(scope) {
  try {
    const folder = scope.startupFolder
      ? String(await scope.startupFolder())
      : (await runPowershell("[Environment]::GetFolderPath('Startup')", scope)).trim();
    if (!folder) throw new ContractError('nnd_startup_folder_empty', 'the Windows Startup folder path was empty');
    return folder;
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw asWiringFailure(error, 'nnd_startup_folder_unavailable', 'the Windows Startup folder could not be resolved');
  }
}

async function loginWiringStatus(scope = {}) {
  if ((scope.platform ?? process.platform) !== 'win32') return { supported: false, installed: false };
  try {
    const startupFolder = await resolveStartupFolder(scope);
    const scriptPath = join(startupFolder, STARTUP_SCRIPT_NAME);
    return { supported: true, installed: existsSync(scriptPath), script_path: scriptPath };
  } catch {
    return { supported: true, installed: false, script_path: null };
  }
}

async function runPowershell(script, scope, timeoutMs = POWERSHELL_TIMEOUT_MS) {
  if (scope.powershell) {
    const result = await scope.powershell(script, timeoutMs);
    return typeof result === 'string' ? result : result?.stdout ?? '';
  }
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: timeoutMs, windowsHide: true,
  });
  return stdout;
}

function quoteForVbs(value) {
  return String(value).replace(/"/gu, '""').trim();
}

function asWiringFailure(error, code, message) {
  const failure = new ContractError(code, message);
  failure.cause = error;
  return failure;
}

/** The NNA installation descriptor lives at the install root; walk up from
 * the running CLI's location (the installed CLI nests it under installed/src). */
async function resolveIdentity() {
  const cliPath = process.argv[1] ? String(process.argv[1]) : '';
  if (!cliPath) throw new ContractError('nnd_install_descriptor_unavailable', 'NNA installation descriptor is unavailable; NND lifecycle requires an installed NNA');
  let directory = dirname(cliPath);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, 'install.json'))) return readNndServiceIdentity(await realpath(directory));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new ContractError('nnd_install_descriptor_unavailable', 'NNA installation descriptor is unavailable; NND lifecycle requires an installed NNA');
}

async function startService(identity) {
  const previous = await readNndServiceDiscovery(identity);
  if (previous) {
    try { return await requestNndController(previous, 'status'); }
    catch { /* dead owner: fall through to the verified-recovery takeover */ }
  }
  const child = spawn(identity.node, [identity.cli_path, 'nnd', 'service', 'run', identity.install_root], {
    cwd: identity.install_root, env: nativeEnvironment(identity), detached: true, windowsHide: true, stdio: 'ignore',
  });
  let failure = null;
  child.on('error', error => { failure = error; });
  child.on('exit', code => { if (!failure && code !== 0) failure = new Error(`supervisor exited with ${code}`); });
  child.unref();
  const deadline = Date.now() + 60000;
  for (;;) {
    if (failure) throw new ContractError('nnd_service_crashed', 'NND supervisor failed to start', { cause: failure });
    const record = await readNndServiceDiscovery(identity).catch(() => null);
    if (record) {
      try { return await requestNndController(record, 'status'); }
      catch (error) { if (Date.now() >= deadline) throw error; }
    }
    if (Date.now() >= deadline) throw new ContractError('nnd_start_timeout', 'NND startup did not publish its controller within the time bound');
    await delay(200);
  }
}
