// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRelayPairingBridge } from './relay-pairing-bridge.mjs';

test('the relay pairing bridge is shipped with the packaged Electron main process', () => {
  const manifestPath = new URL('./package.json', import.meta.url);
  const manifest = JSON.parse(readFileSync(fileURLToPath(manifestPath), 'utf8'));
  assert.ok(manifest.build.files.includes('relay-pairing-bridge.mjs'));
});

function setup(options = {}) {
  const listeners = new Map();
  const sent = [];
  const webContents = {
    send: (_channel, message) => sent.push(message),
    once: (name, listener) => listeners.set(name, listener),
    removeListener: (name) => listeners.delete(name),
    isDestroyed: () => false,
  };
  const win = { webContents, isDestroyed: () => false };
  const bridge = createRelayPairingBridge({ getWindow: () => win, makeRequestId: () => 'request-1', ...options });
  return { bridge, sent, listeners };
}

test('delivers a one-shot relay redemption request and accepts a bounded token result', async () => {
  const { bridge, sent } = setup();
  const request = bridge.request({ requestId: 'spoofed', payload: { secret: 'one-time' }, candidate: { serverId: 'server-1' } });
  assert.equal(bridge.pendingCount, 1);
  assert.deepEqual(sent[0], {
    event: 'openchamber:desktop-pairing-relay-request',
    detail: { requestId: 'request-1', payload: { secret: 'one-time' }, candidate: { serverId: 'server-1' } },
  });
  assert.deepEqual(bridge.complete('request-1', { ok: true, clientToken: 'token', serverLabel: 'Studio' }), {
    ok: true, result: { accepted: true },
  });
  assert.deepEqual(await request, { ok: true, clientToken: 'token', serverLabel: 'Studio' });
  assert.equal(bridge.pendingCount, 0);
});

test('rejects results that could carry credentials or relay grants back from the renderer', async () => {
  const { bridge } = setup();
  const request = bridge.request({});
  assert.deepEqual(bridge.complete('request-1', { ok: true, clientToken: 'token', grant: 'leak' }), {
    ok: false, error: 'invalid-relay-pairing-result',
  });
  bridge.complete('request-1', { ok: true, clientToken: 'token' });
  assert.deepEqual(await request, { ok: true, clientToken: 'token', serverLabel: null });
});

test('rejects stale requests and bounds concurrent work', async () => {
  let id = 0;
  const { bridge } = setup({ makeRequestId: () => `request-${++id}`, maxPending: 1 });
  const first = bridge.request({});
  assert.deepEqual(await bridge.request({}), { ok: false, error: 'too-many-pairing-requests' });
  bridge.complete('request-1', { ok: false, error: 'cancelled' });
  assert.deepEqual(await first, { ok: false, error: 'cancelled' });
  assert.deepEqual(bridge.complete('request-1', { ok: true, clientToken: 'token' }), {
    ok: false, error: 'relay-pairing-request-expired',
  });
});

test('does not overwrite an in-flight request when the request id factory repeats', async () => {
  const ids = ['duplicate', 'duplicate', 'unique'];
  const { bridge, sent } = setup({ makeRequestId: () => ids.shift() });
  const first = bridge.request({ marker: 'first' });
  const second = bridge.request({ marker: 'second' });
  assert.equal(bridge.pendingCount, 2);
  assert.equal(sent[0].detail.requestId, 'duplicate');
  assert.equal(sent[1].detail.requestId, 'unique');
  bridge.complete('duplicate', { ok: false, error: 'cancelled' });
  bridge.complete('unique', { ok: true, clientToken: 'second-token' });
  assert.deepEqual(await first, { ok: false, error: 'cancelled' });
  assert.deepEqual(await second, { ok: true, clientToken: 'second-token', serverLabel: null });
});

test('fails closed when the request id factory cannot produce a unique id', async () => {
  const { bridge } = setup({ makeRequestId: () => 'same-id' });
  const first = bridge.request({});
  assert.deepEqual(await bridge.request({}), {
    ok: false, error: 'relay-pairing-request-id-unavailable',
  });
  bridge.complete('same-id', { ok: false, error: 'cancelled' });
  assert.deepEqual(await first, { ok: false, error: 'cancelled' });
});

test('resolves pending requests on renderer destruction and after timeout', async () => {
  const { bridge, listeners } = setup({ timeoutMs: 10 });
  const destroyed = bridge.request({});
  listeners.get('destroyed')?.();
  assert.deepEqual(await destroyed, { ok: false, error: 'renderer-unavailable' });

  const expired = bridge.request({});
  assert.deepEqual(await expired, { ok: false, error: 'relay-pairing-timeout' });
  assert.equal(bridge.pendingCount, 0);
});
