// SPDX-License-Identifier: Apache-2.0
// Relay client contract unit tests (doc 08 §3.4–§3.8, §3.10): bytes,
// Layer 2/3 codec parity, handshake grammar, broker client URL, ack
// ledger cadence, and ambiguous-transport tagging.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  bytesToBase64Url, base64UrlToBytes, u8Concat, u8ReadUInt32BE, u8WriteUInt32BE, utf8Bytes, utf8Text,
} from '../bytes.ts';
import {
  decryptFrame, deriveSessionKeys, decodeHandshakeHello, decodeHandshakeReady, encodeHandshakeHello,
  encodeHandshakeReady, encryptFrame, generateEphemeralKeypair, openSession, randomNonceB64url,
} from '../crypto.ts';
import {
  chunkPayload, createFragmentAssembler, createStreamIdAllocator, decodeFrameOrContainer, decodeTunnelFrame,
  encodeFragmentedMessage, encodeJsonPayload, encodeTunnelFrame, isHttpRequestPayload, isHttpResponsePayload,
  isWsClosePayload, parseJsonPayload, TunnelFrameType,
} from '../tunnel-codec.ts';
import { createClientInitiator, negotiate } from '../handshake.ts';
import { buildClientRelaySocketUrl, tunnelPathOf, wsUrlToTunnelPath } from '../tunnel-payloads.ts';
import { createAckLedger } from '../tunnel-acks.ts';
import { isAmbiguousTransportFailure, markAmbiguousTransportFailure } from '../transport-error.ts';
import { MAX_TUNNEL_PAYLOAD_BYTES } from '../crypto.ts';
import { HAS_MORE_FLAG, CLIENT_FIRST_STREAM_ID } from '../protocol.ts';

const hexOf = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

describe('relay bytes', () => {
  it('base64url matches the Node codec both directions', () => {
    for (let round = 0; round < 100; round += 1) {
      const bytes = randomBytes(1 + (round % 64));
      const expected = bytes.toString('base64url');
      expect(bytesToBase64Url(new Uint8Array(bytes))).toBe(expected);
      expect(hexOf(base64UrlToBytes(expected))).toBe(bytes.toString('hex'));
    }
  });

  it('base64url decodes the standard alphabet and tolerates padding', () => {
    const padded = Buffer.from('relay!!').toString('base64url');
    const standard = Buffer.from('relay!!').toString('base64').replaceAll('+', '-').replaceAll('/', '_');
    expect(base64UrlToBytes(`${standard}==`)).toEqual(base64UrlToBytes(padded));
  });

  it('u8 helpers round-trip 32-bit big-endian words', () => {
    const bytes = new Uint8Array(12);
    u8WriteUInt32BE(bytes, 0xdeadbeef, 0);
    u8WriteUInt32BE(bytes, 7, 4);
    expect(u8ReadUInt32BE(bytes, 0)).toBe(0xdeadbeef);
    expect(u8ReadUInt32BE(bytes, 4)).toBe(7);
    expect(u8Concat([bytes.subarray(0, 4), bytes.subarray(4, 8)])).toEqual(bytes.subarray(0, 8));
  });

  it('utf8 helpers survive multibyte round trips', () => {
    const text = 'relay→π🐉';
    expect(utf8Text(utf8Bytes(text))).toBe(text);
  });
});

