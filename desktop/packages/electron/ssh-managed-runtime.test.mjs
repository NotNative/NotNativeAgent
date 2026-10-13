// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createManagedSshRuntime } from './ssh-managed-runtime.mjs';

test('managed runtime builds, uploads, installs, and then stops the same attempt', async () => {
  const calls = [];
  const runtime = createManagedSshRuntime({
    getBundlePaths: () => ({ serverBundlePath: 'server', settingsRegistryPath: 'settings', webDistPath: 'web' }),
    createBundle: (paths) => { calls.push(['build', paths]); return Buffer.from('archive'); },
    uploadBundle: async (_instance, archive) => { calls.push(['upload', archive.toString()]); return { transferId: 'transfer-123' }; },
    runRemoteScript: async (_instance, script) => {
      calls.push(['script', script]);
      return { code: 0, stdout: 'NOTNATIVE_STARTED_PID=53 PORT=57123\n', stderr: '' };
    },
  });
  const instance = { id: 'instance-123', sshCommand: 'ssh host', remoteOpenchamber: { uploadBundleOverSsh: true, installMethod: 'npm', keepRunning: true } };
  const session = await runtime.start(instance, { port: 57123 });
  assert.equal(session.transferId, 'transfer-123');
  assert.strictEqual(await runtime.start(instance, { port: 57123 }), session);
  assert.deepEqual(calls.map(([kind]) => kind), ['script', 'build', 'upload', 'script']);
  await runtime.stop(instance, session);
  assert.match(calls[4][1], /server\.pid/u);
});

test('managed runtime requires explicit bundle upload consent before building', async () => {
  let built = false;
  const runtime = createManagedSshRuntime({ getBundlePaths: () => ({}), createBundle: () => { built = true; return Buffer.from('archive'); } });
  await assert.rejects(runtime.start({ remoteOpenchamber: { uploadBundleOverSsh: false } }, { port: 57123 }), /upload-not-enabled/u);
  assert.equal(built, false);
});

test('managed runtime stops a partially launched server when readiness confirmation fails', async () => {
  const scripts = [];
  const runtime = createManagedSshRuntime({
    getBundlePaths: () => ({}), createBundle: () => Buffer.from('archive'),
    uploadBundle: async () => ({ transferId: 'transfer-123' }),
    runRemoteScript: async (_instance, script) => {
      scripts.push(script);
      if (scripts.length === 1) return { code: 0, stdout: 'unexpected response', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  await assert.rejects(runtime.start({ id: 'instance-123', sshCommand: 'ssh host', remoteOpenchamber: { uploadBundleOverSsh: true } }, { port: 57123 }), /start-unconfirmed/u);
  assert.match(scripts[2], /server\.pid/u);
});

test('managed runtime rediscovers a persistent server before building or uploading after restart', async () => {
  let built = false;
  let uploaded = false;
  const runtime = createManagedSshRuntime({
    getBundlePaths: () => ({}), createBundle: () => { built = true; return Buffer.from('archive'); },
    uploadBundle: async () => { uploaded = true; return { transferId: 'new-transfer-123' }; },
    getVersion: () => '20260930.0.75',
    runRemoteScript: async () => ({ code: 0, stdout: 'NOTNATIVE_EXISTING_PID=42 PORT=57123 ID=old-transfer_123 VERSION=20260930.0.75\n', stderr: '' }),
  });
  const session = await runtime.start({ id: 'instance-123', sshCommand: 'ssh host', remoteOpenchamber: { uploadBundleOverSsh: true, keepRunning: true } }, { port: 57123 });
  assert.deepEqual(session, { transferId: 'old-transfer_123', pid: 42, port: 57123, version: '20260930.0.75', reused: true });
  assert.equal(built, false);
  assert.equal(uploaded, false);
});

test('managed runtime replaces a previous-version server before installing the current version', async () => {
  const scripts = [];
  const runtime = createManagedSshRuntime({
    getVersion: () => '20260930.0.76',
    getBundlePaths: () => ({}), createBundle: () => Buffer.from('new archive'),
    uploadBundle: async () => ({ transferId: 'new-transfer-123' }),
    runRemoteScript: async (_instance, script) => {
      scripts.push(script);
      if (scripts.length === 1) return { code: 0, stdout: 'NOTNATIVE_EXISTING_PID=42 PORT=57123 ID=old-transfer_123 VERSION=20260930.0.75\n', stderr: '' };
      if (scripts.length === 2) return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: 'NOTNATIVE_STARTED_PID=53 PORT=57123\n', stderr: '' };
    },
  });
  const session = await runtime.start({ id: 'instance-123', sshCommand: 'ssh host', remoteOpenchamber: { uploadBundleOverSsh: true, keepRunning: true } }, { port: 57123 });
  assert.equal(session.transferId, 'new-transfer-123');
  assert.match(scripts[1], /old-transfer_123/u);
  assert.match(scripts[2], /20260930\.0\.76/u);
});
