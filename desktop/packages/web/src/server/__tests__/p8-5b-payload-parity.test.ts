// SPDX-License-Identifier: Apache-2.0
/**
 * P8-5b pairing payload parity gates (doc 08 sections 5.1/5.2/5.3).
 *
 * The browser mirror (packages/ui/src/lib/connection-payload.ts) and the host
 * encoder (server/lib/auth/pairing-payload.ts) are independent implementations
 * of one wire contract, so every gate here is cross-module: the same
 * structured input must produce a byte-identical link from either encoder, and
 * either side must accept the other's link unchanged.
 *
 * The link is exactly openchamber://connect?v=2&p=<base64url(UTF-8 JSON)>. The
 * 16384-character cap applies to the JSON, to p, and to the whole link. v1 is
 * rejected forever (the designed-out sin: a long-lived token embedded in QR
 * text and browser history). An unknown candidate shape voids the whole
 * payload, since a partially understood link would redeem over an unintended
 * transport.
 *
 * Source is ASCII-only on purpose: sibling test files in this slice were
 * damaged by a CP1252 round-trip, so section references are spelled out here
 * rather than written as the section-sign character.
 */
import { describe, expect, it } from 'vitest';
import {
  b64urlDecodePayload,
  encodePairingConnectionPayload as encodeHost,
  MAX_PAIRING_PAYLOAD_LENGTH as HOST_MAX,
  normalizePairingPayload,
  PAIRING_LINK_PREFIX as HOST_PREFIX,
} from '../lib/auth/pairing-payload.ts';
import {
  decodePairingPayloadParameter as clientDecodeParameter,
  encodePairingConnectionPayload as clientEncode,
  MAX_PAIRING_PAYLOAD_LENGTH as CLIENT_MAX,
  normalizePairingConnectionPayload as clientNormalize,
  PAIRING_LINK_PREFIX as CLIENT_PREFIX,
  parseConnectionPayload as clientParseAny,
  parsePairingConnectionPayload as clientParse,
  parsePairingConnectionPayloadString as clientParseString,
  PRIORITY_DIRECT_ORIGIN,
  PRIORITY_DIRECT_PRIMARY,
  PRIORITY_RELAY,
} from '@notnative/ui/lib/connection-payload.ts';

const FUTURE = '2099-01-01T00:00:00.000Z';
const JWK = { kty: 'EC' as const, crv: 'P-256' as const, x: 'BLx', y: 'd1y' };

const CANDIDATES = [
  { type: 'lan' as const, url: 'http://192.168.1.10:17627/', priority: PRIORITY_DIRECT_PRIMARY },
  { type: 'tunnel' as const, url: 'https://atlas.example.test/#frag', priority: PRIORITY_DIRECT_ORIGIN },
  {
    type: 'relay' as const,
    relayUrl: 'wss://relay.example.test/ws#frag',
    serverId: 'srv_1',
    hostEncPubJwk: JWK,
    grant: 'gnt_1',
    priority: PRIORITY_RELAY,
  },
];

type EncoderInput = Parameters<typeof encodeHost>[0];

function input(overrides: Partial<EncoderInput> = {}): EncoderInput {
  return {
    pairingId: 'pair_0123456789abcdef0123456789abcdef',
    secret: 's'.repeat(43),
    label: 'atlas',
    fingerprint: 'AB3F-00C1',
    expiresAt: FUTURE,
    candidates: CANDIDATES,
    ...overrides,
  };
}

function parameter(link: string): string {
  const index = link.indexOf('&p=');
  expect(index).toBeGreaterThan(-1);
  return link.slice(index + 3);
}

