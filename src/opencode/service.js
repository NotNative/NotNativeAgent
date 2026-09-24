// SPDX-License-Identifier: Apache-2.0
// OpenCode lifecycle service: verified detached runtime plus optional
// Windows login auto-start. Runtime start and stop own OpenChamber variables.
// Why: this module deliberately parallels gateway-cli.js with version-2 pid
// records only; the gateway's legacy adoption path predates process identity
// and has no equivalent here.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ContractError } from '../ids.js';
import { SessionLock } from '../persistence/session-lock.js';
import { persistAtomicJson } from '../persistence/atomic-json.js';
import { ProcessIdentity, validIdentity } from '../reliability/process-identity.js';
import { loadOpenCodeConfig, openCodeConfigExists, opencodePublicStatus, saveOpenCodeConfig, bindUrl, generateOpencodePassword } from './config.js';

const STARTUP_SCRIPT_NAME = 'NotNativeAgent-OpenCode.vbs';
const USER_ENVIRONMENT_NAMES = [
  'OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME',
];
const DEFAULT_BASIC_USERNAME = 'opencode';
const OPENCODE_CONSOLE_LOG_FILE = 'opencode-console.log';
const POWERSHELL_TIMEOUT_MS = 20_000;
// Why: each user-scope value write broadcasts WM_SETTINGCHANGE to top-level
// windows, which a desktop with stalled handlers delays by seconds and
// measured linearly (~7.4s per name), so a four-name wiring set exceeds the
// read and probe budget; writes are idempotent, so a generous budget can only
// slow a failing run, never falsify its outcome.
const POWERSHELL_WRITE_TIMEOUT_MS = 120_000;

export async function enableOpencodeService(options, paths, scope = {}) {
  assertWindowsWiring(scope);
  const prior = await loadOpenCodeConfig(paths.opencodeConfig);
  const priorExisted = await openCodeConfigExists(paths.opencodeConfig);
  const saved = await saveOpenCodeConfig(paths.opencodeConfig, {
    ...prior,
    enabled: true,
    hostname: options.serveHostname ?? prior.hostname,
    port: options.servePort ?? prior.port,
    password: prior.password ?? generateOpencodePassword(),
    updated_at: new Date().toISOString(),
  });
  let login;
  try {
    login = await installLoginStartup(saved, paths, scope);
  } catch (error) {
    // Why: enable owns only the login wiring. A failed install must not leave
    // an auto-start record behind, but it must not alter a running surface's
    // environment; start and stop own that independent lifecycle.
    await removeLoginStartup(scope).catch(() => undefined);
    await restoreOpenCodeConfig(paths.opencodeConfig, prior, priorExisted).catch(() => undefined);
    throw error;
  }
  const runtime = await opencodeRuntimeStatus(paths, scope);
  // Why: the generated credential stays in restricted configuration and never enters command output.
  return { config: opencodePublicStatus(saved, scope.environment ?? process.env), login, runtime };
}

