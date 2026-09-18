// SPDX-License-Identifier: Apache-2.0
/**
 * P8-2a gates (doc 08 sections 3.2-3.6): relay identity (strict
 * regeneration gate, serverId formula, IEEE P1363 ECDSA URL auth verified
 * through WebCrypto as the worker would), Layer 2 E2EE (cross-derive,
 * fail-closed frame decrypt: size/version/counter-replay/GCM), handshake
 * message grammar, and the Layer 3 tunnel codec (byte layout,
 * fragmentation bounds, stream ids, payload guards).
 */
import { createHash, webcrypto } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  RelayIdentityStore, publicJwkCanonical, serverIdFromJwk, type RelayJwk,
} from '../lib/relay/identity.ts';
import {
  MAX_PLAINTEXT_FRAME_BYTES, MAX_TUNNEL_PAYLOAD_BYTES, RELAY_PROTOCOL_VERSION, bytesToBase64Url,
  base64UrlToBytes, decodeHandshakeHello, decodeHandshakeReady, decryptFrame, deriveSessionKeys,
  openSession, encodeHandshakeHello, encodeHandshakeReady, encryptFrame, generateEphemeralKeypair,
  publicKeyJwkFingerprint,
} from '../lib/relay/crypto.ts';
import {
  CodecError, HAS_MORE_FLAG, MAX_ASSEMBLED_MESSAGE_BYTES, MAX_PENDING_FRAGMENT_STREAMS,
  TUNNEL_FRAME_HEADER_BYTES, TunnelFrameType, chunkPayload, createFragmentAssembler,
  createStreamIdAllocator, decodeTunnelFrame, encodeFragmentedMessage, encodeJsonPayload,
  encodeTunnelFrame, isHttpRequestPayload, isHttpResponsePayload, isStreamAbortPayload,
  isWsClosePayload, isWsOpenPayload,
} from '../lib/relay/tunnel-codec.ts';

