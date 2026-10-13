// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedSshLifecycle } from './ssh-managed-lifecycle.mjs';

const instance = { id: 'instance-123', sshCommand: 'ssh deploy@host', remoteOpenchamber: { installMethod: 'auto' } };

test('managed lifecycle installs dependencies and starts a bounded loopback server', async () => {
  const scripts = [];
  const lifecycle = createManagedSshLifecycle({ runRemoteScript: async (_instance, script, options) => {
    scripts.push({ script, options });
    return { code: 0, stdout: 'NOTNATIVE_STARTED_PID=4242 PORT=57123\n', stderr: '' };
  } });
  assert.deepEqual(await lifecycle.installAndStart(instance, { transferId: 'transfer-123', port: 57123, version: '20260930.0.75' }), {
    transferId: 'transfer-123', pid: 4242, port: 57123,
  });
  assert.match(scripts[0].script, /bun install --production.*npm install/su);
  assert.match(scripts[0].script, /managed bundle is incomplete/u);
  assert.match(scripts[0].script, /Node\.js >=22\.18 is required/u);
  assert.match(scripts[0].script, /require\("node-pty"\)/u);
  assert.match(scripts[0].script, /NOTNATIVE_HOST=127\.0\.0\.1/u);
  assert.match(scripts[0].script, /NOTNATIVE_DIST_DIR="\$root\/web-dist"/u);
  assert.match(scripts[0].script, /nohup env NOTNATIVE_PORT=57123/u);
  assert.match(scripts[0].script, /managed-server\.tmp/u);
  assert.match(scripts[0].script, /20260930\.0\.75/u);
  assert.equal(scripts[0].options.timeoutMs, 10 * 60_000);
});

test('managed lifecycle supports configured installers and verifies the started server', async () => {
  const scripts = [];
  const lifecycle = createManagedSshLifecycle({ runRemoteScript: async (_instance, script) => {
    scripts.push(script);
    return { code: 0, stdout: 'not ready\n', stderr: '' };
  } });
  await assert.rejects(lifecycle.installAndStart({ ...instance, remoteOpenchamber: { installMethod: 'npm' } }, { transferId: 'transfer-123', port: 8080, version: '20260930.0.75' }), /start-unconfirmed/u);
  assert.match(scripts[0], /npm install --omit=dev/u);
  assert.doesNotMatch(scripts[0], /bun install/u);
});

test('managed lifecycle stops only the matching server command and validates identifiers', async () => {
  let script;
  const lifecycle = createManagedSshLifecycle({ runRemoteScript: async (_instance, value) => {
    script = value;
    return { code: 0, stdout: '', stderr: '' };
  } });
  await lifecycle.stop(instance, 'transfer-123');
  assert.match(script, /ps -ww -p "\$pid" -o args=/u);
  assert.match(script, /\*"\$root\/start-managed\.mjs"\*/u);
  assert.match(script, /while \[ "\$attempt" -lt 20 \]/u);
  assert.match(script, /kill -9 "\$pid"/u);
  assert.match(script, /pid=""/u);
  assert.match(script, /rm -rf -- "\$root"/u);
  assert.match(script, /managed-server/u);
  await assert.rejects(lifecycle.stop(instance, '$(id)'), /id-invalid/u);
  await assert.rejects(lifecycle.installAndStart(instance, { transferId: 'transfer-123', port: 0, version: '20260930.0.75' }), /port-invalid/u);
});

test('managed lifecycle queries per-instance remote ownership and version before reconnect', async () => {
  let script;
  const lifecycle = createManagedSshLifecycle({ runRemoteScript: async (_instance, value) => {
    script = value;
    return { code: 0, stdout: 'NOTNATIVE_EXISTING_PID=4242 PORT=57123 ID=transfer-123 VERSION=20260930.0.75\n', stderr: '' };
  } });
  assert.deepEqual(await lifecycle.findRunning(instance, '20260930.0.75'), { transferId: 'transfer-123', pid: 4242, port: 57123, version: '20260930.0.75', reused: true });
  assert.match(script, /data="\$HOME\/\.notnative-desktop\/data\/instance-123"/u);
  assert.match(script, /ps -ww -p "\$pid" -o args=/u);
});

test('managed lifecycle discovers legacy sessions without a version marker for orderly replacement', async () => {
  const lifecycle = createManagedSshLifecycle({ runRemoteScript: async () => ({
    code: 0, stdout: 'NOTNATIVE_EXISTING_PID=4242 PORT=57123 ID=transfer-123 VERSION=\n', stderr: '',
  }) });
  assert.deepEqual(await lifecycle.findRunning(instance, '20260930.0.76'), {
    transferId: 'transfer-123', pid: 4242, port: 57123, version: null, reused: true,
  });
});
