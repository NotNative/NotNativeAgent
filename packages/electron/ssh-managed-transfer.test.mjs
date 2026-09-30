// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createManagedSshBundleUploader } from './ssh-managed-transfer.mjs';

function fakeChild(onEnd) {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.resume = () => {};
  child.stderr = new EventEmitter();
  child.stdin.end = (bytes) => onEnd(bytes, child);
  child.kill = () => { child.killed = true; };
  return child;
}

test('uploader streams archive bytes to a fixed tar command under a unique private directory', async () => {
  let invocation; let transmitted;
  const upload = createManagedSshBundleUploader({ platform: 'win32', spawnProcess: (...args) => {
    invocation = args;
    return fakeChild((bytes, child) => {
      transmitted = bytes;
      queueMicrotask(() => child.emit('close', 0, null));
    });
  } });
  const archive = Buffer.from([0, 1, 2, 255]);
  const result = await upload({ sshCommand: 'ssh -p 2222 deploy@host' }, archive, { id: '123e4567-e89b-42d3-a456-426614174000' });
  assert.equal(invocation[0], 'ssh.exe');
  assert.deepEqual(invocation[1].slice(0, 2), ['-p', '2222']);
  assert.ok(invocation[1].includes('ClearAllForwardings=yes'));
  assert.equal(invocation[1].at(-2), 'deploy@host');
  assert.ok(invocation[1].at(-1).includes('mkdir --'));
  assert.ok(invocation[1].at(-1).includes('tar -xzf -'));
  assert.equal(invocation[2].shell, false);
  assert.strictEqual(transmitted, archive);
  assert.match(result.remoteDirectory, /^~\/\.notnative-desktop\/managed\//);
});

test('uploader rejects malformed transfers before starting SSH', async () => {
  let spawned = false;
  const upload = createManagedSshBundleUploader({ spawnProcess: () => { spawned = true; throw new Error('unexpected'); } });
  await assert.rejects(upload({ sshCommand: 'ssh host' }, Buffer.alloc(0)), /archive-invalid/u);
  await assert.rejects(upload({ sshCommand: 'ssh host' }, Buffer.from('archive'), { id: '$(touch bad)' }), /transfer-id-invalid/u);
  await assert.rejects(upload({ sshCommand: 'ssh -o ProxyCommand=bad host' }, Buffer.from('archive')), /instance-invalid/u);
  await assert.rejects(upload({ sshCommand: 'ssh -L8000:host:80 host' }, Buffer.from('archive')), /instance-invalid/u);
  for (const option of [
    'ssh -o ForwardAgent=yes host',
    'ssh -oForwardX11=yes host',
    'ssh -o "ClearAllForwardings no" host',
    'ssh -o LocalForward=8000:127.0.0.1:80 host',
  ]) await assert.rejects(upload({ sshCommand: option }, Buffer.from('archive')), /forwarding-options-unsupported/u, option);
  assert.equal(spawned, false);
});

test('uploader reports remote tar failures and kills on broken input pipes', async () => {
  const uploadFailure = createManagedSshBundleUploader({ spawnProcess: () => fakeChild((_bytes, child) => queueMicrotask(() => child.emit('close', 2, null))) });
  await assert.rejects(uploadFailure({ sshCommand: 'ssh host' }, Buffer.from('archive')), /transfer-failed-2/u);

  let child;
  const streamFailure = createManagedSshBundleUploader({ spawnProcess: () => {
    child = fakeChild((_bytes, process) => queueMicrotask(() => process.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))));
    return child;
  } });
  await assert.rejects(streamFailure({ sshCommand: 'ssh host' }, Buffer.from('archive')), /stream-failed/u);
  assert.equal(child.killed, true);
});