describe('pairing payload parity (doc 08 5.1-5.3)', () => {
  it('shares the exact link head and size bound', () => {
    expect(CLIENT_PREFIX).toBe(HOST_PREFIX);
    expect(CLIENT_MAX).toBe(HOST_MAX);
    expect(HOST_MAX).toBe(16_384);
  });

  it('both encoders emit byte-identical links for the same input', () => {
    const host = encodeHost(input());
    const client = clientEncode(input());
    expect(client).toBe(host);
    expect(host.startsWith(HOST_PREFIX)).toBe(true);
    expect(host.length).toBeLessThanOrEqual(HOST_MAX);
  });

  it('both base64url+JSON layers agree byte for byte', () => {
    const hostJson = JSON.stringify(b64urlDecodePayload(parameter(encodeHost(input()))));
    const clientJson = JSON.stringify(clientDecodeParameter(parameter(encodeHost(input()))));
    expect(clientJson).toBe(hostJson);
  });

  it('candidate normalization is identical on both sides (hash, trailing slash, grant, jwk)', () => {
    const link = encodeHost(input());
    const fromClient = clientParse(link);
    expect(fromClient).not.toBeNull();
    const fromHost = normalizePairingPayload(b64urlDecodePayload(parameter(link)));
    expect(fromHost).not.toBeNull();
    expect(JSON.stringify(fromHost)).toBe(JSON.stringify(fromClient));
    const [lan, tunnel, relay] = fromHost!.candidates;
    expect(lan?.type === 'lan' && lan.url).toBe('http://192.168.1.10:17627'); // trailing slash runs stripped
    expect(tunnel?.type === 'tunnel' && tunnel.url).toBe('https://atlas.example.test'); // hash stripped
    expect(relay).toMatchObject({
      type: 'relay',
      relayUrl: 'wss://relay.example.test/ws', // hash stripped, but the /ws path is kept

      serverId: 'srv_1',
      grant: 'gnt_1',
      priority: PRIORITY_RELAY,
    });
    expect(relay?.type === 'relay' && relay.hostEncPubJwk).toEqual({ kty: 'EC', crv: 'P-256', x: 'BLx', y: 'd1y' });
  });

  it('a client-encoded link is accepted by the host normalizer unchanged', () => {
    const link = clientEncode(input());
    const parsed = clientParse(link);
    expect(JSON.stringify(normalizePairingPayload(clientDecodeParameter(parameter(link))))).toBe(
      JSON.stringify(parsed),
    );
  });

  it('drops an empty grant and a non-finite priority identically', () => {
    const candidates = [
      { type: 'relay' as const, relayUrl: 'ws://relay:8080/ws', serverId: 'srv', hostEncPubJwk: JWK, grant: '', priority: Number.NaN },
    ];
    const host = normalizePairingPayload({ v: 2, pairingId: 'p', secret: 's', expiresAt: FUTURE, candidates });
    const client = clientNormalize({ v: 2, pairingId: 'p', secret: 's', expiresAt: FUTURE, candidates });
    expect(JSON.stringify(client)).toBe(JSON.stringify(host));
    expect(host!.candidates[0]).toEqual({ type: 'relay', relayUrl: 'ws://relay:8080/ws', serverId: 'srv', hostEncPubJwk: JWK });
  });

  it('rejects a ws relay URL with a non-http scheme and any private jwk member identically', () => {
    const badJwk = { ...JWK, d: 'private' };
    const cases = [
      { type: 'lan' as const, url: 'ftp://host:1' },
      { type: 'relay' as const, relayUrl: 'http://relay/ws', serverId: 'srv', hostEncPubJwk: JWK },
      { type: 'relay' as const, relayUrl: 'wss://relay/ws', serverId: 'srv', hostEncPubJwk: badJwk },
      { type: 'quic' as const, url: 'http://host' },
    ];
    for (const candidate of cases) {
      const shape = { v: 2, pairingId: 'p', secret: 's', expiresAt: FUTURE, candidates: [candidate] };
      expect(normalizePairingPayload(shape), candidate.type).toBeNull();
      expect(clientNormalize(shape), candidate.type).toBeNull();
    }
  });

  it('rejects v1 forever and any past or unparsable expiry identically', () => {
    const base = { pairingId: 'p', secret: 's', candidates: [{ type: 'lan' as const, url: 'http://h' }] };
    const v1 = { ...base, v: 1, expiresAt: FUTURE };
    expect(normalizePairingPayload(v1)).toBeNull();
    expect(clientNormalize(v1)).toBeNull();
    for (const expiresAt of ['2000-01-01T00:00:00.000Z', 'not-a-date', new Date().toISOString(), 123]) {
      const shape = { ...base, v: 2, expiresAt };
      expect(normalizePairingPayload(shape), String(expiresAt)).toBeNull();
      expect(clientNormalize(shape), String(expiresAt)).toBeNull();
    }
  });

  it('treats a hole in the candidate list as fatal, not a best-effort skip', () => {
    for (const candidates of [[null], [undefined], [5], [['lan']], []]) {
      const shape = { v: 2, pairingId: 'p', secret: 's', expiresAt: FUTURE, candidates };
      expect(normalizePairingPayload(shape)).toBeNull();
      expect(clientNormalize(shape)).toBeNull();
    }
  });

  it('applies the cap to the JSON, to p, and to the whole link identically', () => {
    const huge = { pairingId: 'pair_' + 'a'.repeat(20_000), secret: 's', expiresAt: FUTURE, candidates: CANDIDATES };
    expect(() => encodeHost(huge)).toThrow('Invalid pairing connection payload');
    expect(() => clientEncode(huge)).toThrow('Invalid pairing connection payload');
    expect(clientDecodeParameter('A'.repeat(HOST_MAX + 4))).toBeNull();
  });
});

