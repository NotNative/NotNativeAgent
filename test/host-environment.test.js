// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hostEnvironment, hostEnvironmentInstruction, normalizeShellExecutionError, shellReliabilitySignals,
  shellToolGuidance, unavailableShellMessage,
} from '../src/reliability/host-environment.js';

test('host environment facts are generated dynamically for every supported platform', () => {
  assert.deepEqual(hostEnvironment('win32'), {
    platform: 'win32', os: 'Windows', nativeShell: 'powershell',
    shellName: 'Windows PowerShell 5.1', executable: 'powershell.exe', syntax: 'PowerShell',
  });
  assert.deepEqual(hostEnvironment('linux'), {
    platform: 'linux', os: 'Linux', nativeShell: 'sh',
    shellName: 'POSIX sh', executable: 'sh', syntax: 'POSIX shell',
  });
  assert.deepEqual(hostEnvironment('darwin'), {
    platform: 'darwin', os: 'macOS', nativeShell: 'sh',
    shellName: 'POSIX sh', executable: 'sh', syntax: 'POSIX shell',
  });
  assert.match(hostEnvironmentInstruction('win32'), /Windows \(win32\).*Windows PowerShell 5\.1.*PowerShell syntax/u);
  assert.match(hostEnvironmentInstruction('linux'), /Linux \(linux\).*POSIX sh.*POSIX shell syntax/u);
  assert.match(hostEnvironmentInstruction('darwin'), /macOS \(darwin\).*POSIX sh.*POSIX shell syntax/u);
});

test('shell guidance names the active native dialect and gives precise unavailable-interpreter recovery', () => {
  assert.match(shellToolGuidance('win32'), /auto resolves to Windows PowerShell 5\.1/u);
  assert.match(shellToolGuidance('darwin'), /auto resolves to POSIX sh/u);
  assert.match(unavailableShellMessage('sh', 'win32'), /unavailable on this Windows.*Use shell auto with PowerShell syntax.*Do not repeat shell sh/u);
  assert.match(unavailableShellMessage('bash', 'linux'), /unavailable on this Linux.*Use shell auto with POSIX shell syntax.*Do not repeat shell bash/u);
  assert.match(unavailableShellMessage('powershell', 'win32'), /native interpreter powershell\.exe is missing or unavailable on PATH/u);
  const failure = normalizeShellExecutionError(Object.assign(new Error('spawn sh ENOENT'), { code: 'ENOENT' }), 'sh', 'win32');
  assert.equal(failure.code, 'shell_interpreter_unavailable');
  assert.match(failure.message, /Use shell auto with PowerShell syntax/u);
  const original = Object.assign(new Error('access denied'), { code: 'EACCES' });
  assert.equal(normalizeShellExecutionError(original, 'sh', 'win32'), original);
});

test('shell reliability signals identify fragile composition without rejecting script length', () => {
  const script = 'echo start; for f in a b; do printf "%s" "$(wc -l < "$f")"; done';
  assert.deepEqual(shellReliabilitySignals(script), ['many_operations', 'loop_with_substitution']);
  assert.deepEqual(shellReliabilitySignals('git status; npm test'), []);
  assert.deepEqual(shellReliabilitySignals(`Write-Output '${'x'.repeat(10_000)}'`), []);
});
