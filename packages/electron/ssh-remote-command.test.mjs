// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSshRemoteCommandRunner, shellQuote } from './ssh-remote-command.mjs';

function fakeChild(onScript) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = (script) => onScript(script, child);
  child.kill = () => { child.killed = true; };
  return child;
}

test('remote runner invokes only parsed destination and a fixed shell command, sending script on stdin', async () => {
  let invoked; let received;
  const run = createSshRemoteCommandRunner({ platform: 'win32', spawnProcess: (...args) => {
    invoked = args;
    return fakeChild((script, child) => {
      received = script;
      queueMicrotask(() => {
        child.emit('exit', 0, null);
        child.stdout.emit('data', Buffer.from('remote-output'));
        child.emit('close', 0, null);
      });
    });
  } });
  const result = await run({ sshCommand: 'ssh -p 2222 deploy@remote.example' }, 'printf safe');
  assert.deepEqual(invoked.slice(0, 2), ['ssh.exe', [
    '-p', '2222', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
    '-o', 'StdinNull=no', '-o', 'SessionType=default',
    '-T', 'deploy@remote.example', 'sh -s',
  ]]);
  assert.equal(invoked[2].shell, false);
  assert.equal(received, 'printf safe');
  assert.equal(result.stdout, 'remote-output');
  assert.equal(result.code, 0);
});

test('runner rejects unsafe SSH configurations, oversized scripts, and shell values with line breaks', async () => {
  let spawned = false;
  const run = createSshRemoteCommandRunner({ spawnProcess: () => { spawned = true; throw new Error('must not spawn'); } });
  await assert.rejects(run({ sshCommand: 'ssh -o ProxyCommand=bad host' }, 'true'), /instance-invalid/u);
  await assert.rejects(run({ sshCommand: 'ssh -o StdinNull=yes host' }, 'true'), /instance-invalid/u);
  await assert.rejects(run({ sshCommand: 'ssh -o SessionType=none host' }, 'true'), /instance-invalid/u);
  await assert.rejects(run({ sshCommand: 'ssh -o ForwardAgent=yes host' }, 'true'), /forwarding-options-unsupported/u);
  await assert.rejects(run({ sshCommand: 'ssh -A host' }, 'true'), /forwarding-options-unsupported/u);
  await assert.rejects(run({ sshCommand: 'ssh host' }, 'x'.repeat(256 * 1024 + 1)), /too-large/u);
  assert.equal(spawned, false);
  assert.throws(() => shellQuote('secret\ncommand'), /invalid/u);
  assert.equal(shellQuote("it's safe"), "'it'\\''s safe'");
});

test('runner handles asynchronous stdin EPIPE without an unhandled child stream error', async () => {
  let child;
  const run = createSshRemoteCommandRunner({ spawnProcess: () => {
    child = fakeChild((_script, process) => queueMicrotask(() => {
      process.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
      process.emit('close', 255, null);
    }));
    return child;
  } });
  await assert.rejects(run({ sshCommand: 'ssh host' }, 'printf payload'), /script-send-failed/u);
  assert.equal(child.killed, true);
});

test('runner kills the remote command when output exceeds its cap', async () => {
  let child;
  const run = createSshRemoteCommandRunner({ spawnProcess: () => {
    child = fakeChild((_script, process) => queueMicrotask(() => process.stdout.emit('data', Buffer.alloc(512 * 1024 + 1))));
    return child;
  } });
  await assert.rejects(run({ sshCommand: 'ssh host' }, 'true'), /output-too-large/u);
  assert.equal(child.killed, true);
});