describe('relay layer 2 (E2EE)', () => {
  it('hello/ready grammar encodes the exact wire shapes', () => {
    const hello = JSON.parse(utf8Text(encodeHandshakeHello({
      clientPubJwk: { kty: 'EC', crv: 'P-256', x: 'xv', y: 'yv' },
      nonceB64url: 'nOnce_-abc',
      batch: true,
      flowControl: true,
    }))) as Record<string, unknown>;
    expect(hello).toEqual({ t: 'hello', v: 1, clientPubJwk: { kty: 'EC', crv: 'P-256', x: 'xv', y: 'yv' }, nonce: 'nOnce_-abc', batch: true, flowControl: true });
    const parsed = decodeHandshakeHello(encodeHandshakeHello({
      clientPubJwk: { kty: 'EC', crv: 'P-256', x: 'xv', y: 'yv' },
      nonceB64url: 'n1', batch: true, flowControl: true,
    }));
    expect(parsed?.t).toBe('hello');
    expect(parsed?.batch).toBe(true);
    expect(decodeHandshakeHello(utf8Bytes('{"t":"hello","v":2}'))).toBeNull();
    expect(decodeHandshakeReady(encodeHandshakeReady({ batch: true }))).toEqual({ t: 'ready', batch: true, flowControl: false });
  });

  it('E2EE round trips and rejects regression/replay and junk', async () => {
    const alice = await generateEphemeralKeypair();
    const bob = await generateEphemeralKeypair();
    const nonce = randomNonceB64url();
    const aliceKeys = await deriveSessionKeys(alice.privateJwk, bob.publicJwk, nonce);
    const bobKeys = await deriveSessionKeys(bob.privateJwk, alice.publicJwk, nonce);
    const a = openSession(aliceKeys);
    const b = openSession(bobKeys);
    const plain = utf8Bytes('relay frame payload');
    const frame = await encryptFrame(a.clientToHost, plain);
    expect(frame.length).toBe(1 + 12 + plain.length + 16);
    expect(new TextDecoder().decode(await decryptFrame(b.clientToHost, frame))).toBe('relay frame payload');
    await expect(decryptFrame(b.clientToHost, frame)).rejects.toThrow(/counter regression or replay|counter/);
    const second = await encryptFrame(a.clientToHost, plain);
    await expect(decryptFrame(b.clientToHost, second.subarray(0, 10))).rejects.toThrow(/too short/);
    const badVersion = await encryptFrame(a.clientToHost, plain);
    const reVersioned = new Uint8Array(badVersion);
    reVersioned[0] = 2;
    await expect(decryptFrame(b.clientToHost, reVersioned)).rejects.toThrow(/unsupported encrypted frame version/);
  });
});

