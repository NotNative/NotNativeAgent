// SPDX-License-Identifier: Apache-2.0
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { ContractError } from '../ids.js';
import { openchamberEnvironment } from './openchamber.js';

const execFile = promisify(execFileCallback);
const POWERSHELL_TIMEOUT_MS = 20_000;
const POWERSHELL_WRITE_TIMEOUT_MS = 120_000;
const USER_ENVIRONMENT_MUTEX_WAIT_MS = 30_000;
const USER_ENVIRONMENT_NAMES = [
  'OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME',
];

/** The user-scope values a binding NNA owns may carry.
 *
 *  Why two accepted username forms: early builds (and the manual wiring that
 *  preceded `enable` writing anything) recorded the default username literally
 *  as `opencode`, while the current minimal form omits it. A stop must clear
 *  both, or the whole set is treated as foreign and the operator is left with
 *  a binding that points OpenChamber at a dead server. */
function ownedValues(config, bindUrl, defaultUsername) {
  return {
    OPENCODE_SKIP_START: ['true'],
    OPENCODE_HOST: [bindUrl(config)],
    OPENCODE_SERVER_PASSWORD: [config.password],
    OPENCODE_SERVER_USERNAME: config.username === defaultUsername ? ['', defaultUsername] : [config.username],
  };
}

export async function clearUserEnvironment(config, scope, bindUrl, defaultUsername) {
  try {
    if (!config.password) return preserved();
    const owned = ownedValues(config, bindUrl, defaultUsername);
    if (!scope.userEnvironmentRead && !scope.userEnvironmentWrite) {
      const result = await clearOwnedUserEnvironment(owned, scope);
      return result === 'cleared'
        ? { supported: true, written: [], removed: [...USER_ENVIRONMENT_NAMES], preserved: false }
        : preserved();
    }
    const observed = await observedUserScopeValues(scope);
    if (observed === null || USER_ENVIRONMENT_NAMES.some((name) =>
      !owned[name].includes(typeof observed[name] === 'string' ? observed[name] : ''))) return preserved();
    const write = scope.userEnvironmentWrite ?? writeUserEnvironment;
    await write(Object.fromEntries(USER_ENVIRONMENT_NAMES.map((name) => [name, null])), scope);
    return { supported: true, written: [], removed: [...USER_ENVIRONMENT_NAMES], preserved: false };
  } catch (error) {
    throw wiringFailure(error, 'opencode_user_environment_failed', 'the OpenChamber user environment could not be cleared');
  }
}

export async function observeUserEnvironment(scope) {
  if ((scope.platform ?? process.platform) !== 'win32') {
    return { supported: false, skip_start: null, host: null, password_present: null, username: null };
  }
  try {
    const read = scope.userEnvironmentRead ?? readUserEnvironment;
    const observed = await read(USER_ENVIRONMENT_NAMES, scope);
    const present = (name) => (typeof observed[name] === 'string' && observed[name].length > 0 ? observed[name] : null);
    return { supported: true, skip_start: present('OPENCODE_SKIP_START'), host: present('OPENCODE_HOST'),
      password_present: present('OPENCODE_SERVER_PASSWORD') !== null, username: present('OPENCODE_SERVER_USERNAME') };
  } catch (error) {
    const failure = wiringFailure(error, 'opencode_user_environment_probe_failed', 'the OpenChamber user environment could not be inspected');
    return { supported: true, skip_start: null, host: null, password_present: null, username: null, error: failure.code };
  }
}

function preserved() {
  return { supported: true, written: [], removed: [], preserved: true, reason: 'ownership_unverified' };
}

async function observedUserScopeValues(scope) {
  const read = scope.userEnvironmentRead ?? readUserEnvironment;
  try { return await read(USER_ENVIRONMENT_NAMES, scope); } catch { return null; }
}

async function writeUserEnvironment(removals, scope) {
  const writes = Object.entries(removals ?? {})
    .map(([name, value]) => `  [Environment]::SetEnvironmentVariable('${escapeSingle(name)}', ${value === null ? '$null' : `'${escapeSingle(value)}'`}, 'User')`)
    .join('\n');
  await runPowershell(withUserEnvironmentMutex(writes), scope, POWERSHELL_WRITE_TIMEOUT_MS);
}

