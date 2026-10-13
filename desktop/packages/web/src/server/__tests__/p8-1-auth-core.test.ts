// SPDX-License-Identifier: Apache-2.0
/**
 * Pairing v2 payload + remote-client credential store gates (doc 08
 * sections 2.7/5.1-5.3): byte-compat encoder (link head openchamber://connect
 * pinned against both parse strategies), triple 16384 cap (JSON/p/whole link),
 * strict candidate/JWK normalization with future-expiresAt enforcement, v1
 * rejection; client store dedupe-replace with label precedence + legacy
 * cleanup, corrupt-store strict-read, atomic tmp+rename persistence, bearer
 * authentication (constant-time, fail-closed expiry, sticky relay flag,
 * 60 s lastUsed throttle), revoke/purge lifecycle, observed-transport relay
 * demand signal.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import {
  encodePairingConnectionPayload, MAX_PAIRING_PAYLOAD_LENGTH, PAIRING_PROTOCOL, PAIRING_HOSTNAME,
  PAIRING_LINK_PREFIX, normalizePairingPayload, normalizeRelayJwk, b64urlDecodePayload,
  PRIORITY_DIRECT_PRIMARY, type RelayJwk,
} from '../lib/auth/pairing-payload.ts';
import { RemoteClientStore } from '../lib/auth/remote-clients.ts';

const VALID_JWK: RelayJwk = { kty: 'EC', crv: 'P-256', x: 'aGVsbG8', y: 'd29ybGQ' };
const SECRET_43 = 's'.repeat(43);

describe('pairing v2 payload (doc 08 section 5.1-5.3)', () => {
  const expires = () => new Date(Date.now() + 600_000).toISOString();

  it('emits the exact doc 08 link head: URL-parseable as host "connect"', () => {
    const link = encodePairingConnectionPayload({
      pairingId: 'pair_abc123def456abc123de', secret: SECRET_43, label: 'atlas',
      fingerprint: 'AB3F-00C1', expiresAt: expires(),
      candidates: [
        { type: 'lan', url: 'http://127.0.0.1:3000/#x', priority: PRIORITY_DIRECT_PRIMARY },
        { type: 'relay', relayUrl: 'wss://relay.example/ws', serverId: 'srv', hostEncPubJwk: VALID_JWK, grant: 'g1', priority: 30 },
      ],
    });
    expect(link.startsWith(PAIRING_LINK_PREFIX)).toBe(true);
    expect(link.startsWith(`${PAIRING_PROTOCOL}//${PAIRING_HOSTNAME}?v=2&p=`)).toBe(true);
    expect(link).toMatch(/^openchamber:\/\/connect\?v=2&p=/);
    const parsed = new URL(link); // the standard parser: openchamber:// must NOT collapse into an opaque path
    expect(parsed.protocol).toBe('openchamber:');
    expect(parsed.hostname).toBe('connect');
    expect(parsed.searchParams.get('v')).toBe('2');
    expect(link.split('?')[0]! + '/').toMatch(/^openchamber:\/\/connect\/?$/iu); // Android fallback head regex keeps this link
    expect(link.length).toBeLessThanOrEqual(MAX_PAIRING_PAYLOAD_LENGTH);
    const payload = b64urlDecodePayload(link.slice(link.indexOf('&p=') + 3)) as { v: number; pairingId: string; candidates: { type: string; url?: string; relayUrl?: string }[] };
    expect(payload.v).toBe(2);
    expect(payload.pairingId).toBe('pair_abc123def456abc123de');
    expect(payload.candidates[0]!.type).toBe('lan');
    expect(payload.candidates[0]!.url).toBe('http://127.0.0.1:3000'); // hash + trailing slash stripped
    expect(payload.candidates[1]!.type).toBe('relay');
    expect((payload.candidates[1] as { relayUrl: string }).relayUrl).toBe('wss://relay.example/ws'); // relay path PRESERVED
  });

  it('round-trips unicode labels and drops blank label/fingerprint', () => {
    const link = encodePairingConnectionPayload({
      pairingId: 'pair_abc123def456abc123de', secret: SECRET_43, label: '  \u670D\u52A1\u5668 \u{1F60D}desk  ',
      expiresAt: expires(), candidates: [{ type: 'lan', url: 'http://x' }],
    });
    const payload = b64urlDecodePayload(link.slice(link.indexOf('&p=') + 3)) as { label?: string; fingerprint?: string };
    expect(payload.label).toBe('\u670D\u52A1\u5668 \u{1F60D}desk'); // trimmed; surrogate pairs survive base64url(UTF-8)
    expect(payload.fingerprint).toBeUndefined();
    const bare = encodePairingConnectionPayload({
      pairingId: 'p', secret: SECRET_43, label: '   ', fingerprint: '  ', expiresAt: expires(),
      candidates: [{ type: 'lan', url: 'http://x' }],
    });
    const barePayload = b64urlDecodePayload(bare.slice(bare.indexOf('&p=') + 3)) as { label?: string; fingerprint?: string };
    expect(barePayload.label).toBeUndefined(); // blank -> key absent, never ""
    expect(barePayload.fingerprint).toBeUndefined();
  });

  it('rejects v1 links, unknown candidates, private JWK members, bad curves', () => {
    expect(() => encodePairingConnectionPayload({ pairingId: 'pair_x', secret: SECRET_43, expiresAt: expires(), candidates: [] } as never)).toThrow();
    expect(() => encodePairingConnectionPayload({ pairingId: 'pair_x', secret: SECRET_43, expiresAt: '2001-01-01T00:00:00Z', candidates: [{ type: 'lan', url: 'http://x' }] } as never)).toThrow();
    expect(() => encodePairingConnectionPayload({ pairingId: 'pair_x', secret: SECRET_43, expiresAt: expires(), candidates: [{ type: 'ssh', url: 'http://x' }] } as never)).toThrow();
    expect(normalizePairingPayload({ v: 1, pairingId: 'x', secret: 's', expiresAt: '2030-01-01T00:00:00Z', candidates: [{ type: 'lan', url: 'http://x' }] })).toBeNull(); // v1 forever
    expect(normalizeRelayJwk({ kty: 'EC', crv: 'P-384', x: 'x', y: 'y' })).toBeNull();
    expect(normalizeRelayJwk({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'private' })).toBeNull();
    expect(normalizeRelayJwk({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: null })).toBeNull();
    expect(normalizeRelayJwk({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'k1', use: 'enc' })).toEqual({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }); // public extras reduced away
    expect(normalizeRelayJwk(VALID_JWK)).toEqual(VALID_JWK);
  });

  it('schemes are case-insensitive; hash + trailing slash RUNS stripped on direct; relay path kept', () => {
    const normalize = (candidate: unknown): unknown =>
      normalizePairingPayload({ v: 2, pairingId: 'p', secret: 's', expiresAt: expires(), candidates: [candidate] });
    const firstUrl = (url: string): string => {
      const link = encodePairingConnectionPayload({ pairingId: 'p', secret: SECRET_43, expiresAt: expires(), candidates: [{ type: 'lan', url }] });
      const payload = b64urlDecodePayload(link.slice(link.indexOf('&p=') + 3)) as { candidates: { url: string }[] };
      return payload.candidates[0]!.url;
    };
    expect(firstUrl('HTTP://X:3000/#frag')).toBe('HTTP://X:3000'); // uppercase scheme accepted, case preserved
    expect(firstUrl('https://a///')).toBe('https://a'); // trailing slash RUNS
    expect(firstUrl('https://a/#')).toBe('https://a');
    expect(() => encodePairingConnectionPayload({ pairingId: 'p', secret: SECRET_43, expiresAt: expires(), candidates: [{ type: 'lan', url: 'ftp://x' }] })).toThrow();
    expect(normalize({ type: 'relay', relayUrl: 'ftp://x', serverId: 'srv', hostEncPubJwk: VALID_JWK })).toBeNull();
    const relay = (relayUrl: string, serverId = '  srv  '): { relayUrl: string; serverId?: string; grant?: string } => {
      const payload = normalize({ type: 'relay', relayUrl, serverId, hostEncPubJwk: VALID_JWK, grant: '' }) as { candidates: { relayUrl: string; serverId: string; grant?: string }[] } | null;
      expect(payload).not.toBeNull();
      return payload!.candidates[0]!;
    };
    expect(relay('WSS://rl.example/ws/').relayUrl).toBe('WSS://rl.example/ws/'); // uppercase ws scheme; trailing path PRESERVED (section 5.2)
    expect(relay('ws://x/a#h').relayUrl).toBe('ws://x/a'); // hash stripped, path kept
    expect(relay('wss://x').serverId).toBe('srv'); // trimmed
    expect(relay('wss://x').grant).toBeUndefined(); // empty grant dropped
    expect(normalize({ type: 'relay', relayUrl: 'wss://x', serverId: '   ', hostEncPubJwk: VALID_JWK })).toBeNull();
    const spaced = normalize({ type: 'relay', relayUrl: 'wss://x', serverId: 'srv 1', hostEncPubJwk: VALID_JWK }) as { candidates: { serverId: string }[] } | null;
    expect(spaced!.candidates[0]!.serverId).toBe('srv 1'); // internal space kept
    expect(normalizePairingPayload({ v: 2, pairingId: 'p', secret: 's', expiresAt: expires(), candidates: [null] })).toBeNull(); // not a crash
    expect(normalizePairingPayload({ v: 2, pairingId: 'p', secret: 's', expiresAt: expires(), candidates: [undefined, 5, ['lan']] })).toBeNull();
  });

  it('expiresAt must parse to a future time (exactly-now rejected, non-string rejected)', () => {
    expect(normalizePairingPayload({ v: 2, pairingId: 'p', secret: 's', expiresAt: 'not-a-date', candidates: [{ type: 'lan', url: 'http://x' }] })).toBeNull();
    expect(normalizePairingPayload({ v: 2, pairingId: 'p', secret: 's', expiresAt: new Date(Date.now()).toISOString(), candidates: [{ type: 'lan', url: 'http://x' }] })).toBeNull();
    expect(normalizePairingPayload({ v: 2, pairingId: 'p', secret: 's', expiresAt: 123 as never, candidates: [{ type: 'lan', url: 'http://x' }] })).toBeNull();
  });

  it('the decode helper reads unpadded and padded base64url alike (issuer emits unpadded)', () => {
    const link = encodePairingConnectionPayload({ pairingId: 'p', secret: SECRET_43, expiresAt: expires(), candidates: [{ type: 'lan', url: 'http://x' }] });
    const p = link.slice(link.indexOf('&p=') + 3);
    expect(p).not.toContain('='); // emitted padding-free
    const unpadded = b64urlDecodePayload(p) as { pairingId: string };
    const padded = b64urlDecodePayload(p + '='.repeat((4 - (p.length % 4)) % 4)) as { pairingId: string };
    expect(unpadded.pairingId).toBe('p');
    expect(padded.pairingId).toBe('p');
    expect(() => b64urlDecodePayload('****')).toThrow(); // non-alphabet is garbage, not an empty payload
  });

  it('enforces the 16384 cap on the JSON, on p, AND on the whole link', () => {
    const expISO = expires();
    // Predicted normalized JSON (key order v,pairingId,secret,expiresAt,candidates) for the arithmetic.
    const jsonFor = (url: string): string =>
      `{"v":2,"pairingId":"p","secret":"${SECRET_43}","expiresAt":"${expISO}","candidates":[{"type":"lan","url":"${url}"}]}`;
    const base = jsonFor('http://h/');
    const pad = (target: number): string => `http://h/${'a'.repeat(target - base.length)}`;
    expect(() => encodePairingConnectionPayload({ pairingId: 'p', secret: SECRET_43, expiresAt: expISO, candidates: [{ type: 'lan', url: pad(MAX_PAIRING_PAYLOAD_LENGTH + 4) }] })).toThrow(); // JSON over cap
    const atCapUrl = pad(MAX_PAIRING_PAYLOAD_LENGTH); // JSON exactly at cap
    expect(jsonFor(atCapUrl).length).toBe(MAX_PAIRING_PAYLOAD_LENGTH);
    // JSON fits, but base64url p is ~21845 chars: rejected at the p bound
    expect(() => encodePairingConnectionPayload({ pairingId: 'p', secret: SECRET_43, expiresAt: expISO, candidates: [{ type: 'lan', url: atCapUrl }] })).toThrow();
    // JSON 12264 -> p 16352 -> link 16380: encodes
    const link = encodePairingConnectionPayload({ pairingId: 'p', secret: SECRET_43, expiresAt: expISO, candidates: [{ type: 'lan', url: pad(12264) }] });
    expect(link.length).toBeLessThanOrEqual(MAX_PAIRING_PAYLOAD_LENGTH);
    // JSON 12288 -> p 16384 (at cap) -> link 16412 > cap: still rejected (whole-link bound)
    expect(() => encodePairingConnectionPayload({ pairingId: 'p', secret: SECRET_43, expiresAt: expISO, candidates: [{ type: 'lan', url: pad(12288) }] })).toThrow();
  });
});

describe('remote credential store (doc 08 section 2.7)', () => {
  function freshDir(): string {
    return mkdtempSync(`${tmpdir()}${sep}nnd-clients-`);
  }
  function freshStore(clock: () => number = Date.now): RemoteClientStore {
    return new RemoteClientStore(freshDir(), clock);
  }

  it('returns the plaintext token exactly once and stores hash-only records', () => {
    const store = freshStore();
    const created = store.createClient({ label: 'phone', clientKind: 'mobile', authMethod: 'pairing' });
    expect(created.token.startsWith('oc_client_')).toBe(true);
    const listed = store.listClients();
    expect(JSON.stringify(listed).includes(created.token)).toBe(false); // plaintext never persisted
    const auth = store.authenticateBearerToken(created.token);
    expect(auth.ok === true && auth.clientId === auth.sessionToken).toBe(true); // URL tokens bind to the device record id
    expect(store.authenticateBearerToken('oc_client_zzz').ok).toBe(false); // prefix alone is not a credential
  });

  it('persists atomically across reloads and strict-reads corrupt/junk records', () => {
    const dir = freshDir();
    const store = new RemoteClientStore(dir);
    const created = store.createClient({ label: 'phone', clientKind: 'mobile' });
    const trap: unknown = { id: 'x2', tokenHash: '0'.repeat(64), label: 'trap', revokedAt: null, lastTransport: 'direct', usesRelay: false }; // shape-valid decoy
    writeFileSync(`${dir}/remote-clients.json`, JSON.stringify({ version: 1, clients: [{ id: 'j1' }, created.client, trap] }));
    const reloaded = new RemoteClientStore(dir);
    expect(reloaded.listClients()).toHaveLength(2); // unusable junk dropped, shape-valid decoy kept
    expect(reloaded.authenticateBearerToken(created.token).ok).toBe(true); // hash round-trip
    expect(reloaded.authenticateBearerToken('oc_client_zzz').ok).toBe(false); // no crash, no decoy fallthrough
    expect(readdirSync(dir).filter((name) => name.startsWith('remote-clients.json.tmp-'))).toHaveLength(0); // atomic rename leaves no residue
  });

  it('fails closed on an unparsable issuer expiry (no fail-open resurrection)', () => {
    const store = freshStore();
    const created = store.createClient({ expiresAt: 'not-a-date' });
    expect(store.authenticateBearerToken(created.token).ok).toBe(false);
    expect(store.hasActiveRelayClients()).toBe(false); // the relay-demand signal excludes it too
  });

  it('dedupe-replace keeps the operator label across a name-less rescan', () => {
    const store = freshStore();
    const first = store.createClient({ dedupeKey: 'd1', label: 'Atlas desk', clientKind: 'desktop' });
    const second = store.createClient({ dedupeKey: 'd1', clientKind: 'desktop', fallbackLabel: 'Remote client' });
    expect(second.client.id !== first.client.id).toBe(true); // record replaced
    expect(second.client.label).toBe('Atlas desk'); // explicit > replaced > fallback
    expect(store.listClients()).toHaveLength(1);
  });

  it('dedupe skips revoked twins; revoked residue survives until purge (audit)', () => {
    const store = freshStore();
    const first = store.createClient({ dedupeKey: 'd1', label: 'Atlas', clientKind: 'desktop' });
    store.revokeClient(first.client.id);
    const second = store.createClient({ dedupeKey: 'd1', label: 'Atlas', clientKind: 'desktop' });
    expect(second.client.id !== first.client.id).toBe(true);
    expect(store.listClients()).toHaveLength(2); // revoked twin retained for audit
    expect(store.authenticateBearerToken(first.token).ok).toBe(false);
    store.purgeRevokedClients();
    expect(store.listClients()).toHaveLength(1);
    expect(store.authenticateBearerToken(second.token).ok).toBe(true);
  });

  it('kind-tagged mints clean legacy untagged twins only on dedupe replacement', () => {
    const store = freshStore();
    const legacy = store.createClient({ label: 'Atlas' }); // untagged (pre-dedupe) residue
    expect(store.createClient({ dedupeKey: 'fresh', clientKind: 'desktop', label: 'Atlas' })).toBeTruthy();
    expect(store.listClients()).toHaveLength(2); // no prior twin -> NO cleanup (registered E-08-7)
    const reMint = store.createClient({ dedupeKey: 'fresh', clientKind: 'desktop' }); // label survives via the replaced record
    expect(store.listClients()).toHaveLength(1); // legacy untagged twin cleaned WITH the replacement
    expect(store.authenticateBearerToken(legacy.token).ok).toBe(false); // cleaned -> its token dies
    expect(store.authenticateBearerToken(reMint.token).ok).toBe(true);
  });

  it('a revoked legacy twin stays for audit (cleanup only removes unrevoked)', () => {
    const store = freshStore();
    const prior = store.createClient({ dedupeKey: 'dk', clientKind: 'desktop', label: 'Rev' });
    const legacy = store.createClient({ label: 'Rev' });
    store.revokeClient(legacy.client.id);
    const reMint = store.createClient({ dedupeKey: 'dk', clientKind: 'desktop' });
    const ids = store.listClients().map((client) => client.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(legacy.client.id); // revoked residue stays for audit until purge
    expect(ids).not.toContain(prior.client.id); // replaced
    expect(store.purgeRevokedClients()).toBe(1);
    expect(store.authenticateBearerToken(reMint.token).ok).toBe(true);
  });

  it('ignores non-string label/fallbackLabel/expiresAt instead of crashing', () => {
    const store = freshStore();
    const junked = store.createClient({ label: 42 as never, fallbackLabel: 7 as never, expiresAt: 9 as never, dedupeKey: 'd' });
    expect(junked.client.label).toBe('Remote client');
    expect(junked.client.expiresAt).toBeUndefined();
    expect(store.authenticateBearerToken(junked.token).ok).toBe(true);
  });

  it('writes lastUsedAt once per 60 s per transport, immediately on transport change', () => {
    let clock = 1000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const store = freshStore(() => clock);
    const created = store.createClient({ label: 'phone' });
    expect(created.client.lastUsedAt).toBe(iso(1000));
    clock = 1100;
    const first = store.authenticateBearerToken(created.token);
    expect(first.ok === true && first.client.lastUsedAt === iso(1100)).toBe(true); // first touch writes
    clock = 1200;
    const second = store.authenticateBearerToken(created.token);
    expect(second.ok === true && second.client.lastUsedAt === iso(1100)).toBe(true); // throttled inside the window
    clock = 72_000;
    const third = store.authenticateBearerToken(created.token);
    expect(third.ok === true && third.client.lastUsedAt === iso(72_000)).toBe(true); // window elapsed -> write
    clock = 72_001;
    const relay = store.authenticateBearerToken(created.token, { relayConnection: true });
    expect(relay.ok === true && relay.client.lastTransport === 'relay' && relay.client.lastUsedAt === iso(72_001)).toBe(true); // change -> immediate
    clock = 72_002;
    const relayAgain = store.authenticateBearerToken(created.token, { relayConnection: true });
    expect(relayAgain.ok === true && relayAgain.client.lastUsedAt === iso(72_001)).toBe(true); // throttled again
  });

  it('authenticate rejects revoked/expired/wrong-prefix; relay flag is sticky + demand-signal true', () => {
    let clock = 1000;
    const store = freshStore(() => clock);
    const created = store.createClient({ clientKind: 'mobile' });
    expect(store.authenticateBearerToken('bogus').ok).toBe(false);
    const ok = store.authenticateBearerToken(created.token, { relayConnection: true });
    expect(ok.ok).toBe(true);
    expect(ok.ok === true && ok.client.usesRelay).toBe(true);
    expect(store.hasActiveRelayClients()).toBe(true); // observed transport beats the snapshot
    const directAgain = store.authenticateBearerToken(created.token, { relayConnection: false });
    expect(directAgain.ok === true && directAgain.client.usesRelay).toBe(true); // LAN never clears it
    store.revokeClient(created.client.id);
    store.revokeClient(created.client.id); // idempotent
    expect(store.authenticateBearerToken(created.token).ok).toBe(false);
    expect(store.purgeRevokedClients()).toBe(1);
    expect(store.listClients()).toHaveLength(0);
    clock = 2000;
  });

  it('expired records fail authentication (issuer-set expiries honored)', () => {
    let clock = 1000;
    const store = freshStore(() => clock);
    const created = store.createClient({ clientKind: 'mobile', expiresAt: new Date(1500).toISOString() });
    expect(store.authenticateBearerToken(created.token).ok).toBe(true);
    clock = 1600;
    expect(store.authenticateBearerToken(created.token).ok).toBe(false);
  });
});