describe('relay layer 3 codec', () => {
  const frameOf = (type: number, streamId: number, payload: string, hasMore = false): Uint8Array =>
    encodeTunnelFrame({ type, streamId, hasMore, payload: utf8Bytes(payload) });

  it('frame encode/decode is the 5-byte header contract', () => {
    const bytes = frameOf(TunnelFrameType.HttpRequest, 3, 'HEAD', true);
    expect(Array.from(bytes.subarray(0, 5))).toEqual([TunnelFrameType.HttpRequest | HAS_MORE_FLAG, 0, 0, 0, 3]);
    const frame = decodeTunnelFrame(bytes);
    expect(frame.type).toBe(TunnelFrameType.HttpRequest);
    expect(frame.streamId).toBe(3);
    expect(frame.hasMore).toBe(true);
    expect(utf8Text(frame.payload)).toBe('HEAD');
  });

  it('stream id allocator issues odd ids from 1', () => {
    const allocator = createStreamIdAllocator();
    expect(allocator.next()).toBe(CLIENT_FIRST_STREAM_ID);
    expect(allocator.next()).toBe(3);
    expect(allocator.next()).toBe(5);
  });

  it('chunk payload enforces the encrypted-plaintext budget and empty-body truth', () => {
    expect(() => chunkPayload(new Uint8Array(10), MAX_TUNNEL_PAYLOAD_BYTES + 1)).toThrow(/budget/);
    expect(() => chunkPayload(new Uint8Array(10), 0)).toThrow(/positive/);
    const empty = chunkPayload(new Uint8Array(0), MAX_TUNNEL_PAYLOAD_BYTES);
    expect(empty.length).toBe(1);
    expect(empty[0]?.length).toBe(0);
    const body = new Uint8Array(MAX_TUNNEL_PAYLOAD_BYTES + 1);
    body[MAX_TUNNEL_PAYLOAD_BYTES] = 1;
    const chunks = chunkPayload(body, MAX_TUNNEL_PAYLOAD_BYTES);
    expect(chunks.length).toBe(2);
    expect(chunks[1]?.length).toBe(1);
  });

  it('WS fragmentation flags every frame but the last and refuses other types', () => {
    const payload = utf8Bytes('abcdefgh');
    const frames = encodeFragmentedMessage(TunnelFrameType.WsText, 7, payload, 3);
    expect(frames.map((bytes) => decodeTunnelFrame(bytes).hasMore)).toEqual([true, true, false]);
    const joined = u8Concat(frames.map((bytes) => decodeTunnelFrame(bytes).payload));
    expect(utf8Text(joined)).toBe('abcdefgh');
    expect(() => encodeFragmentedMessage(TunnelFrameType.HttpRequest, 1, payload, 8)).toThrow(/fragment/);
  });

  it('fragment assembler reassembles per stream/type with bounds', () => {
    const assembler = createFragmentAssembler();
    expect(assembler.push({ type: TunnelFrameType.WsText, streamId: 5, hasMore: true, payload: utf8Bytes('hel') })).toBeNull();
    const done = assembler.push({ type: TunnelFrameType.WsText, streamId: 5, hasMore: false, payload: utf8Bytes('lo') });
    expect(utf8Text(done?.payload ?? new Uint8Array())).toBe('hello');
    expect(() => assembler.push({ type: TunnelFrameType.HttpBody, streamId: 5, hasMore: true, payload: new Uint8Array(4) })).toThrow(/non-fragmentable/);
    assembler.reset();
  });

  it('fragment assembler caps 16 MiB messages and distinct partial groups', () => {
    const assembler = createFragmentAssembler();
    const cap = 16 * 1024 * 1024;
    const chunkSize = MAX_TUNNEL_PAYLOAD_BYTES;
    // Full-size fragments stay legal while the accumulated bytes fit; the
    // overflow trips the cap counting the final chunk too.
    let pushedBytes = 0;
    while (pushedBytes + chunkSize <= cap) {
      expect(assembler.push({
        type: TunnelFrameType.WsBinary, streamId: 9, hasMore: true,
        payload: new Uint8Array(chunkSize).fill(1),
      })).toBeNull();
      pushedBytes += chunkSize;
    }
    const tail = new Uint8Array(cap - pushedBytes + 1).fill(2);
    expect(() => assembler.push({ type: TunnelFrameType.WsBinary, streamId: 9, hasMore: false, payload: tail })).toThrow(/exceeds/);
  });

  it('batch container demux keeps singles, envelopes, and bare-frame fallback straight', () => {
    const bodyFrame = frameOf(TunnelFrameType.HttpBody, 5, 'chunk');
    expect(decodeFrameOrContainer(u8Concat([new Uint8Array([0]), bodyFrame]))?.kind).toBe('single');
    const batch = u8Concat([
      new Uint8Array([1]),
      (() => { const head = new Uint8Array(4); const f = bodyFrame; head[3] = f.length; return u8Concat([head, f]) as Uint8Array; })(),
      (() => { const f = frameOf(TunnelFrameType.WsText, 7, 'hi'); const head = new Uint8Array(4); head[3] = f.length; return u8Concat([head, f]) as Uint8Array; })(),
    ]);
    const decodedBatch = decodeFrameOrContainer(batch);
    expect(decodedBatch?.kind).toBe('batch');
    if (decodedBatch !== null && decodedBatch.kind === 'batch') {
      expect(utf8Text(decodedBatch.frames[1]?.payload ?? new Uint8Array())).toBe('hi');
    }
    const bare = frameOf(TunnelFrameType.HttpRequest, 1, '{}');
    const bareDecoded = decodeFrameOrContainer(bare);
    expect(bareDecoded?.kind).toBe('single'); // the 0x01 header byte stays a BARE HttpRequest frame
    const decodedBare = decodeFrameOrContainer(u8Concat([new Uint8Array([1]), bare.subarray(0, 0)] as Uint8Array[]));
    expect(decodedBare).toBeNull();
    expect(decodeFrameOrContainer(new Uint8Array([0, 1, 2]))).toBeNull();
  });

  it('payload guards refuse hostile shapes', () => {
    expect(isHttpResponsePayload(JSON.parse('{"status":600,"headers":{}}'))).toBe(false);
    expect(isHttpResponsePayload(JSON.parse('{"status":204,"headers":{}}'))).toBe(true);
    expect(isWsClosePayload(JSON.parse('{"code":"NaN"}'))).toBe(false);
    expect(isWsClosePayload(JSON.parse('{"code":1000,"reason":"x"}'))).toBe(true);
    expect(isHttpRequestPayload(JSON.parse('{"method":"GET","path":"/api","query":{},"headers":{}}'))).toBe(true);
    expect(JSON.parse(JSON.stringify(parseJsonPayload(encodeJsonPayload({ status: 200, headers: {} }), isHttpResponsePayload)))).toEqual({ status: 200, headers: {} });
  });
});