/** Apply the user-scope binding a running server owns.
 *
 *  Why a start-side write exists: the agreed lifecycle is start writes, stop
 *  clears. OpenChamber reads the user-scope `OPENCODE_*` variables at its own
 *  launch, hours after the server started, so a child-only binding cannot reach
 *  it — the variables must persist in the user profile while the server runs.
 *  The ownership invariant is preserved differently than on stop: the write is
 *  unconditional for a verified server start because `start` provisions the
 *  credential it writes, and `stop` clears the same names it can prove NNA
 *  owns. A hand-edited foreign value is overwritten by the server the operator
 *  just started, which is the operator's own act. */
export async function applyUserEnvironment(config, scope, bindUrl, defaultUsername) {
  if ((scope.platform ?? process.platform) !== 'win32') return { supported: false };
  try {
    if (!config.password) return { supported: true, written: [], reason: 'unauthenticated' };
    const binding = openchamberEnvironment(config, bindUrl(config));
    const values = { ...binding };
    // Why the minimal username stays absent: OpenChamber keeps its own default
    // unless the configuration names one, matching the child binding's shape.
    if (!values.OPENCODE_SERVER_USERNAME && config.username !== defaultUsername) {
      values.OPENCODE_SERVER_USERNAME = config.username;
    }
    const written = Object.keys(values);
    const write = scope.userEnvironmentWrite ?? writeUserEnvironment;
    await write(Object.fromEntries(written.map((name) => [name, values[name]])), scope);
    return { supported: true, written };
  } catch (error) {
    throw wiringFailure(error, 'opencode_user_environment_failed', 'the OpenChamber user environment could not be applied');
  }
}

async function clearOwnedUserEnvironment(owned, scope) {
  const pairs = Object.entries(owned).map(([name, accepted]) =>
    `$Accepted['${escapeSingle(name)}'] = @(${accepted.map((value) => `'${escapeSingle(value)}'`).join(', ')})`).join('\n');
  const names = USER_ENVIRONMENT_NAMES.map((name) => `'${escapeSingle(name)}'`).join(', ');
  const body = [
    '$Accepted = @{}', pairs, `$Names = @(${names})`, '$Matches = $true',
    'foreach ($Name in $Names) {', "  $Current = [Environment]::GetEnvironmentVariable($Name, 'User')",
    "  if ($null -eq $Current) { $Current = '' }",
    "  if ($Accepted[$Name] -cnotcontains $Current) { $Matches = $false }", '}',
    'if ($Matches) {', "  foreach ($Name in $Names) { [Environment]::SetEnvironmentVariable($Name, $null, 'User') }",
    "  Write-Output 'cleared'", "} else { Write-Output 'preserved' }",
  ].join('\n');
  const result = (await runPowershell(withUserEnvironmentMutex(body), scope, POWERSHELL_WRITE_TIMEOUT_MS)).trim();
  return result === 'cleared' ? 'cleared' : 'preserved';
}

function withUserEnvironmentMutex(body) {
  return [
    "$MutexName = 'Local\\NotNativeAgent-OpenCodeEnvironment-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    '$Mutex = [Threading.Mutex]::new($false, $MutexName)', '$Acquired = $false', 'try {',
    `  try { $Acquired = $Mutex.WaitOne(${USER_ENVIRONMENT_MUTEX_WAIT_MS}) }`,
    '  catch [Threading.AbandonedMutexException] { $Acquired = $true }',
    "  if (-not $Acquired) { throw 'Timed out waiting to update OpenCode user environment.' }", '  try {', body,
    '  } finally { $Mutex.ReleaseMutex() }', '} finally { $Mutex.Dispose() }',
  ].join('\n');
}

async function readUserEnvironment(names, scope) {
  const latch = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;';
  const script = `${latch}\n${(names ?? []).map((name) => `Write-Output ('${escapeSingle(name)}=' + [Environment]::GetEnvironmentVariable('${escapeSingle(name)}', 'User'))`).join('\n')}`;
  const stdout = (await runPowershell(script, scope)).replace(/^\uFEFF/u, '');
  const observed = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator > 0) observed[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return observed;
}

export async function runPowershell(script, scope = {}, timeoutMs = POWERSHELL_TIMEOUT_MS) {
  if (scope.powershell) {
    const result = await scope.powershell(script, timeoutMs);
    return typeof result === 'string' ? result : result?.stdout ?? '';
  }
  const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: timeoutMs, windowsHide: true });
  return stdout;
}

function wiringFailure(error, code, message) {
  if (error instanceof ContractError && error.code === code) return error;
  const failure = new ContractError(code, message);
  failure.cause = error;
  return failure;
}

function escapeSingle(value) { return String(value).replace(/'/gu, "''"); }