describe('pairing link parsers (doc 08 5.1)', () => {
  const link = () => clientEncode(input());

  it('requires the protocol, hostname, version, and a non-empty p', () => {
    expect(clientParse('')).toBeNull();
    expect(clientParse('   ')).toBeNull();
    expect(clientParse('https://connect?v=2&p=abc')).toBeNull();
    expect(clientParse('openchamber://other?v=2&p=abc')).toBeNull();
    expect(clientParse('openchamber://connect?v=3&p=abc')).toBeNull();
    expect(clientParse('openchamber://connect?v=2')).toBeNull();
    expect(clientParse('openchamber://connect?v=2&p=')).toBeNull();
    expect(clientParse('openchamber://connect?v=2&p=%20')).toBeNull();
  });

  it('ignores unknown query keys and trims surrounding whitespace', () => {
    const padded = '  ' + link() + '&junk=1&another=x  ';
    expect(clientParse(padded)).not.toBeNull();
    expect(clientParse(padded)!.candidates.length).toBe(3);
  });

  it('runs every validation in the string fallback too', () => {
    const full = link();
    expect(clientParseString(full)).not.toBeNull();
    expect(clientParseString('openchamber://connect?v=1&p=abc')).toBeNull();
    expect(clientParseString('openchamber://connect?v=2&p=not-base64url-json')).toBeNull();
    expect(clientParseString('openchamber://connect')).toBeNull();
    expect(clientParseString('http://connect?v=2&p=abc')).toBeNull();
  });

  it('tolerates the old-WebView shapes: case, trailing slash, key order', () => {
    const p = parameter(link());
    expect(clientParseString(`OPENCHAMBER://CONNECT/?p=${p}&v=2`)).not.toBeNull();
    expect(clientParseString(`openchamber://connect?p=${p}&v=2`)).not.toBeNull();
    expect(clientParseString(`openchamber://connect/?v=2&p=${p}#frag`)).not.toBeNull();
    expect(clientParseString(`  openchamber://connect/?v=2&p=${p}  `)).not.toBeNull();
  });

  it('classifies a scanned string as pairing, direct, or invalid', () => {
    expect(clientParseAny(link()).status).toBe('pairing');
    expect(clientParseAny('  https://192.168.1.10:17627  ')).toEqual({ status: 'direct', url: 'https://192.168.1.10:17627' });
    expect(clientParseAny('nonsense')).toEqual({ status: 'invalid' });
    expect(clientParseAny('openchamber://connect?v=1&p=abc')).toEqual({ status: 'invalid' });
    expect(clientParseAny('')).toEqual({ status: 'invalid' });
  });

  it('keeps an unpadded base64url alphabet and rejects a truncated tail', () => {
    const p = parameter(link());
    expect(p).not.toContain('=');
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(clientParse(`openchamber://connect?v=2&p=${p.slice(0, p.length - 3)}`)).toBeNull();
  });
});