describe('relay handshake initiator', () => {
  it('re-sends the identical hello and settles on the first ready', async () => {
    const host = await generateEphemeralKeypair();
    const sends: string[] = [];
    let established: { capabilities: { batch: boolean; flowControl: boolean }; helloText: Uint8Array } | null = null;
    const initiator = createClientInitiator({
      hostEncPublicJwk: host.publicJwk,
      capabilities: { batch: true, flowControl: true },
      sendText: (bytes) => { sends.push(utf8Text(bytes)); },
      onClose: () => undefined,
      onEstablished: (est) => { established = { capabilities: est.capabilities, helloText: est.helloText }; },
      helloRetryMs: 20,
      helloTimeoutMs: 5000,
    });
    await initiator.start();
    expect(sends[0]).toContain('"t":"hello"');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sends.length).toBeGreaterThanOrEqual(2);
    expect(sends[sends.length - 1]).toBe(sends[0]); // the IDENTICAL hello re-sent
    const ready = encodeHandshakeReady({ batch: true, flowControl: true });
    await initiator.onText(ready);
    expect(established).not.toBeNull();
    const settled = established as unknown as { capabilities: { batch: boolean; flowControl: boolean }; helloText: Uint8Array };
    expect(settled.capabilities.batch).toBe(true);
    expect(settled.capabilities.flowControl).toBe(true);
    expect(utf8Text(settled.helloText ?? new Uint8Array())).toBe(sends[0]);
    const beforeCount = sends.length;
    await initiator.onText(ready); // duplicate ready is ignored
    expect(sends.length).toBe(beforeCount);
    initiator.stop();
  });

  it('capabilities negotiate only when both peers advertise', () => {
    const readyBare = decodeHandshakeReady(encodeHandshakeReady({})) ?? { t: 'ready' as const, batch: false, flowControl: false };
    expect(negotiate({ batch: true, flowControl: true }, readyBare)).toEqual({ batch: false, flowControl: false });
    const readyBoth = decodeHandshakeReady(encodeHandshakeReady({ batch: true, flowControl: true })) as { t: 'ready' } & Parameters<typeof negotiate>[1];
    expect(negotiate({ batch: true, flowControl: true }, readyBoth)).toEqual({ batch: true, flowControl: true });
  });

  it('the initiator closes 1011 on the handshake deadline', async () => {
    const host = await generateEphemeralKeypair();
    let closed: { code: number; reason: string } | null = null;
    const initiator = createClientInitiator({
      hostEncPublicJwk: host.publicJwk,
      capabilities: { batch: false, flowControl: false },
      sendText: () => undefined,
      onClose: (code, reason) => { closed = { code, reason }; },
      onEstablished: () => undefined,
      helloRetryMs: 10,
      helloTimeoutMs: 30,
    });
    await initiator.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const settledClose = closed as { code: number; reason: string } | null;
    expect(settledClose).not.toBeNull();
    expect(settledClose?.code).toBe(1011);
    expect(settledClose?.reason).toBe('relay handshake timeout');
  });
});

