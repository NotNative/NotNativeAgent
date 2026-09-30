// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { readDesktopHostsConfig, sanitizeDesktopHost, sanitizeDesktopHostsConfig } from './host-config.mjs';

const hostKey = { ...generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' }), d: 'private-key-must-not-survive' };

test('sanitizes direct host metadata and strips unsafe headers and URL fragments', () => {
  const host = sanitizeDesktopHost({
    id: ' home ', label: ' My server ', url: 'https://example.test/base/#secret',
    apiUrl: 'https://api.example.test/v1/#fragment', clientToken: ' bearer ',
    requestHeaders: { 'X-Region': ' west ', Authorization: 'secret', Cookie: 'private', 'bad name': 'x' },
  });
  assert.deepEqual(host, {
    id: 'home', label: 'My server', url: 'https://example.test/base', apiUrl: 'https://api.example.test/v1',
    clientToken: 'bearer', requestHeaders: { 'x-region': 'west' },
  });
});

test('accepts relay-only hosts but persists only public relay key material', () => {
  const host = sanitizeDesktopHost({ id: 'relay', relay: {
    relayUrl: 'wss://relay.example/socket#discard', serverId: 'server-1', hostEncPubJwk: hostKey,
  } });
  assert.deepEqual(host, {
    id: 'relay', label: 'relay://server-1', url: 'relay://server-1',
    relay: { relayUrl: 'wss://relay.example/socket', serverId: 'server-1', hostEncPubJwk: {
      kty: 'EC', crv: 'P-256', x: hostKey.x, y: hostKey.y,
    } },
  });
  assert.equal(JSON.stringify(host).includes('private-key'), false);
});

test('rejects relay keys with correctly sized but invalid curve coordinates', () => {
  const host = sanitizeDesktopHost({ id: 'relay', relay: {
    relayUrl: 'wss://relay.example/socket', serverId: 'server-1',
    hostEncPubJwk: { ...hostKey, x: 'A'.repeat(43), y: 'B'.repeat(43) },
  } });
  assert.equal(host, null);
});

test('rejects invalid, duplicate, or missing default hosts and caps the catalog', () => {
  const entry = { id: 'host-a', url: 'http://example.test' };
  assert.throws(() => sanitizeDesktopHostsConfig({ hosts: [{ id: 'local', url: 'http://x' }], defaultHostId: null }), /entry is invalid/u);
  assert.throws(() => sanitizeDesktopHostsConfig({ hosts: [entry, entry], defaultHostId: 'host-a' }), /unique/u);
  assert.throws(() => sanitizeDesktopHostsConfig({ hosts: [entry], defaultHostId: 'missing' }), /does not exist/u);
  assert.throws(() => sanitizeDesktopHostsConfig({ hosts: Array.from({ length: 101 }, (_, i) => ({ id: `h${i}`, url: 'http://example.test' })) }), /list is invalid/u);
});

test('preserves the local token update intent and fails closed on corrupt persisted host data', () => {
  assert.deepEqual(sanitizeDesktopHostsConfig({ hosts: [], defaultHostId: 'local', localClientToken: '' }), {
    hosts: [], defaultHostId: 'local', initialHostChoiceCompleted: false, localClientToken: null,
  });
  assert.deepEqual(readDesktopHostsConfig({ desktopHosts: [{ id: 'broken' }], desktopDefaultHostId: 'broken' }), {
    hosts: [], defaultHostId: null, initialHostChoiceCompleted: false,
  });
});
