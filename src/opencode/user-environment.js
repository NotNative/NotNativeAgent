// SPDX-License-Identifier: Apache-2.0
import { promisify } from 'node:util';
import { execFile as execFileCallback } from 'node:child_process';
import { ContractError } from '../ids.js';

const execFile = promisify(execFileCallback);
const POWERSHELL_TIMEOUT_MS = 20_000;
const POWERSHELL_WRITE_TIMEOUT_MS = 120_000;
const USER_ENVIRONMENT_MUTEX_WAIT_MS = 30_000;
const USER_ENVIRONMENT_NAMES = [
  'OPENCODE_SKIP_START', 'OPENCODE_HOST', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME',
];

export async function applyUserEnvironment(config, scope, bindUrl, defaultUsername) {
  const pairs = [
    ['OPENCODE_SKIP_START', 'true'], ['OPENCODE_HOST', bindUrl(config)],
    ['OPENCODE_SERVER_PASSWORD', config.password],
    ...(config.username === defaultUsername ? [['OPENCODE_SERVER_USERNAME', null]] : [['OPENCODE_SERVER_USERNAME', config.username]]),
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
    throw wiringFailure(error, 'opencode_user_environment_failed', 'the OpenChamber user environment could not be updated');
  }
}

export async function clearUserEnvironment(config, scope, bindUrl, defaultUsername) {
  try {
    const expected = {
      OPENCODE_SKIP_START: 'true', OPENCODE_HOST: bindUrl(config),
      OPENCODE_SERVER_PASSWORD: config.password,
      OPENCODE_SERVER_USERNAME: config.username === defaultUsername ? '' : config.username,
    };
    if (!config.password) return preserved();
    if (!scope.userEnvironmentRead && !scope.userEnvironmentWrite) {
      const result = await clearOwnedUserEnvironment(expected, scope);
      return result === 'cleared'
        ? { supported: true, written: [], removed: [...USER_ENVIRONMENT_NAMES], preserved: false }
        : preserved();
    }
    const observed = await observedUserScopeValues(scope);
    if (observed === null || USER_ENVIRONMENT_NAMES.some((name) =>
      (typeof observed[name] === 'string' ? observed[name] : '') !== expected[name])) return preserved();
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

function pendingUserScopeWrite(observed, [name, value]) {
  if (observed === null) return true;
  const current = typeof observed[name] === 'string' ? observed[name] : '';
  return value === null ? current.length > 0 : current !== value;
}

async function writeUserEnvironment(removals, scope) {
  const writes = Object.entries(removals ?? {})
    .map(([name, value]) => `  [Environment]::SetEnvironmentVariable('${escapeSingle(name)}', ${value === null ? '$null' : `'${escapeSingle(value)}'`}, 'User')`)
    .join('\n');
  await runPowershell(withUserEnvironmentMutex(writes), scope, POWERSHELL_WRITE_TIMEOUT_MS);
}

async function clearOwnedUserEnvironment(expected, scope) {
  const pairs = Object.entries(expected).map(([name, value]) => `$Expected['${escapeSingle(name)}'] = '${escapeSingle(value)}'`).join('\n');
  const names = USER_ENVIRONMENT_NAMES.map((name) => `'${escapeSingle(name)}'`).join(', ');
  const body = [
    '$Expected = @{}', pairs, `$Names = @(${names})`, '$Matches = $true',
    'foreach ($Name in $Names) {', "  $Current = [Environment]::GetEnvironmentVariable($Name, 'User')",
    "  if ($null -eq $Current) { $Current = '' }", '  if ($Current -cne $Expected[$Name]) { $Matches = $false }', '}',
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