describe('relay client URL + paths', () => {
  it('client leg URL carries the exact broker params', () => {
    const url = new URL(buildClientRelaySocketUrl('wss://relay.example.test/ws', {
      serverId: 'sid123',
      grant: 'g1',
      appVersion: '9',
      platform: 'web',
    }));
    expect(url.searchParams.get('v')).toBe('1');
    expect(url.searchParams.get('role')).toBe('client');
    expect(url.searchParams.get('serverId')).toBe('sid123');
    expect(url.searchParams.get('appId')).toBe('openchamber');
    expect(url.searchParams.get('appVersion')).toBe('9');
    expect(url.searchParams.get('platform')).toBe('web');
    expect(url.searchParams.get('grant')).toBe('g1');
    const noPath = new URL(buildClientRelaySocketUrl('ws://127.0.0.1:8907', { serverId: 's' }));
    expect(noPath.pathname).toBe('/ws');
    expect(new URL(buildClientRelaySocketUrl('wss://relay.test/ws', { serverId: 's' })).searchParams.get('grant')).toBeNull();
  });

  it('tunnel path extraction keeps queries byte-faithful', () => {
    expect(tunnelPathOf('/api/config?x=1&y=rel a')).toBe('/api/config?x=1&y=rel%20a');
    const absolute = new URL('https://host.example/api/event?l=3');
    expect(tunnelPathOf(absolute.href)).toBe('/api/event?l=3');
    expect(wsUrlToTunnelPath('wss://x.test/api/terminal/ws?k=v')).toBe('/api/terminal/ws?k=v');
    expect(wsUrlToTunnelPath('/api/terminal/ws')).toBe('/api/terminal/ws');
  });
});

describe('relay ack ledger', () => {
  it('inline flush over the threshold, tail timer for the residue, stream zero excluded', async () => {
    const acks: Uint8Array[] = [];
    const ledger = createAckLedger({
      sendAck: (payload) => { acks.push(payload); },
      ackInlineThresholdBytes: 100,
      tailTimerMs: 5,
    });
    ledger.noteFrame({ type: TunnelFrameType.HttpBody, streamId: 3, hasMore: false, payload: new Uint8Array(40) }); // 45 raw
    ledger.noteFrame({ type: TunnelFrameType.Ping, streamId: 0, hasMore: false, payload: new Uint8Array(40) }); // keepalive: uncounted
    ledger.noteFrame({ type: TunnelFrameType.HttpBody, streamId: 3, hasMore: false, payload: new Uint8Array(40) }); // 45 raw
    ledger.afterBatch(); // 90 < 100: tail armed, nothing flushed
    expect(acks.length).toBe(0);
    expect(ledger.stats().tailArmed).toBe(true);
    ledger.noteFrame({ type: TunnelFrameType.HttpBody, streamId: 5, hasMore: false, payload: new Uint8Array(20) }); // 25 raw
    ledger.afterBatch(); // 115 >= 100: inline flush now
    expect(acks.length).toBe(1);
    expect(acks[0]?.length).toBe(8);
    const ackView = new DataView(acks[0]!!.buffer, acks[0]!!.byteOffset, 8);
    expect(Number(ackView.getBigUint64(0))).toBe(115);
    expect(ledger.stats().receivedBytes).toBe(115);
    expect(ledger.stats().acknowledged).toBe(115);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(acks.length).toBe(1); // tail timer flushed nothing new
    ledger.reset();
    expect(ledger.stats().receivedBytes).toBe(0);
    expect(ledger.stats().acknowledged).toBe(0);
    ledger.dispose();
  });
});

describe('ambiguous transport tagging', () => {
  it('flags are fresh, non-enumerable, and detectable', () => {
    const base = new Error('stream died');
    expect(Object.keys(base)).not.toContain('__openchamberAmbiguousTransport');
    const tagged = markAmbiguousTransportFailure(base);
    expect(isAmbiguousTransportFailure(tagged)).toBe(true);
    expect(isAmbiguousTransportFailure(new Error('plain'))).toBe(false);
    expect(Object.keys(Object.assign({}, base))).not.toContain('__openchamberAmbiguousTransport');
  });
});