const scratchDirs: string[] = [];
function freshScratch(): string {
  const made = mkdtempSync(`${tmpdir()}${sep}nnd-relay-`);
  scratchDirs.push(made);
  return made;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

describe('relay identity (doc 08 section 3.2)', () => {
  it('absent store mints keys once; reload keeps identity + serverId; corrupt never regenerates', async () => {
    const dir = freshScratch();
    const store = new RelayIdentityStore(dir);
    expect(existsSync(joinPath(dir, 'relay-identity.json'))).toBe(false);
    const identity = await store.resolve();
    expect(existsSync(joinPath(dir, 'relay-identity.json'))).toBe(true);
    const raw = JSON.parse(readFileSync(joinPath(dir, 'relay-identity.json'), 'utf8')) as { version: number };
    expect(raw.version).toBe(1);
    expect((await store.resolve())).toBe(identity); // memoized
    const reloaded = new RelayIdentityStore(dir).resolve();
    expect((await reloaded).signing.publicJwk.x).toBe(identity.signing.publicJwk.x);
    expect((await reloaded).encryption.publicJwk.x).toBe(identity.encryption.publicJwk.x);
    expect(await new RelayIdentityStore(dir).serverId()).toBe(await store.serverId());

    writeFileSync(joinPath(dir, 'relay-identity.json'), '{ version: 1 }');
    const corrupt = new RelayIdentityStore(dir);
    await expect(corrupt.resolve()).rejects.toThrow(/must NOT regenerate/u);
  });

  it('leftover .tmp- mint residue is never read (next boot mints); truncated JSON is corrupt and refuses regeneration', async () => {
    const dir = freshScratch();
    writeFileSync(joinPath(dir, 'relay-identity.json.tmp-999-lastboot'), 'residue of a killed mint');
    const serverId = await new RelayIdentityStore(dir).serverId(); // mint treats presence of residue as ABSENT
    expect(existsSync(joinPath(dir, 'relay-identity.json'))).toBe(true);
    expect(existsSync(joinPath(dir, 'relay-identity.json.tmp-999-lastboot'))).toBe(true); // ignored, not consumed
    expect(await new RelayIdentityStore(dir).serverId()).toBe(serverId);
    writeFileSync(joinPath(dir, 'relay-identity.json'), '{ "version": 1, "signing": { "priva'); // killed mid-write
    await expect(new RelayIdentityStore(dir).resolve()).rejects.toThrow(/must NOT regenerate/u);
  });

  it('concurrent resolve() mints exactly once (shared in-flight promise, one identity)', async () => {
    const store = new RelayIdentityStore(freshScratch());
    const [first, second] = await Promise.all([store.resolve(), store.resolve()]);
    expect(second).toBe(first);
  });

  it('relaySocketUrl preserves the base path/query, replaces duplicate params, and emits sig/pk unencoded', async () => {
    const store = new RelayIdentityStore(freshScratch());
    const url = await store.relaySocketUrl('wss://relay.example/relay/ws?keep=yes&v=9', 'host-control', 9, { appVersion: '1.0', platform: 'web' });
    expect(url.startsWith('wss://relay.example/relay/ws?keep=yes&v=1&role=host-control&')).toBe(true);
    expect((url.match(/[?&]v=1&/gu) ?? []).length).toBe(1); // duplicate v replaced, never appended
    const query = url.slice(url.indexOf('?') + 1);
    expect(/%|\+/.test(query)).toBe(false); // base64url params (sig/pk/serverId) need no percent-encoding (worker parse parity)
    const parsed = new URL(url);
    expect(parsed.searchParams.get('keep')).toBe('yes');
    expect(parsed.searchParams.get('ts')).toBe('9');
    expect(parsed.searchParams.get('appId')).toBe('openchamber');
    const upper = await store.relaySocketUrl('WSs://relay.example/ws', 'client', 10, {});
    expect(upper.startsWith('wss://')).toBe(true); // WHATWG scheme normalization stays worker-parseable
    expect(upper).toContain('role=client');
  });

  it('serverId formula: base64url(sha256(canonical {crv,kty,x,y} JSON)) and key order stability', () => {
    const jwk: RelayJwk = {
      kty: 'EC', crv: 'P-256',
      x: Buffer.from('aaaaaaaa').toString('base64url'),
      y: Buffer.from('bbbbbbbb').toString('base64url'),
      d: 'NEVER-LEAKS',
    };
    const canonical = publicJwkCanonical(jwk);
    expect(Object.keys(canonical)).toStrictEqual(['crv', 'kty', 'x', 'y']);
    expect(canonical.d).toBeUndefined();
    expect(serverIdFromJwk(jwk)).toBe(
      Buffer.from(createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest()).toString('base64url'),
    );
  });

  it('authParams rays the exact signed payload and verifies through WebCrypto (worker parity)', async () => {
    const store = new RelayIdentityStore(freshScratch());
    const serverId = await store.serverId();
    const auth = await store.authParams('host-control', 1_700_000_000_000, 'conn-9');
    expect(auth.ts).toBe(1_700_000_000_000);
    const payload = `${auth.ts}.${serverId}.host-control.conn-9`;
    const pubKey = await webcrypto.subtle.importKey(
      'jwk',
      publicJwkCanonical((await store.resolve()).signing.publicJwk),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const sigBytes = base64UrlToBytes(auth.sig);
    const verify = (body: string): Promise<boolean> =>
      webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, sigBytes, Buffer.from(body, 'utf8'));
    expect(await verify(payload)).toBe(true);
    expect(await verify(`${payload}tamper`)).toBe(false);
    expect(await verify(`${auth.ts}.${serverId}.client.conn-9`)).toBe(false); // role is signed domain
    expect(await verify(`${auth.ts}.${serverId}.host-control.conn-A`)).toBe(false); // connectionId is signed domain
    expect(await verify(`${auth.ts}.${serverId}.host-control.`)).toBe(false); // the empty connId slot is signed
    expect(await verify(`${auth.ts + 1}.${serverId}.host-control.conn-9`)).toBe(false); // ts is signed (fresh-ts mint at connect)

    const bare = await store.authParams('client', 42);
    expect(bare.sig).toHaveLength(86); // 64 B raw r||s -> 86 b64url chars (unpadded)
    const pkJwk = JSON.parse(Buffer.from(bare.pk, 'base64url').toString('utf8')) as Record<string, string>;
    expect(Object.keys(pkJwk).sort()).toStrictEqual(['crv', 'kty', 'x', 'y']);
  });

  it('relaySocketUrl keeps the ws scheme and carries v/role/serverId/ts/sig/pk (+ grant/connectionId)', async () => {
    const store = new RelayIdentityStore(freshScratch());
    const hostControl = await store.relaySocketUrl('wss://relay.example/ws', 'host-control', 5, { appVersion: '9.9.9', platform: 'web' });
    expect(hostControl.startsWith('wss://relay.example/ws?')).toBe(true);
    expect(hostControl).toContain('v=1');
    expect(hostControl).toContain('role=host-control');
    expect(hostControl).toContain(`serverId=${encodeURIComponent(await store.serverId())}`);
    expect(hostControl).toContain('appId=openchamber');
    expect(hostControl).toContain('appVersion=9.9.9');
    expect(hostControl).toContain('platform=web');
    expect(hostControl).toContain('ts=5');
    expect(hostControl).toContain('sig=');
    expect(hostControl).toContain('pk=');
    const requestData = await store.relaySocketUrl('wss://relay.example/ws', 'host-data', 6, { connectionId: 'c1' });
    expect(requestData).toContain('connectionId=c1');
    expect(requestData).toContain('role=host-data');
    const client = await store.relaySocketUrl('ws://relay.example/ws', 'client', 7, { grant: 'g1' });
    expect(client.startsWith('ws://relay.example/ws?')).toBe(true);
    expect(client).toContain('grant=g1');
  });
});

describe('Layer 2 E2EE (doc 08 sections 3.4/3.5)', () => {
  it('cross-derive: both sides reach identical direction keys; frames cross-decrypt', async () => {
    const hostEnc = await generateEphemeralKeypair();
    const clientEph = await generateEphemeralKeypair();
    const nonce = bytesToBase64Url(webcrypto.getRandomValues(new Uint8Array(16)));
    const hostKeys = await deriveSessionKeys(hostEnc.privateJwk, clientEph.publicJwk, nonce);
    const clientKeys = await deriveSessionKeys(clientEph.privateJwk, hostEnc.publicJwk, nonce);
    const host = openSession(hostKeys);
    const client = openSession(clientKeys);

    const frame = await encryptFrame(client.clientToHost, Buffer.from('relay me'));
    const plaintext = Buffer.from(await decryptFrame(host.clientToHost, frame)).toString('utf8');
    expect(plaintext).toBe('relay me');
    expect(client.clientToHost.counter).toBe(2); // +1 per encryption call
    expect(host.clientToHost.lastCounter).toBe(1);

    const back = await encryptFrame(host.hostToClient, Buffer.from('and back'));
    expect(Buffer.from(await decryptFrame(client.hostToClient, back)).toString('utf8')).toBe('and back');
  });

  it('decryptor fails closed: replay/regression, short frames, foreign version, GCM tamper, oversize', async () => {
    const a = await generateEphemeralKeypair();
    const b = await generateEphemeralKeypair();
    const nonce = bytesToBase64Url(webcrypto.getRandomValues(new Uint8Array(16)));
    const keys = openSession(await deriveSessionKeys(a.privateJwk, b.publicJwk, nonce));
    const peer = openSession(await deriveSessionKeys(b.privateJwk, a.publicJwk, nonce));

    const frame = await encryptFrame(keys.clientToHost, Buffer.from('one'));
    expect(Buffer.from(await decryptFrame(peer.clientToHost, frame)).toString('utf8')).toBe('one');
    await expect(decryptFrame(peer.clientToHost, frame)).rejects.toThrow(/replay|regression/u); // same frame replayed

    const short = await encryptFrame(keys.clientToHost, Buffer.from('x'));
    await expect(decryptFrame(peer.clientToHost, short.subarray(0, 20))).rejects.toThrow(/too short/u);

    const foreign = await encryptFrame(keys.clientToHost, Buffer.from('v2'));
    foreign[0] = 2;    await expect(decryptFrame(peer.clientToHost, foreign)).rejects.toThrow(/version/u);

    const tampered = await encryptFrame(keys.clientToHost, Buffer.from('honest'));
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await expect(decryptFrame(peer.clientToHost, tampered)).rejects.toThrow(/GCM/u);

    await expect(encryptFrame(keys.clientToHost, Buffer.alloc(MAX_PLAINTEXT_FRAME_BYTES + 1))).rejects.toThrow(/exceeds/u);
  });

  it('counter exactness: 2^53+ wire counters rejected pre-GCM via BigInt; wire counter 0 replays; in-range junk reaches GCM', async () => {
    const a = await generateEphemeralKeypair();
    const b = await generateEphemeralKeypair();
    const nonce = bytesToBase64Url(webcrypto.getRandomValues(new Uint8Array(16)));
    const keys = openSession(await deriveSessionKeys(a.privateJwk, b.publicJwk, nonce));
    const peer = openSession(await deriveSessionKeys(b.privateJwk, a.publicJwk, nonce));

    const frame = await encryptFrame(keys.clientToHost, Buffer.from('c1'));
    expect(Buffer.from(await decryptFrame(peer.clientToHost, frame)).toString('utf8')).toBe('c1');

    const zeroCounter = Buffer.from(await encryptFrame(keys.clientToHost, Buffer.from('c2')));
    zeroCounter.writeBigUInt64BE(0n, 5);
    await expect(decryptFrame(peer.clientToHost, zeroCounter)).rejects.toThrow(/replay|regression/u); // 0 <= lastCounter

    const outOfRange = Buffer.from(await encryptFrame(keys.clientToHost, Buffer.from('c3')));
    outOfRange.writeBigUInt64BE(BigInt('9007199254740993'), 5); // 2^53 + 1: Number() would collapse it onto 2^53
    await expect(decryptFrame(peer.clientToHost, outOfRange)).rejects.toThrow(/exact range/u);

    const inRange = Buffer.from(await encryptFrame(keys.clientToHost, Buffer.from('c4')));
    inRange.writeBigUInt64BE(42n, 5);
    await expect(decryptFrame(peer.clientToHost, inRange)).rejects.toThrow(/GCM/u); // in-range but unauthenticated -> GCM stage

    expect(peer.clientToHost.lastCounter).toBe(1); // every rejection left the accept state untouched
  });

  it('handshake grammar: reduced JWK, capabilities only when true, foreign/junk decode refuses', () => {
    const pubJwk: RelayJwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43), d: 'PRIVATE' };
    const hello = decodeHandshakeHello(encodeHandshakeHello({ clientPubJwk: pubJwk, nonceB64url: 'nonce-byte16-enc', batch: true }));
    expect(hello).not.toBeNull();
    expect(hello!.clientPubJwk.d).toBeUndefined(); // reductio d never crosses the wire
    const helloAgain = decodeHandshakeHello(encodeHandshakeHello({ clientPubJwk: pubJwk, nonceB64url: 'n2', flowControl: true }));
    expect(helloAgain?.batch).toBe(false);
    expect(helloAgain?.flowControl).toBe(true);
    expect(decodeHandshakeHello(Buffer.from('{"t":"hello","v":2}'))).toBeNull(); // foreign version
    expect(decodeHandshakeHello(Buffer.from('not json'))).toBeNull();
    expect(decodeHandshakeReady(encodeHandshakeReady({ batch: true, flowControl: true }))).toMatchObject({ t: 'ready', batch: true, flowControl: true });
    expect(decodeHandshakeReady(Buffer.from('{"t":"ready","v":9}'))).toBeNull();
    expect(publicKeyJwkFingerprint(pubJwk)).toBe(JSON.stringify({ crv: 'P-256', kty: 'EC', x: pubJwk.x, y: pubJwk.y }));
    expect(() => base64UrlToBytes('A')).toThrow(/length/u);
    expect(Buffer.from(bytesToBase64Url(Buffer.from('ok'))).toString('utf8')).toBe('b2s');
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
  });
});

