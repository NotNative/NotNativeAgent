// SPDX-License-Identifier: Apache-2.0

import { ContractError } from '../ids.js';
import { detachedProcessInvocation, longRunningForegroundInvocation } from './process-lifecycle.js';
import { shellLaunchesExternalBrowser } from './external-browser.js';

const HOSTS = Object.freeze({
  win32: Object.freeze({
    platform: 'win32', os: 'Windows', nativeShell: 'powershell',
    shellName: 'Windows PowerShell 5.1', executable: 'powershell.exe', syntax: 'PowerShell',
  }),
  darwin: Object.freeze({
    platform: 'darwin', os: 'macOS', nativeShell: 'sh',
    shellName: 'POSIX sh', executable: 'sh', syntax: 'POSIX shell',
  }),
  linux: Object.freeze({
    platform: 'linux', os: 'Linux', nativeShell: 'sh',
    shellName: 'POSIX sh', executable: 'sh', syntax: 'POSIX shell',
  }),
});

export function hostEnvironment(platform = process.platform) {
  return HOSTS[platform] ?? Object.freeze({
    platform, os: platform, nativeShell: 'sh', shellName: 'POSIX sh', executable: 'sh', syntax: 'POSIX shell',
  });
}

export function hostEnvironmentInstruction(platform = process.platform) {
  const host = hostEnvironment(platform);
  const dialectWarning = platform === 'win32'
    ? 'Do not use POSIX constructs such as for...do, $(...), wc, head, grep, or POSIX absolute paths such as /tmp unless a POSIX interpreter has been positively discovered.'
    : 'Do not use PowerShell cmdlets, variables, pipelines, or escaping unless PowerShell has been positively discovered.';
  return `Authoritative host environment: operating system ${host.os} (${host.platform}); shell.run with shell auto uses ${host.shellName} (${host.executable}) and requires ${host.syntax} syntax. Shell syntax is not portable and NNA does not translate scripts between interpreters. ${dialectWarning}`;
}

export function shellToolGuidance(platform = process.platform) {
  const host = hostEnvironment(platform);
  return `This host is ${host.os} (${host.platform}); shell auto resolves to ${host.shellName} (${host.executable}) and the script must use ${host.syntax} syntax. Prefer auto. Request another interpreter only after it has been positively discovered on this host; NNA does not translate shell syntax.`;
}

export function unavailableShellMessage(shell, platform = process.platform) {
  const host = hostEnvironment(platform);
  const fallback = shell === host.nativeShell
    ? `The native interpreter ${host.executable} is missing or unavailable on PATH; diagnose the host installation before retrying.`
    : `Use shell auto with ${host.syntax} syntax, or use process.run or a structured NNA tool. Do not repeat shell ${shell} unless that interpreter is positively discovered.`;
  return `The requested shell interpreter ${shell} is unavailable on this ${host.os} (${host.platform}) host. ${fallback}`;
}

export function normalizeShellExecutionError(error, shell, platform = process.platform) {
  if (error?.code !== 'ENOENT') return error;
  return new ContractError('shell_interpreter_unavailable', unavailableShellMessage(shell, platform), { cause: error });
}

export function shellReliabilitySignals(script, shell = 'auto') {
  const signals = [];
  const separators = script.match(/(?:&&|\|\||[;|\n])/gu)?.length ?? 0;
  if (separators >= 3) signals.push('many_operations');
  if (/\b(?:for|foreach|while)\b/iu.test(script) && /\$\(|`[^`]+`/u.test(script)) signals.push('loop_with_substitution');
  if ((script.match(/["']/gu)?.length ?? 0) >= 8 && /\$\(|`|\\["']/u.test(script)) signals.push('nested_quoting');
  if (/\b(?:do|done|then|fi)\b/iu.test(script) && /\b(?:Get-|Set-|Write-|Select-|ForEach-Object)\w*/iu.test(script)) signals.push('mixed_shell_dialects');
  if (detachedProcessInvocation(script, shell)) signals.push('detached_process');
  else if (longRunningForegroundInvocation(script)) signals.push('long_running_foreground');
  if (shellLaunchesExternalBrowser(script)) signals.push('external_browser');
  return Object.freeze(signals);
}
