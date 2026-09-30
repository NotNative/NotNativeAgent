// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { isExpectedRelayDefault, matchesExpectedRelayHost, readDesktopHostsConfig, sanitizeDesktopHost, sanitizeDesktopHostsConfig } from './host-config.mjs';

const hostKey = { ...generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' }), d: 'private-key-must-not-survive' };

test('relay selection expectation rejects same-id descriptor or credential replacement after probe', () => {
  const saved = sanitizeDesktopHost({
    id: 'relay', url: 'relay://server-1', relay: { relayUrl: 'wss://relay.example/ws', serverId: 'server-1', hostEncPubJwk: hostKey },
    clientToken: 'token-a', requestHeaders: { 'X-Site': 'studio' },
  });
  const expected = {
    relayUrl: saved.relay.relayUrl, serverId: saved.relay.serverId,
    hostEncPubJwk: saved.relay.hostEncPubJwk, clientToken: saved.clientToken,
    requestHeaders: saved.requestHeaders,
  };
  assert.equal(matchesExpectedRelayHost(saved, expected), true);
  assert.equal(matchesExpectedRelayHost({ ...saved, clientToken: 'token-b' }, expected), false);
  assert.equal(matchesExpectedRelayHost({ ...saved, relay: { ...saved.relay, serverId: 'server-2' } }, expected), false);
  assert.equal(matchesExpectedRelayHost({ ...saved, requestHeaders: { 'x-site': 'other' } }, expected), false);
});

test('startup restore is allowed only while its relay host remains the saved default', () => {
  assert.equal(isExpectedRelayDefault({ defaultHostId: 'relay-1' }, 'relay-1'), true);
  assert.equal(isExpectedRelayDefault({ defaultHostId: 'local' }, 'relay-1'), false);
  assert.equal(isExpectedRelayDefault({ defaultHostId: 'direct-2' }, 'relay-1'), false);
});

test('sanitizes direct host metadata and strips unsafe headers and URL fragments', () => {
  const host = sanitizeDesktopHost({
    id: ' home ', label: ' My server ', url: 'https://example.test/base/#secret',
    apiUrl: 'https://api.example.test/v1/#fragment', clientToken: ' bearer ', serverId: ' server-1 ',
    requestHeaders: { 'X-Region': ' west ', Authorization: 'secret', Cookie: 'private', 'bad name': 'x' },
  });
  assert.deepEqual(host, {
    id: 'home', label: 'My server', url: 'https://example.test/base', apiUrl: 'https://api.example.test/v1',
    clientToken: 'bearer', serverId: 'server-1', requestHeaders: { 'x-region': 'west' },
  });
});

test('preserves only the explicit SSH transport marker on saved-host placeholders', () => {
  const host = sanitizeDesktopHost({ id: 'ssh-studio', label: 'Studio', url: 'http://127.0.0.1/', transport: 'ssh' });
  assert.deepEqual(host, { id: 'ssh-studio', label: 'Studio', url: 'http://127.0.0.1', apiUrl: 'http://127.0.0.1', transport: 'ssh' });
  assert.equal(sanitizeDesktopHost({ id: 'direct', url: 'https://studio.example/', transport: 'other' }).transport, undefined);
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
