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
  const instance = { id: 'instance-123', sshCommand: 'ssh host', remoteOpenchamber: { uploadBundleOverSsh: true, installMethod: 'npm' } };
  const session = await runtime.start(instance, { port: 57123 });
  assert.equal(session.transferId, 'transfer-123');
  assert.strictEqual(await runtime.start(instance, { port: 57123 }), session);
  assert.deepEqual(calls.map(([kind]) => kind), ['build', 'upload', 'script']);
  await runtime.stop(instance, session);
  assert.match(calls[3][1], /server\.pid/u);
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
  assert.match(scripts[1], /server\.pid/u);
});