async function restoreOpenCodeConfig(path, prior, priorExisted) {
  if (priorExisted) {
    await saveOpenCodeConfig(path, prior);
    return;
  }
  // Why: a first enable has no prior record, so the revert is a removal; the
  // enabled flag must not outlive the wiring that never landed.
  await unlink(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function disableOpencodeService(options, paths, scope = {}) {
  assertWindowsWiring(scope);
  const config = await loadOpenCodeConfig(paths.opencodeConfig);
  const saved = await saveOpenCodeConfig(paths.opencodeConfig, { ...config, enabled: false, updated_at: new Date().toISOString() });
  const login = await removeLoginStartup(scope);
  const runtime = await opencodeRuntimeStatus(paths, scope);
  return { config: opencodePublicStatus(saved, scope.environment ?? process.env), login, runtime };
}

export async function opencodeServiceStatus(options, paths, scope = {}) {
  const config = await loadOpenCodeConfig(paths.opencodeConfig);
  const runtime = await opencodeRuntimeStatus(paths, scope);
  const environment = await observeUserEnvironment(scope);
  return {
    // Why: the public status composes the same redacted, environment-aware
    // credential view as a standalone `opencode status` instead of a second
    // private shape that can drift from the redaction rules.
    service: opencodePublicStatus(config, scope.environment ?? process.env),
    runtime,
    login: await loginWiringStatus(scope),
    environment,
    // Why: auto-start changes cannot rebind an active surface; expose the
    // divergence so the operator can stop and start it deliberately.
    stale_binding: staleOpencodeBinding(config, runtime, environment),
  };
}

function staleOpencodeBinding(config, runtime, environment) {
  if (!runtime.running) return false;
  if (typeof runtime.url === 'string' && runtime.url !== bindUrl(config)) return true;
  return environment.supported === true && environment.host !== bindUrl(config);
}

export async function startOpencodeService(options, paths, scope = {}) {
  const config = await ensureServiceConfiguration(options, paths);
  requireServiceRuntime(config);
  const startLock = new SessionLock(paths.opencode, 'opencode-start');
  try {
    await startLock.acquire();
  } catch (error) {
    if (error?.code !== 'session_locked') throw error;
    return { started: false, reason: 'already_starting', runtime: await opencodeRuntimeStatus(paths, scope) };
  }
  try {
    const status = await opencodeRuntimeStatus(paths, scope);
    if (status.running) return {
      started: false, reason: 'already_running', runtime: status,
      ...(await applyRuntimeEnvironment(config, scope)),
    };
    if (status.stale) await preserveStaleRuntimePid(paths);
    const started = await spawnDetachedOpencodeServe(config, paths, scope);
    try {
      return { ...started, ...(await applyRuntimeEnvironment(config, scope)) };
    } catch (error) {
      await stopManagedRuntime(paths, scope).catch(() => undefined);
      throw error;
    }
  } finally {
    await startLock.release();
  }
}

export async function stopOpencodeService(options, paths, scope = {}) {
  const stopped = await stopManagedRuntime(paths, scope);
  return { ...stopped, ...(await clearRuntimeEnvironment(scope)) };
}

async function stopManagedRuntime(paths, scope = {}) {
  const status = await opencodeRuntimeStatus(paths, scope);
  if (!status.running) return { stopped: false, reason: 'not_running' };
  if (!status.verified) throw new ContractError('opencode_identity_unverifiable', 'opencode serve process identity could not be verified');
  try {
    (scope.kill ?? process.kill)(status.pid, 'SIGTERM');
  } catch (error) {
    // Why: ESRCH between the identity comparison and the signal means the
    // verified instance already exited on its own; the stop still holds.
    if (error.code !== 'ESRCH') throw error;
  }
  // Why: on Windows process.kill terminates instead of delivering SIGTERM, so
  // the child's own pid-file removal never runs; the stopper removes the
  // record it verified rather than leaving a stale pid file behind.
  await removeRuntimePid(paths);
  return { stopped: true, pid: status.pid };
}

async function ensureServiceConfiguration(options, paths) {
  const config = await loadOpenCodeConfig(paths.opencodeConfig);
  const updated = {
    ...config,
    hostname: options.serveHostname ?? config.hostname,
    port: options.servePort ?? config.port,
    password: config.password ?? generateOpencodePassword(),
  };
  if (updated.hostname === config.hostname && updated.port === config.port && updated.password === config.password) return config;
  return saveOpenCodeConfig(paths.opencodeConfig, { ...updated, updated_at: new Date().toISOString() });
}

export async function opencodeRuntimeStatus(paths, scope = {}) {
  let record;
  try { record = parsePidRecord(await readFile(pidPath(paths), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { running: false }; throw error; }
  if (!record) return { running: false, stale: true };
  const identity = scope.processIdentity ?? new ProcessIdentity();
  const meta = recordMeta(record);
  if (!validIdentity(record.process_identity)) {
    return identity.live(record.pid) ? { running: true, verified: false, pid: record.pid, legacy: true, ...meta }
      : { running: false, stale: true, pid: record.pid };
  }
  const comparison = await identity.compare(record.process_identity);
  if (comparison === 'same') return { running: true, verified: true, pid: record.pid, ...meta };
  if (comparison === 'unknown') return { running: true, verified: false, pid: record.pid, ...meta };
  return { running: false, stale: true, pid: record.pid, reason: comparison };
}

export async function writeRuntimePid(paths, pid, record, scope = {}) {
  const identity = scope.processIdentity ?? new ProcessIdentity();
  const captured = await identity.capture(pid);
  if (captured === null) {
    // Why: a pid that vanished before capture is a managed child that exited
    // during startup, most commonly a port already in use; report that
    // outcome instead of masking it behind an unavailable probe.
    throw new ContractError('opencode_start_failed', 'opencode serve process exited before its start identity could be recorded');
  }
  if (!captured.start_id) throw new ContractError('opencode_identity_unavailable', 'opencode serve process identity unavailable');
  await persistAtomicJson(pidPath(paths), { version: 2, pid, process_identity: captured, ...record });
}

async function preserveStaleRuntimePid(paths) {
  await rename(pidPath(paths), `${pidPath(paths)}.stale.${Date.now()}.${randomUUID()}`).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function removeRuntimePid(paths) {
  await unlink(pidPath(paths)).catch(() => undefined);
}

function parsePidRecord(text) {
  try {
    const value = JSON.parse(text);
    return value?.version === 2 && Number.isSafeInteger(value.pid) && value.pid > 0 ? value : null;
  } catch {
    return null;
  }
}

function recordMeta(record) {
  return {
    ...(Number.isSafeInteger(record.port) ? { port: record.port } : {}),
    ...(typeof record.url === 'string' && record.url ? { url: record.url } : {}),
  };
}

function pidPath(paths) {
  return join(paths.opencode, 'opencode.pid');
}

async function spawnDetachedOpencodeServe(config, paths, scope = {}) {
  const log = await open(join(paths.logs, OPENCODE_CONSOLE_LOG_FILE), 'a');
  const child = (scope.spawnProcess ?? spawn)(process.execPath, ['--disable-warning=ExperimentalWarning', process.argv[1], 'opencode', 'run'], {
    detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, NNA_HOME: paths.root },
  });
  const url = bindUrl(config);
  try {
    await childStarted(child);
    await writeRuntimePid(paths, child.pid, { port: config.port, url }, scope);
  } catch (error) {
    child.kill?.();
    throw error;
  } finally {
    await log.close();
  }
  child.unref();
  return { started: true, pid: child.pid, port: config.port, url };
}

function childStarted(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { child.removeListener('spawn', started); child.removeListener('error', failed); };
    const started = () => {
      cleanup();
      if (Number.isSafeInteger(child.pid) && child.pid > 0) resolve();
      else reject(new ContractError('opencode_start_failed', 'opencode serve process did not provide a pid'));
    };
    const failed = () => {
      cleanup();
      reject(new ContractError('opencode_start_failed', 'opencode serve process could not start'));
    };
    child.once('spawn', started);
    child.once('error', failed);
  });
}

export function requireServiceRuntime(config) {
  // Why: the managed runtime runs unattended on a fixed loopback port, so an
  // unauthenticated bind would present an open operator surface. Start and
  // enable both provision credentials; the worker never runs without one.
  if (!config.password) throw new ContractError('opencode_service_unauthenticated', 'the opencode wiring service requires Basic auth credentials');
}

// --- Windows login and environment wiring -----------------------------------

function assertWindowsWiring(scope) {
  if ((scope.platform ?? process.platform) !== 'win32') {
    throw new ContractError('opencode_login_wiring_unsupported', 'opencode login wiring and OpenChamber environment installation are Windows-only');
  }
}

async function installLoginStartup(config, paths, scope = {}) {
  const startupFolder = await resolveStartupFolder(scope);
  const scriptPath = join(startupFolder, STARTUP_SCRIPT_NAME);
  const script = [
    "' SPDX-License-Identifier: Apache-2.0",
    "' NotNativeAgent OpenCode surface: start the managed serve runtime at login.",
    'Dim shell',
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Environment("PROCESS")("NNA_HOME") = "${quoteForVbs(paths.root)}"`,
    `shell.Run """${quoteForVbs(scope.nodePath ?? process.execPath)}"" `
      // Why: the Startup script runs with an arbitrary working directory, so
      // the CLI path must be absolute to resolve at login time.
      + `--disable-warning=ExperimentalWarning ""${quoteForVbs(resolve(scope.cliPath ?? process.argv[1]))}"" opencode start", 0, False`,
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
  const remove = scope.fileRemove ?? ((target) => unlink(target).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  }));
  await remove(scriptPath);
  return { supported: true, installed: false, script_path: scriptPath };
}

async function resolveStartupFolder(scope = {}) {
  try {
    const folder = scope.startupFolder
      ? String(await scope.startupFolder())
      : (await runPowershell("[Environment]::GetFolderPath('Startup')", scope)).trim();
    if (!folder) throw new ContractError('opencode_startup_folder_empty', 'the Windows Startup folder path was empty');
    return folder;
  } catch (error) {
    throw asWiringFailure(error, 'opencode_startup_folder_unavailable', 'the Windows Startup folder could not be resolved');
  }
}

function quoteForVbs(value) {
  return String(value).replace(/"/gu, '""').trim();
}

async function applyUserEnvironment(config, scope = {}) {
  const pairs = [
    ['OPENCODE_SKIP_START', 'true'],
    ['OPENCODE_HOST', bindUrl(config)],
    ['OPENCODE_SERVER_PASSWORD', config.password],
    // Why: the default username leaves no value behind, but a username from an
    // earlier custom identity must still be cleared on install; a stale
    // OPENCODE_SERVER_USERNAME would otherwise fail OpenChamber's Basic auth
    // against this surface with no local hint of the cause.
    ...(config.username === DEFAULT_BASIC_USERNAME
      ? [['OPENCODE_SERVER_USERNAME', null]]
      : [['OPENCODE_SERVER_USERNAME', config.username]]),
  ];
  const observed = await observedUserScopeValues(scope);
  const pending = pairs.filter((pair) => pendingUserScopeWrite(observed, pair));
  try {
    if (pending.length > 0) {
      const write = scope.userEnvironmentWrite ?? writeUserEnvironment;
      await write(Object.fromEntries(pending), scope);
    }
    return {
      supported: true,
      written: pending.filter((pair) => pair[1] !== null).map(([name]) => name),
      removed: pending.filter((pair) => pair[1] === null).map(([name]) => name),
      unchanged: pairs.filter((pair) => !pending.includes(pair)).map(([name]) => name),
    };
  } catch (error) {
    throw asWiringFailure(error, 'opencode_user_environment_failed', 'the OpenChamber user environment could not be updated');
  }
}

async function applyRuntimeEnvironment(config, scope = {}) {
  if ((scope.platform ?? process.platform) !== 'win32') return { environment: { supported: false } };
  return { environment: await applyUserEnvironment(config, scope) };
}

// Why: every user-scope write broadcasts WM_SETTINGCHANGE to top-level
// windows before returning, and a desktop with stalled handlers delays each
// call by seconds (measured near-linear at ~7.4s per name); reading first and
// transmitting only names whose value differs keeps a steady-state re-enable
// well inside any budget. A failed read degrades to a full wiring set because
// the desired values land safely whether or not they were already present.
async function observedUserScopeValues(scope = {}) {
  const read = scope.userEnvironmentRead ?? readUserEnvironment;
  try {
    return await read(USER_ENVIRONMENT_NAMES, scope);
  } catch {
    return null;
  }
}

function pendingUserScopeWrite(observed, pair) {
  if (observed === null) return true;
  const [name, value] = pair;
  const current = typeof observed[name] === 'string' ? observed[name] : '';
  if (value === null) return current.length > 0;
  return current !== value;
}

async function clearUserEnvironment(scope = {}) {
  try {
    // Why: stop owns all four names. Read first to avoid needless broadcasts;
    // an unavailable read safely degrades to clearing the full set.
    const observed = await observedUserScopeValues(scope);
    const pairs = USER_ENVIRONMENT_NAMES.map((name) => [name, null]);
    const pending = observed === null ? pairs : pairs.filter((pair) => pendingUserScopeWrite(observed, pair));
    if (pending.length > 0) {
      const write = scope.userEnvironmentWrite ?? writeUserEnvironment;
      await write(Object.fromEntries(pending), scope);
    }
    return { supported: true, written: [], removed: [...USER_ENVIRONMENT_NAMES] };
  } catch (error) {
    throw asWiringFailure(error, 'opencode_user_environment_failed', 'the OpenChamber user environment could not be cleared');
  }
}

async function clearRuntimeEnvironment(scope = {}) {
  if ((scope.platform ?? process.platform) !== 'win32') return { environment: { supported: false } };
  return { environment: await clearUserEnvironment(scope) };
}

async function loginWiringStatus(scope = {}) {
  if ((scope.platform ?? process.platform) !== 'win32') {
    return { supported: false, installed: null, script_path: null };
  }
  try {
    const startupFolder = await resolveStartupFolder(scope);
    const scriptPath = join(startupFolder, STARTUP_SCRIPT_NAME);
    const read = scope.fileReader ?? (async (target) => {
      try { await readFile(target); return true; } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    });
    const installed = await read(scriptPath) === true;
    return { supported: true, installed, script_path: scriptPath };
  } catch (error) {
    const failure = asWiringFailure(error, 'opencode_login_wiring_probe_failed', 'the opencode login wiring could not be inspected');
    return { supported: true, installed: null, script_path: null, error: failure.code };
  }
}

async function observeUserEnvironment(scope = {}) {
  if ((scope.platform ?? process.platform) !== 'win32') {
    return { supported: false, skip_start: null, host: null, password_present: null, username: null };
  }
  try {
    const read = scope.userEnvironmentRead ?? readUserEnvironment;
    const observed = await read(USER_ENVIRONMENT_NAMES, scope);
    const present = (name) => (typeof observed[name] === 'string' && observed[name].length > 0 ? observed[name] : null);
    return {
      supported: true,
      skip_start: present('OPENCODE_SKIP_START'),
      host: present('OPENCODE_HOST'),
      // Why: presence only; the password never re-enters command output.
      password_present: present('OPENCODE_SERVER_PASSWORD') !== null,
      username: present('OPENCODE_SERVER_USERNAME'),
    };
  } catch (error) {
    const failure = asWiringFailure(error, 'opencode_user_environment_probe_failed', 'the OpenChamber user environment could not be inspected');
    return {
      supported: true, skip_start: null, host: null, password_present: null, username: null, error: failure.code,
    };
  }
}

async function writeUserEnvironment(removals, scope = {}) {
  const script = Object.entries(removals ?? {})
    .map(([name, value]) => `  [Environment]::SetEnvironmentVariable('${escapeSingle(name)}', ${value === null ? '$null' : `'${escapeSingle(value)}'`}, 'User')`)
    .join('\n');
  await runPowershell(script, scope, POWERSHELL_WRITE_TIMEOUT_MS);
}

async function readUserEnvironment(names, scope = {}) {
  // Why: redirected Windows PowerShell stdout is encoded in the console code
  // page, so an observed non-ASCII credential (normalizeUsername accepts one)
  // rounds back as replacement characters, diverges from the desired value on
  // every enable, and the delta optimization re-broadcasts it forever; the
  // read latches the console to UTF-8 before emitting values.
  const latch = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;';
  const script = `${latch}\n${(names ?? []).map((name) => `Write-Output ('${escapeSingle(name)}=' + [Environment]::GetEnvironmentVariable('${escapeSingle(name)}', 'User'))`).join('\n')}`;
  const stdout = (await runPowershell(script, scope)).replace(/^\uFEFF/u, '');
  const observed = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    observed[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return observed;
}

async function runPowershell(script, scope = {}, timeoutMs = POWERSHELL_TIMEOUT_MS) {
  if (scope.powershell) {
    const result = await scope.powershell(script, timeoutMs);
    return typeof result === 'string' ? result : result?.stdout ?? '';
  }
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: timeoutMs, windowsHide: true,
  });
  return stdout;
}

function escapeSingle(value) {
  return String(value).replace(/'/gu, "''");
}

function asWiringFailure(error, code, message) {
  const failure = new ContractError(code, message);
  failure.cause = error;
  return failure;
}