describe('Layer 3 tunnel codec (doc 08 sections 3.6)', () => {
  it('byte-exact frame layout: 1B type|flag + 4B BE streamId + payload', () => {
    const frame = encodeTunnelFrame({ type: TunnelFrameType.HttpRequest, streamId: 7, hasMore: false, payload: encodeJsonPayload({ method: 'POST' }) });
    expect(frame.length).toBe(TUNNEL_FRAME_HEADER_BYTES + encodeJsonPayload({ method: 'POST' }).length); // header + raw payload passthrough
    expect(frame.readUInt8(0)).toBe(1);
    expect(frame.readUInt32BE(1)).toBe(7);
    const decoded = decodeTunnelFrame(frame);
    expect(decoded.type).toBe(TunnelFrameType.HttpRequest);
    expect(decoded.streamId).toBe(7);
    expect(decoded.hasMore).toBe(false);
    const frag = encodeTunnelFrame({ type: TunnelFrameType.WsBinary, streamId: 2, hasMore: true, payload: Buffer.from('part') });
    expect(frag.readUInt8(0)).toBe(TunnelFrameType.WsBinary | HAS_MORE_FLAG);
    expect(decodeTunnelFrame(frag).hasMore).toBe(true);
    expect(() => decodeTunnelFrame(Buffer.from([1, 2, 3]))).toThrow(CodecError);
  });

  it('fragmentation: chunked WS text reassembles byte-exact; empty body yields ONE empty chunk', () => {
    const payload = Buffer.from('x'.repeat(64 * 1024 - 10));
    const frames = encodeFragmentedMessage(TunnelFrameType.WsText, 3, payload, 1024);
    const assembler = createFragmentAssembler();
    const collected: Buffer[] = [];
    for (const frame of frames) {
      const out = assembler.push(decodeTunnelFrame(frame));
      if (out !== null) collected.push(Buffer.from(out.payload));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]!.toString('utf8')).toBe(payload.toString('utf8'));
    expect(encodeFragmentedMessage(TunnelFrameType.WsText, 3, Buffer.alloc(0), 1024)).toHaveLength(1);
    expect(() => encodeFragmentedMessage(TunnelFrameType.Ping, 0, Buffer.alloc(0), 1024)).toThrow(/fragment/u);
  });

  it('chunking budget: chunk sizes are bounded by MAX_TUNNEL_PAYLOAD_BYTES and must be positive safe integers', () => {
    expect(MAX_TUNNEL_PAYLOAD_BYTES).toBe(64 * 1024 - 10); // §3.5: 64 KiB minus 5B tunnel header minus 5B batch envelope
    expect(chunkPayload(Buffer.alloc(100), MAX_TUNNEL_PAYLOAD_BYTES)).toHaveLength(1);
    expect(() => chunkPayload(Buffer.alloc(100), MAX_TUNNEL_PAYLOAD_BYTES + 1)).toThrow(/budget/u);
    expect(() => chunkPayload(Buffer.alloc(100), 2.5)).toThrow(/integer/u);
    expect(() => chunkPayload(Buffer.alloc(100), 0)).toThrow(/integer/u);
    expect(() => chunkPayload(Buffer.alloc(100), -8)).toThrow(/integer/u);
    const frames = encodeFragmentedMessage(TunnelFrameType.WsBinary, 5, Buffer.alloc(3 * MAX_TUNNEL_PAYLOAD_BYTES), MAX_TUNNEL_PAYLOAD_BYTES);
    expect(frames.map((frame) => decodeTunnelFrame(frame).hasMore)).toStrictEqual([true, true, false]);
    expect(encodeFragmentedMessage(TunnelFrameType.WsText, 5, Buffer.alloc(0), MAX_TUNNEL_PAYLOAD_BYTES)).toHaveLength(1);
  });

  it('assembler hardening: final chunk counts into the 16 MiB bound; partial groups bounded; reset frees slots', () => {
    const holeClosed = createFragmentAssembler();
    const nearlyFull = MAX_ASSEMBLED_MESSAGE_BYTES - 10;
    expect(holeClosed.push({ type: TunnelFrameType.WsText, streamId: 1, hasMore: true, payload: Buffer.alloc(nearlyFull) })).toBeNull();
    expect(() => holeClosed.push({ type: TunnelFrameType.WsText, streamId: 1, hasMore: false, payload: Buffer.alloc(20) })).toThrow(/exceeds/u);

    const exact = createFragmentAssembler();
    expect(exact.push({ type: TunnelFrameType.WsText, streamId: 9, hasMore: true, payload: Buffer.alloc(nearlyFull) })).toBeNull();
    const done = exact.push({ type: TunnelFrameType.WsText, streamId: 9, hasMore: false, payload: Buffer.alloc(10) });
    expect(done?.payload).toHaveLength(MAX_ASSEMBLED_MESSAGE_BYTES); // exactly on the bound is legal

    const flooded = createFragmentAssembler();
    for (let stream = 1; stream <= MAX_PENDING_FRAGMENT_STREAMS; stream += 1) {
      expect(flooded.push({ type: TunnelFrameType.WsText, streamId: stream, hasMore: true, payload: Buffer.alloc(0) })).toBeNull();
    }
    expect(() => flooded.push({ type: TunnelFrameType.WsText, streamId: MAX_PENDING_FRAGMENT_STREAMS + 1, hasMore: true, payload: Buffer.alloc(0) })).toThrow(/partial fragment groups/u);
    expect(flooded.push({ type: TunnelFrameType.WsText, streamId: 1, hasMore: true, payload: Buffer.alloc(1) })).toBeNull(); // existing group still appends at cap
    flooded.reset(3);
    expect(flooded.push({ type: TunnelFrameType.WsText, streamId: 3, hasMore: true, payload: Buffer.alloc(0) })).toBeNull(); // reset freed a slot
    flooded.reset();
    expect(flooded.push({ type: TunnelFrameType.WsText, streamId: MAX_PENDING_FRAGMENT_STREAMS + 1, hasMore: true, payload: Buffer.alloc(0) })).toBeNull();
  });

  it('assembler bounds: >16MiB fails; non-fragmentable fragmented frames fail; allocator is odd', () => {
    const assembler = createFragmentAssembler();
    const big = Buffer.alloc(1024 * 1024, 7);
    expect(() => {
      for (let index = 0; index < 17; index++) {
        assembler.push(decodeTunnelFrame(encodeTunnelFrame({ type: TunnelFrameType.WsBinary, streamId: 1, hasMore: true, payload: big })));
      }
    }).toThrow(/exceeds/u);

    const hard = createFragmentAssembler();
    expect(() => hard.push({ type: TunnelFrameType.HttpRequest, streamId: 9, hasMore: true, payload: Buffer.alloc(0) })).toThrow(/fragment/u);
    const allocator = createStreamIdAllocator();
    expect(allocator.next()).toBe(1);
    expect(allocator.next()).toBe(3);
    expect(allocator.next()).toBe(5);
    expect(createStreamIdAllocator(40).next()).toBe(41); // even start bumps to odd
  });

  it('payload guards accept the doc shapes and refuse junk', () => {
    expect(isHttpRequestPayload({ method: 'POST', path: '/api/session', query: {}, headers: {} })).toBe(true);
    expect(isHttpRequestPayload({ method: 3, path: '/x', query: {}, headers: {} })).toBe(false);
    expect(isHttpRequestPayload({ method: 'POST', path: '/x', query: { a: 1 }, headers: {} })).toBe(false);
    expect(isHttpResponsePayload({ status: 200, headers: { 'content-type': 'text/plain' } })).toBe(true);
    expect(isHttpResponsePayload({ status: '200', headers: {} })).toBe(false);
    expect(isStreamAbortPayload({ reason: 'gone' })).toBe(true);
    expect(isWsOpenPayload({ path: '/api/event/ws', protocols: [] })).toBe(true);
    expect(isWsOpenPayload({ path: '/x', protocols: [3] })).toBe(false);
    expect(isWsClosePayload({ code: 1000, reason: 'done' })).toBe(true);
    expect(isWsClosePayload({ code: '1000' })).toBe(false);
    // E-08-24 strictness: status is an integer in the real HTTP range
    expect(isHttpResponsePayload({ status: 99, headers: {} })).toBe(false);
    expect(isHttpResponsePayload({ status: 600, headers: {} })).toBe(false);
    expect(isHttpResponsePayload({ status: 300.5, headers: {} })).toBe(false);
    expect(isHttpResponsePayload({ status: 100, headers: {} })).toBe(true);
    expect(isHttpResponsePayload({ status: 599, headers: {} })).toBe(true);
    // hasBody optional but boolean when present
    expect(isHttpRequestPayload({ method: 'POST', path: '/x', query: {}, headers: {}, hasBody: 'yes' })).toBe(false);
    expect(isHttpRequestPayload({ method: 'POST', path: '/x', query: {}, headers: {}, hasBody: true })).toBe(true);
    // WsClose code must be a WS-grade integer; reason a string when present
    expect(isWsClosePayload({ code: Number.NaN })).toBe(false);
    expect(isWsClosePayload({ code: 1000, reason: 7 })).toBe(false);
    expect(isWsClosePayload({ code: 1012 })).toBe(true);
  });
});
