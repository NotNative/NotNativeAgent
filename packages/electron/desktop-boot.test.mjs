// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDesktopBootTarget } from './desktop-boot.mjs';

const localRuntime = { apiBaseUrl: 'http://127.0.0.1:57123', clientToken: 'local-token', requestHeaders: {}, runtimeKey: 'local' };
const config = { hosts: [], defaultHostId: null };

test('local target remains selected when no remote default is configured', async () => {
  const result = await resolveDesktopBootTarget({ config, localRuntime, localAvailable: true, probeHost: async () => { throw new Error('must not probe'); } });
  assert.deepEqual(result, { runtime: localRuntime, bootOutcome: { target: 'local', status: 'ok' } });
});

test('environment target takes priority and never inherits credentials', async () => {
  const probes = [];
  const result = await resolveDesktopBootTarget({
    config: { hosts: [{ id: 'saved', url: 'https://saved.example', clientToken: 'saved-token' }], defaultHostId: 'saved' },
    localRuntime, localAvailable: true, envTargetUrl: ' https://env.example/path/?ticket=secret#fragment ',
    probeHost: async (options) => { probes.push(options); return { status: 'ok' }; },
  });
  assert.equal(probes.length, 1);
  assert.deepEqual(probes[0], { url: 'https://env.example/path' });
  assert.deepEqual(result.runtime, {
    apiBaseUrl: 'https://env.example/path', clientToken: null, requestHeaders: {}, runtimeKey: 'url:https://env.example',
  });
  assert.deepEqual(result.bootOutcome, { target: 'remote', status: 'ok', hostId: '__env', url: 'https://env.example/path' });
});

test('an invalid explicit environment target falls back locally without selecting the saved default', async () => {
  const result = await resolveDesktopBootTarget({
    config: { hosts: [{ id: 'saved', url: 'https://saved.example', clientToken: 'saved-token' }], defaultHostId: 'saved' },
    localRuntime, localAvailable: true, envTargetUrl: 'file:///tmp/target?secret=do-not-report',
    probeHost: async () => { throw new Error('must not probe'); },
  });
  assert.equal(result.runtime, localRuntime);
  assert.deepEqual(result.bootOutcome, { target: 'remote', status: 'wrong-service', hostId: '__env', localAvailable: true });
});

test('saved host routes only after authenticated compatibility probe succeeds', async () => {
  const host = { id: 'remote-1', url: 'https://remote.example/nnd', clientToken: 'paired-token', requestHeaders: { 'x-site': 'desk' }, serverId: 'srv-1' };
  const result = await resolveDesktopBootTarget({
    config: { hosts: [host], defaultHostId: host.id }, localRuntime, localAvailable: true,
    probeHost: async (options) => {
      assert.deepEqual(options, { url: 'https://remote.example/nnd', clientToken: 'paired-token', requestHeaders: { 'x-site': 'desk' }, expectedServerId: 'srv-1' });
      return { status: 'ok' };
    },
  });
  assert.deepEqual(result.runtime, {
    apiBaseUrl: 'https://remote.example/nnd', clientToken: 'paired-token', requestHeaders: { 'x-site': 'desk' }, runtimeKey: 'host:remote-1',
  });
  assert.equal(result.bootOutcome.target, 'remote');
});

test('saved relay-only host boots locally pending renderer tunnel restoration', async () => {
  const host = { id: 'relay-1', url: 'relay://srv-1', relay: {
    relayUrl: 'wss://relay.example/ws', serverId: 'srv-1', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
  } };
  const result = await resolveDesktopBootTarget({
    config: { hosts: [host], defaultHostId: host.id }, localRuntime, localAvailable: true,
    probeHost: async () => { throw new Error('relay probes belong in the renderer'); },
  });
  assert.equal(result.runtime, localRuntime);
  assert.deepEqual(result.bootOutcome, {
    target: 'remote', status: 'relay-pending', hostId: 'relay-1', via: 'relay', localAvailable: true,
  });
});

test('SSH placeholder defaults remain local until the SSH transport is connected', async () => {
  const probes = [];
  const result = await resolveDesktopBootTarget({
    config: { defaultHostId: 'ssh-studio', hosts: [{ id: 'ssh-studio', url: 'http://127.0.0.1/' }] },
    sshHostIds: ['ssh-studio'], localRuntime, localAvailable: true,
    probeHost: async (input) => { probes.push(input); return { status: 'ok' }; },
  });
  assert.equal(result.runtime.runtimeKey, 'local');
  assert.deepEqual(result.bootOutcome, {
    target: 'remote', status: 'unreachable', hostId: 'ssh-studio', via: 'ssh',
    reason: 'desktop-ssh-not-connected', localAvailable: true,
  });
  assert.deepEqual(probes, []);
});

test('SSH transport marker keeps a placeholder local when its instance catalog is corrupt', async () => {
  const probes = [];
  const result = await resolveDesktopBootTarget({
    config: { defaultHostId: 'ssh-studio', hosts: [{ id: 'ssh-studio', transport: 'ssh', url: 'http://127.0.0.1/' }] },
    sshHostIds: [], localRuntime, localAvailable: true,
    probeHost: async (input) => { probes.push(input); return { status: 'ok' }; },
  });
  assert.equal(result.runtime.runtimeKey, 'local');
  assert.equal(result.bootOutcome.reason, 'desktop-ssh-not-connected');
  assert.deepEqual(probes, []);
});

test('missing, invalid, and failed remotes fall back locally with a bounded boot outcome', async (t) => {
  await t.test('missing saved id', async () => {
    const result = await resolveDesktopBootTarget({ config: { hosts: [], defaultHostId: 'gone' }, localRuntime, localAvailable: true, probeHost: async () => { throw new Error('must not probe'); } });
    assert.deepEqual(result, { runtime: localRuntime, bootOutcome: { target: 'remote', status: 'missing', hostId: 'gone', localAvailable: true } });
  });
  await t.test('invalid configured target', async () => {
    const result = await resolveDesktopBootTarget({ config: { hosts: [{ id: 'bad', url: 'file:///bad' }], defaultHostId: 'bad' }, localRuntime, localAvailable: true, probeHost: async () => { throw new Error('must not probe'); } });
    assert.equal(result.runtime, localRuntime);
    assert.equal(result.bootOutcome.status, 'wrong-service');
  });
  await t.test('auth failure maps to unreachable', async () => {
    const result = await resolveDesktopBootTarget({ config: { hosts: [{ id: 'remote', url: 'https://remote.example' }], defaultHostId: 'remote' }, localRuntime, localAvailable: true, probeHost: async () => ({ status: 'auth' }) });
    assert.equal(result.runtime, localRuntime);
    assert.equal(result.bootOutcome.status, 'unreachable');
  });
  await t.test('unexpected probe rejection falls back locally', async () => {
    const result = await resolveDesktopBootTarget({ config: { hosts: [{ id: 'remote', url: 'https://remote.example' }], defaultHostId: 'remote' }, localRuntime, localAvailable: true, probeHost: async () => { throw new Error('unexpected transport failure'); } });
    assert.equal(result.runtime, localRuntime);
    assert.equal(result.bootOutcome.status, 'unreachable');
  });
  await t.test('future client requirement maps to incompatible', async () => {
    const result = await resolveDesktopBootTarget({ envTargetUrl: 'https://remote.example', localRuntime, localAvailable: false, probeHost: async () => ({ status: 'update-recommended' }) });
    assert.equal(result.runtime, localRuntime);
    assert.equal(result.bootOutcome.status, 'incompatible');
  });
});
