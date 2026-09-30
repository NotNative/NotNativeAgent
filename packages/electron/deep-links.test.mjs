// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { extractDesktopDeepLinks, parseDesktopDeepLink } from './deep-links.mjs';

test('accepts only session and focus links with bounded session identifiers', () => {
  assert.deepEqual(parseDesktopDeepLink('openchamber://focus'), { type: 'focus' });
  assert.deepEqual(parseDesktopDeepLink('openchamber://session/ses_123'), { type: 'session', sessionId: 'ses_123' });
  assert.deepEqual(parseDesktopDeepLink('openchamber://session/ses%3A123'), { type: 'session', sessionId: 'ses:123' });
  assert.equal(parseDesktopDeepLink(`openchamber://session/${'x'.repeat(501)}`), null);
});

test('accepts bounded host-switch links with a single safe saved id', () => {
  assert.deepEqual(parseDesktopDeepLink('openchamber://host/studio-01'), { type: 'host', hostId: 'studio-01' });
  assert.deepEqual(parseDesktopDeepLink('openchamber://host/a%3Ab'), { type: 'host', hostId: 'a:b' });
  assert.deepEqual(parseDesktopDeepLink('openchamber://host/local'), { type: 'host', hostId: 'local' });
  for (const value of [
    'openchamber://host/', 'openchamber://host/a%2Fb', 'openchamber://host/%00',
    'openchamber://host/studio?next=https://evil.test', 'openchamber://host//studio',
    'openchamber://host/../studio', 'openchamber://host/%2e%2e/studio', 'openchamber://host/studio?',
    'openchamber://host/.', 'openchamber://host/%2E%2E', `openchamber://host/${'x'.repeat(129)}`,
  ]) assert.equal(parseDesktopDeepLink(value), null, value);
});

test('rejects link variants that could smuggle another action or malformed path', () => {
  for (const value of [
    'https://session/ses_1', 'openchamber://user@session/ses_1', 'openchamber://session:99/ses_1',
    'openchamber://session/ses_1?next=https://evil.test', 'openchamber://session/a%2Fb',
    'openchamber://session/%00', 'openchamber://connect?v=2&p=payload', 'openchamber://focus/extra',
  ]) assert.equal(parseDesktopDeepLink(value), null, value);
});

test('extracts supported links from launch arguments and ignores unrelated arguments', () => {
  assert.deepEqual(extractDesktopDeepLinks(['--hidden', 'openchamber://session/s1', 'https://example.test', 'openchamber://focus', 'openchamber://host/studio']), [
    { type: 'session', sessionId: 's1' }, { type: 'focus' }, { type: 'host', hostId: 'studio' },
  ]);
});

test('parses bounded v2 pairing payloads and orders direct candidates by priority', () => {
  const payload = {
    v: 2, pairingId: 'pair_1', secret: 'secret-value', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    label: 'Studio', candidates: [
      { type: 'tunnel', url: 'https://studio.example/api/#fragment', priority: 20 },
      { type: 'lan', url: 'http://192.168.1.10:57123/', priority: 10 },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const result = parseDesktopDeepLink(`openchamber://connect?v=2&p=${encoded}`);
  assert.equal(result.type, 'connect');
  assert.deepEqual(result.payload.candidates.map((candidate) => candidate.url), [
    'http://192.168.1.10:57123', 'https://studio.example/api',
  ]);
  assert.equal(result.payload.secret, 'secret-value');
});

test('rejects expired, duplicated, oversized, credentialed, and malformed pairing payloads', () => {
  const base = { v: 2, pairingId: 'pair_1', secret: 's', expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates: [{ type: 'lan', url: 'https://host.example' }] };
  const encode = (payload) => Buffer.from(JSON.stringify(payload)).toString('base64url');
  assert.equal(parseDesktopDeepLink(`openchamber://connect?v=2&p=${encode({ ...base, expiresAt: new Date(Date.now() - 1_000).toISOString() })}`), null);
  assert.equal(parseDesktopDeepLink(`openchamber://connect?v=2&v=2&p=${encode(base)}`), null);
  assert.equal(parseDesktopDeepLink(`openchamber://connect?v=2&p=${encode({ ...base, candidates: [{ type: 'lan', url: 'https://u:p@host.example' }] })}`), null);
  assert.equal(parseDesktopDeepLink(`openchamber://connect?v=2&p=${'a'.repeat(16_385)}`), null);
  assert.equal(parseDesktopDeepLink('openchamber://connect?v=2&p=%%%'), null);
});

test('accepts pairing links larger than 4 KiB while respecting the total link limit', () => {
  const payload = {
    v: 2, pairingId: 'pair_1', secret: 's'.repeat(4_000), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    candidates: [{ type: 'lan', url: 'https://host.example' }],
  };
  const link = `openchamber://connect?v=2&p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  assert.ok(link.length > 4_096 && link.length < 16_384);
  assert.equal(parseDesktopDeepLink(link).type, 'connect');
  assert.equal(parseDesktopDeepLink(`${link}${'x'.repeat(16_384)}`), null);
});

test('preserves and validates relay grants and server ids in pairing payloads', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const candidate = { type: 'relay', relayUrl: 'wss://relay.example/ws#old', serverId: ' srv-1 ', hostEncPubJwk: jwk, grant: 'grant-value' };
  const payload = { v: 2, pairingId: 'pair_1', secret: 's', expiresAt: new Date(Date.now() + 60_000).toISOString(), candidates: [candidate] };
  const encode = (value) => `openchamber://connect?v=2&p=${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  const result = parseDesktopDeepLink(encode(payload));
  assert.deepEqual(result.payload.candidates[0], {
    type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv-1',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, grant: 'grant-value', priority: 100,
  });
  for (const serverId of ['', ' '.repeat(10), 's'.repeat(257)]) {
    assert.equal(parseDesktopDeepLink(encode({ ...payload, candidates: [{ ...candidate, serverId }] })), null);
  }
});
