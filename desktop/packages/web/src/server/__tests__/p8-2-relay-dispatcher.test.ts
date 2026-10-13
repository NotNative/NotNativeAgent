// SPDX-License-Identifier: Apache-2.0
/**
 * P8-2c gates (doc 08 sections 3.5-3.9 host side): batch container codec
 * + outbound batcher (buffered types, setup-frame flush, leading edge,
 * caps), downstream scheduler (credit window, ack validation strictness,
 * stream-zero bypass, cancel), and the host dispatcher (loopback forward
 * + stream-back, path allowlists, buffered-body semantics incl. loss/
 * deadline/512 KiB live switch, WS sub-streams w/ fragments + clamped
 * closes, duplicate-stream aborts, Ping/Pong, DeliveryAck window lift).
 */
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BATCH_BUFFERED_TYPES, createOutboundFrameBatcher, decodeBatchContainer, encodeBatchContainer,
} from '../lib/relay/batch.ts';
import { createDownstreamScheduler, INITIAL_WINDOW_BYTES } from '../lib/relay/downstream.ts';
import {
  createTunnelHost, isAllowedRelayHttpPath, BODY_BUFFER_MAX_BYTES,
} from '../lib/relay/dispatcher.ts';
import { isAllowedRelayWebSocketPath, type RelayHostSocketLike } from '../lib/relay/dispatcher-ws.ts';
import {
  TunnelFrameType, CodecError, chunkPayload, decodeTunnelFrame, encodeTunnelFrame, encodeJsonPayload, encodeFragmentedMessage,
  type TunnelFrame,
} from '../lib/relay/tunnel-codec.ts';

const servers: http.Server[] = [];
afterAll(async () => {
  for (const server of servers) {
    server.closeIdleConnections?.(); // pooled keepalive sockets never block the hook
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function frame(type: number, streamId: number, payload: Buffer, hasMore = false): TunnelFrame {
  return { type, streamId, hasMore, payload };
}

/** §3.8 DeliveryAck payload: 8B BE cumulative raw frame bytes. */
function toAck(count: number): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeBigUInt64BE(BigInt(count), 0);
  return payload;
}

function requestHead(overrides?: Partial<Record<string, unknown>>): TunnelFrame {
  const head = {
    method: 'GET',
    path: '/api/echo-check',
    query: {},
    headers: { 'content-type': 'text/plain' },
    ...(overrides ?? {}),
  } as {
    method: string; path: string; query: Record<string, string>; headers: Record<string, string>; hasBody?: boolean;
  };
  return frame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload(head));
}

function frameOf(frameDef: TunnelFrame): Buffer {
  return encodeTunnelFrame(frameDef);
}

describe('channel batching (doc 08 section 3.7)', () => {
  it('container codec: single 0x00, inner N-frame 0x01, truncation/foreign tags refuse', () => {
    const one = encodeTunnelFrame(frame(TunnelFrameType.Pong, 0, Buffer.alloc(0)));
    const single = encodeBatchContainer([one]);
    expect(single.readUInt8(0)).toBe(0x00);
    expect(decodeBatchContainer(single)).toMatchObject({ kind: 'single', frame: one });
    const two = encodeBatchContainer([one, frameOf(frame(TunnelFrameType.HttpBody, 1, Buffer.from('x')))]);
    expect(two.readUInt8(0)).toBe(0x01);
    const decoded = decodeBatchContainer(two);
    expect(decoded !== null && decoded.kind === 'batch' ? decoded.frames.length : 0).toBe(2);
    expect(decodeBatchContainer(two.subarray(0, 3))).toBeNull(); // truncate
    expect(decodeBatchContainer(Buffer.from([0x02, 0]))).toBeNull(); // foreign tag
  });

  it('batcher: only payload types buffer; setup frames flush first; leading edge ships instantly', async () => {
    const sent: Buffer[] = [];
    const batcher = createOutboundFrameBatcher(async (bytes) => { sent.push(bytes); }, { windowMs: 50 });
    const bodyPayload = Buffer.from('chunk-one');
    await batcher.offer(frame(TunnelFrameType.HttpBody, 1, bodyPayload));
    expect(sent).toHaveLength(0); // buffered within the trailing window
    expect(BATCH_BUFFERED_TYPES.has(TunnelFrameType.WsText)).toBe(true);
    await batcher.offer(frame(TunnelFrameType.HttpResponse, 1, Buffer.from('{}'))); // setup frame
    expect(sent).toHaveLength(2); // buffered body flushed OUT FIRST, then the setup frame alone
    const decoded = decodeBatchContainer(sent[0]!);
    expect(decoded !== null && decoded.kind === 'single' ? decoded.frame.length : 0).toBeGreaterThan(0);
    expect(sent[1]!.readUInt8(0)).toBe(TunnelFrameType.HttpResponse);
    await batcher.offer(frame(TunnelFrameType.WsText, 2, Buffer.from('right now')));
    await batcher.flush(); // explicit flush ships the buffered piece (batch of 1)
    expect(sent).toHaveLength(3);
    batcher.dispose();
  });

  it('batcher caps flush before overflow; decode roundtrip keeps per-frame order', async () => {
    const sent: Buffer[] = [];
    const batcher = createOutboundFrameBatcher(async (bytes) => { sent.push(bytes); }, { windowMs: 5000, maxBatchFrames: 2 });
    for (let index = 0; index < 4; index++) {
      await batcher.offer(frame(TunnelFrameType.WsBinary, 3, Buffer.of(index)));
    }
    expect(sent).toHaveLength(2); // flushed in two groups of two (cap 2)
    for (const container of sent) {
      const decoded = decodeBatchContainer(container)!;
      if (decoded.kind !== 'batch') throw new Error('expected batch container');
      expect(decoded.frames).toHaveLength(2);
      expect(decodeTunnelFrame(decoded.frames[0]!).streamId).toBe(3);
    }
    batcher.dispose();
    expect(batcher.pendingBytes()).toBe(0); // teardown drops un-flushed frames
  });

  it('empty payloads still yield exactly one (empty) chunk - response-body conformance', () => {
    expect(chunkPayload(Buffer.alloc(0), 8)).toEqual([Buffer.alloc(0)]);
    expect(encodeFragmentedMessage(TunnelFrameType.WsText, 1, Buffer.alloc(0), 8)).toHaveLength(1);
    expect(() => encodeFragmentedMessage(TunnelFrameType.HttpBody, 1, Buffer.alloc(0), 8)).toThrow(CodecError); // §3.6: only WS types fragment
  });
});

describe('downstream scheduler (doc 08 section 3.8)', () => {
  it('window credit gates sends; cumulative acks lift strictly; regressions fail the channel', async () => {
    const emitted: Buffer[] = [];
    const failures: Error[] = [];
    const scheduler = createDownstreamScheduler({
      emit: (bytes) => emitted.push(bytes),
      streamZeroEmit: (bytes) => emitted.push(bytes),
      onError: (error) => failures.push(error),
    });
    const small = frame(TunnelFrameType.HttpBody, 1, Buffer.alloc(1000));
    await scheduler.send(small);
    expect(emitted).toHaveLength(1);
    expect(scheduler.stats().outstanding).toBe(1);
    // stream zero bypasses the credit window AND the ack ledger (the client
    // count excludes keepalives; pings resolve on emit, never held for acks)
    await scheduler.send(frame(TunnelFrameType.Ping, 0, Buffer.alloc(0)));
    expect(emitted).toHaveLength(2);
    expect(scheduler.stats().outstanding).toBe(1);
    // ack the exact boundary of the first nonzero-stream frame (raw bytes incl. 5B header)
    scheduler.onAck(toAck(encodeTunnelFrame(small).length));
    expect(scheduler.stats().outstanding).toBe(0);
    scheduler.onAck(toAck(1)); // regression -> channel failure
    expect(failures).toHaveLength(1);
    scheduler.send(frame(TunnelFrameType.HttpBody, 9, Buffer.alloc(10))).catch(() => undefined);
    expect(await scheduler.send(frame(TunnelFrameType.HttpBody, 9, Buffer.alloc(10))).catch(() => 'rejected')).toBe('rejected');
  });

  it('credit window blocks production until acks release; cancel releases queued work', async () => {
    const emitted: Buffer[] = [];
    const scheduler = createDownstreamScheduler({
      emit: (bytes) => emitted.push(bytes),
      streamZeroEmit: () => undefined,
      onError: () => undefined,
    });
    const bigPayload = Buffer.alloc(INITIAL_WINDOW_BYTES - 1000, 7);
    const big = frame(TunnelFrameType.HttpBody, 1, bigPayload);
    const bigBytes = encodeTunnelFrame(big).length;
    await scheduler.send(big);
    const second = frame(TunnelFrameType.HttpBody, 1, Buffer.alloc(2000, 8));
    const secondPromise = scheduler.send(second);
    await new Promise((r) => setTimeout(r, 15));
    expect(emitted.some((bytes) => bytes.equals(encodeTunnelFrame(big)))).toBe(true);
    expect(emitted.some((bytes) => bytes.equals(encodeTunnelFrame(second)))).toBe(false); // window full: stays queued
    scheduler.onAck(toAck(bigBytes)); // credit released
    await secondPromise;
    expect(emitted.some((bytes) => bytes.equals(encodeTunnelFrame(second)))).toBe(true);
    // cancel: a queued stream rejects without failing the channel (unhandled-safe)
    const queued = scheduler.send(frame(TunnelFrameType.HttpBody, 2, Buffer.alloc(3000, 9)));
    queued.catch(() => 'cancelled');
    scheduler.cancelStream(2);
    expect(await queued.then(() => 'resolved', () => 'cancelled')).toBe('cancelled');
    scheduler.dispose();
  });

  it('ack validation: off-boundary and beyond-sent are channel failures', async () => {
    const failures: Error[] = [];
    const scheduler = createDownstreamScheduler({
      emit: () => undefined,
      streamZeroEmit: () => undefined,
      onError: (error) => failures.push(error),
    });
    const head = frame(TunnelFrameType.HttpBody, 1, Buffer.alloc(500));
    await scheduler.send(head);
    scheduler.onAck(toAck(3)); // lands INSIDE a frame, not on a boundary
    expect(failures).toHaveLength(1);
    expect(String(failures[0])).toContain('off frame boundary');
    scheduler.dispose();

    const beyond = createDownstreamScheduler({
      emit: () => undefined,
      streamZeroEmit: () => undefined,
      onError: (error) => failures.push(error),
    });
    await beyond.send(frame(TunnelFrameType.HttpBody, 1, Buffer.alloc(500)));
    beyond.onAck(toAck(encodeTunnelFrame(head).length + 1)); // beyond sent bytes
    expect(failures).toHaveLength(2);
    expect(String(failures[1])).toContain('beyond sent');
    beyond.dispose();
  });
});

// —— dispatcher ---------------------------------------------------------------

function echoServer(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const relayConnection = request.headers['x-openchamber-relay-connection'];
    if (request.url === '/api/echo' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': 'text/plain',
          'x-relay-conn': String(relayConnection ?? 'none'),
          'x-echo-origin': String(request.headers['origin'] ?? 'none'),
        });
        response.end(Buffer.concat(chunks));
      });
      return;
    }
    if (request.url === '/api/echo-check') {
      response.writeHead(200, { 'content-type': 'text/plain', 'x-relay-conn': String(relayConnection ?? 'none') });
      response.end('pong');
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }
    response.writeHead(404);
    response.end('no route');
  });
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

interface SendSink {
  send: (plaintext: Uint8Array) => Promise<void>;
  frames: TunnelFrame[];
}

function sendSink(): SendSink {
  const frames: TunnelFrame[] = [];
  return {
    frames,
    async send(plaintext: Uint8Array): Promise<void> {
      frames.push(decodeTunnelFrame(Buffer.from(plaintext)));
    },
  };
}

function socketRegistry(): { factory: NonNullable<Parameters<typeof createTunnelHost>[0]['wsFactory']>; sockets: FakeSocketLike[] } {
  const sockets: FakeSocketLike[] = [];
  const factory: NonNullable<Parameters<typeof createTunnelHost>[0]['wsFactory']> = (url, protocols, extra) => {
    const socket = new FakeSocketLike(url, protocols, extra);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}

class FakeSocketLike implements RelayHostSocketLike {
  readonly url: string;
  readonly protocols: string[];
  readonly extraHeaders: Record<string, string>;
  readonly outbound: { data: Buffer; isBinary: boolean }[] = [];
  closes: [number, string][] = [];
  opened = false;
  terminated = false;
  protocol = 'chat.pri';
  private readonly handlers = new Map<string, (...args: any[]) => void>();

  constructor(url: string, protocols: string[], extra: Record<string, string>) {
    this.url = url;
    this.protocols = protocols;
    this.extraHeaders = extra;
  }

  initialize(instantOpen: boolean = true): void {
    this.opened = instantOpen;
    if (instantOpen) this.handlers.get('open')?.();
  }

  send(data: Buffer, isBinary: boolean): void {
    this.outbound.push({ data, isBinary });
  }

  close(code: number, reason?: string): void {
    this.closes.push([code, reason ?? '']);
  }

  terminate(): void {
    this.terminated = true;
  }

  on(event: string, handler: (...args: any[]) => void): void {
    this.handlers.set(event, handler);
  }

  inbound(data: Buffer, isBinary: boolean): void {
    this.handlers.get('message')?.(data, isBinary);
  }

  serverCloses(code: number, reason = ''): void {
    this.handlers.get('close')?.(code, reason);
  }
}

async function expectEventually(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('host dispatcher (doc 08 section 3.9)', () => {
  let loopback: http.Server;
  let port: number;

  beforeAll(async () => {
    loopback = await echoServer();
    const address = loopback.address();
    port = (address as { port: number }).port;
  });

  it('HTTP GET forwards authorized paths and streams the response back (headers rewritten)', async () => {
    const sink = sendSink();
    const host = createTunnelHost({ localPort: port, connectionId: 'conn-1', send: sink.send, flowControl: false });
    await host.handleFrame(requestHead()); // GET /api/echo-check
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.StreamEnd));
    const responseFrame = sink.frames.find((f) => f.type === TunnelFrameType.HttpResponse)!;
    const head = JSON.parse(responseFrame.payload.toString('utf8')) as { status: number; headers: Record<string, string> };
    expect(head.status).toBe(200);
    expect(head.headers['x-relay-conn']).toBe('conn-1'); // the injected marker reaches the loopback server
    const bodyFrame = sink.frames.find((f) => f.type === TunnelFrameType.HttpBody)!;
    expect(bodyFrame.payload.toString('utf8')).toBe('pong');
    expect(sink.frames.at(-1)!.type).toBe(TunnelFrameType.StreamEnd);
    host.dispose();
  });

  it('POST bodies forward verbatim only at StreamEnd; relay-connection header injected', async () => {
    const sink = sendSink();
    const host = createTunnelHost({ localPort: port, connectionId: 'conn-2', send: sink.send, flowControl: false });
    const body = Buffer.from('prompt payload for the harness');
    await host.handleFrame(frame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'POST', path: '/api/echo', query: {}, headers: { 'content-type': 'text/plain', origin: 'https://mobile-spoof.test' }, hasBody: true,
    })));
    expect(sink.frames).toHaveLength(0); // buffered: nothing ships until the body completes
    await host.handleFrame(frame(TunnelFrameType.HttpBody, 1, body));
    expect(sink.frames).toHaveLength(0); // still buffering
    await host.handleFrame(frame(TunnelFrameType.StreamEnd, 1, Buffer.alloc(0)));
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.StreamEnd));
    const responseFrame = sink.frames.find((f) => f.type === TunnelFrameType.HttpResponse)!;
    const head = JSON.parse(responseFrame.payload.toString('utf8')) as { status: number; headers: Record<string, string> };
    expect(head.status).toBe(200);
    expect(head.headers['x-relay-conn']).toBe('conn-2'); // injected header reaches the loopback
    const bodyFrame = sink.frames.find((f) => f.type === TunnelFrameType.HttpBody);
    expect(bodyFrame!.payload.toString('utf8')).toBe(body.toString('utf8')); // concatenated single forward
    expect(head.headers['x-echo-origin']).toBe(`http://127.0.0.1:${port}`); // client origins overwritten with the loopback dial (§3.9)
    host.dispose();
  });

  it('hasBody with ZERO body frames aborts instead of forwarding a truncated body', async () => {
    const sink = sendSink();
    const host = createTunnelHost({ localPort: port, connectionId: 'conn-3', send: sink.send, flowControl: false });
    await host.handleFrame(frame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'POST', path: '/api/echo', query: {}, headers: {}, hasBody: true,
    })));
    await host.handleFrame(frame(TunnelFrameType.StreamEnd, 1, Buffer.alloc(0)));
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.StreamAbort));
    const abort = sink.frames.find((f) => f.type === TunnelFrameType.StreamAbort)!;
    expect(JSON.parse(abort.payload.toString('utf8')).reason).toBe('tunnel request body frames were lost');
    expect(sink.frames.some((f) => f.type === TunnelFrameType.HttpResponse)).toBe(false); // never reaches the loopback
    host.dispose();
  });

  it('the body delivery deadline aborts a stalled stream', async () => {
    const sink = sendSink();
    const host = createTunnelHost({ localPort: port, connectionId: 'conn-4', send: sink.send, flowControl: false, bodyDeliveryTimeoutMs: 40 });
    await host.handleFrame(frame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'POST', path: '/api/echo', query: {}, headers: {}, hasBody: true,
    })));
    await host.handleFrame(frame(TunnelFrameType.HttpBody, 1, Buffer.from('first')));
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.StreamAbort), 1500);
    const abortFrame = sink.frames.find((f) => f.type === TunnelFrameType.StreamAbort)!;
    expect(JSON.parse(abortFrame.payload.toString('utf8')).reason).toBe('tunnel request body delivery deadline');
    await host.handleFrame(frame(TunnelFrameType.StreamEnd, 1, Buffer.alloc(0))); // late end: ignored post-abort
    host.dispose();
  });

  it('a 512 KiB+ body switches to live streaming with the buffered prefix', async () => {
    const sink = sendSink();
    const host = createTunnelHost({ localPort: port, connectionId: 'conn-5', send: sink.send, flowControl: false });
    const prefix = Buffer.concat([Buffer.from('prefix-'), Buffer.alloc(BODY_BUFFER_MAX_BYTES, 65)]);
    await host.handleFrame(frame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
      method: 'POST', path: '/api/echo', query: {}, headers: {}, hasBody: true,
    })));
    await host.handleFrame(frame(TunnelFrameType.HttpBody, 1, prefix));
    await host.handleFrame(frame(TunnelFrameType.HttpBody, 1, Buffer.from('-late-chunk'))); // live: no StreamEnd yet
    await host.handleFrame(frame(TunnelFrameType.StreamEnd, 1, Buffer.alloc(0)));
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.StreamEnd && f.streamId === 1));
    const responseFrame = sink.frames.find((f) => f.type === TunnelFrameType.HttpResponse)!;
    const head = JSON.parse(responseFrame.payload.toString('utf8')) as { status: number; headers: Record<string, string> };
    expect(head.status).toBe(200);
    expect(head.headers['x-relay-conn']).toBe('conn-5');
    const echoed = Buffer.concat(sink.frames.filter((f) => f.type === TunnelFrameType.HttpBody).map((f) => f.payload));
    expect(echoed.toString('utf8')).toBe('prefix-' + 'A'.repeat(BODY_BUFFER_MAX_BYTES) + '-late-chunk'); // prefix + live tail echoed whole
    host.dispose();
  });

  it('path allowlists synthetic-403 foreign paths; body always names the cause', async () => {
    const sink = sendSink();
    const host = createTunnelHost({ localPort: port, connectionId: 'conn-6', send: sink.send, flowControl: false });
    await host.handleFrame(requestHead({ path: '/etc/passwd' }));
    await host.handleFrame(requestHead({ path: '/healthz' }));
    await expectEventually(() => sink.frames.filter((f) => f.type === TunnelFrameType.HttpResponse).length === 2);
    for (const responseFrame of sink.frames.filter((f) => f.type === TunnelFrameType.HttpResponse)) {
      expect(JSON.parse(responseFrame.payload.toString('utf8')).status).toBe(403);
    }
    const bodyFrames = sink.frames.filter((f) => f.type === TunnelFrameType.HttpBody);
    for (const bodyFrame of bodyFrames) {
      const cause = JSON.parse(bodyFrame.payload.toString('utf8')) as { reason?: string; source?: string };
      expect(cause.source).toBe('relay-tunnel-host');
      expect(cause.reason).toBe('path-not-allowed');
    }
    host.dispose();
  });

  it('WS sub-streams: allowed paths dial with headers; text reassembles; clamped closes', async () => {
    const sink = sendSink();
    const registry = socketRegistry();
    const host = createTunnelHost({ localPort: port, connectionId: 'conn-7', send: sink.send, flowControl: false, wsFactory: registry.factory });
    await host.handleFrame(frame(TunnelFrameType.WsOpen, 5, encodeJsonPayload({
      path: '/api/terminal/ws', query: { token: 'oc_url_test' }, protocols: ['chat.pri'],
    })));
    await expectEventually(() => registry.sockets.length === 1);
    const socket = registry.sockets[0]!;
    expect(socket.url).toContain('/api/terminal/ws');
    expect(socket.extraHeaders['x-openchamber-relay-connection']).toBe('conn-7');
    expect(socket.extraHeaders.origin).toBe(`http://127.0.0.1:${port}`);
    socket.initialize();
    // WsOpened flows back through the tunnel (the scheduler), never the socket surface
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.WsOpened && f.streamId === 5));
    const openedFrame = sink.frames.find((f) => f.type === TunnelFrameType.WsOpened)!;
    expect(JSON.parse(openedFrame.payload.toString('utf8'))).toMatchObject({ protocol: 'chat.pri' });
    expect(socket.protocol).toBe('chat.pri');

    // client -> host fragmented text reassembles whole before the socket write
    const boxed = encodeFragmentedMessage(TunnelFrameType.WsText, 5, Buffer.from('hello relay'), 4);
    for (const raw of boxed) await host.handleFrame(decodeTunnelFrame(raw));
    expect(socket.outbound).toHaveLength(1);
    expect(socket.outbound[0]!.isBinary).toBe(false);
    expect(socket.outbound[0]!.data.toString('utf8')).toBe('hello relay');

    // socket -> client messages re-chunk through the tunnel (fragments in sink frames)
    socket.inbound(Buffer.from('downstream message'), false);
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.WsText && f.payload.toString('utf8') === 'downstream message'));
    const textFrame = sink.frames.find((f) => f.type === TunnelFrameType.WsText)!;
    expect(textFrame.streamId).toBe(5);
    expect(textFrame.hasMore).toBe(false); // one budget-sized chunk

    // clamped close code (client-side 5000 clamps to 4999)
    await host.handleFrame(frame(TunnelFrameType.WsClose, 5, encodeJsonPayload({ code: 5000, reason: 'too big' })));
    expect(socket.closes[0]![0]).toBe(4999);
    host.dispose();
  });

  it('WS forbidden paths answer 1008 refused closes; duplicate streams abort', async () => {
    const sink = sendSink();
    const registry = socketRegistry();
    const host = createTunnelHost({ localPort: port, connectionId: 'conn-8', send: sink.send, flowControl: false, wsFactory: registry.factory });
    await host.handleFrame(frame(TunnelFrameType.WsOpen, 6, encodeJsonPayload({ path: '/api/nope/ws' })));
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.WsClose));
    const refused = sink.frames.find((f) => f.type === TunnelFrameType.WsClose)!;
    expect(JSON.parse(refused.payload.toString('utf8')).code).toBe(1008);
    expect(registry.sockets.length).toBe(0);

    // a parked WS stream makes a duplicate detectable: the HTTP request reuses its id
    await host.handleFrame(frame(TunnelFrameType.WsOpen, 7, encodeJsonPayload({ path: '/api/terminal/ws' })));
    await expectEventually(() => registry.sockets.length === 1);
    await host.handleFrame(frame(TunnelFrameType.HttpRequest, 7, encodeJsonPayload({
      method: 'GET', path: '/api/echo-check', query: {}, headers: {},
    })));
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.StreamAbort
      && JSON.parse(f.payload.toString('utf8')).reason === 'duplicate stream id'));
    expect(registry.sockets[0]!.terminated).toBe(true); // both sides die: the loopback socket is cut
    host.dispose();
  });

  it('Ping answers Pong on stream zero; DeliveryAck lifts the flow-control window', async () => {
    const sink = sendSink();
    const host = createTunnelHost({ localPort: port, connectionId: 'conn-9', send: sink.send, flowControl: true, wsFactory: socketRegistry().factory });
    await host.handleFrame(frame(TunnelFrameType.Ping, 0, Buffer.alloc(0)));
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.Pong && f.streamId === 0));
    // a real response crosses the credit window; ack its exact byte boundary (stream-zero pings excluded)
    await host.handleFrame(requestHead());
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.StreamEnd && f.streamId === 1));
    const ackable = sink.frames
      .filter((f) => f.streamId === 1 && f.type !== TunnelFrameType.StreamAbort)
      .reduce((sum, f) => sum + encodeTunnelFrame(f).length, 0);
    expect(ackable).toBeGreaterThan(0);
    await host.handleFrame(frame(TunnelFrameType.DeliveryAck, 0, toAck(ackable)));
    await host.handleFrame(frame(TunnelFrameType.Ping, 0, Buffer.alloc(0))); // channel stays healthy past the ack round
    await expectEventually(() => sink.frames.filter((f) => f.type === TunnelFrameType.Pong).length === 2);
    host.dispose();
  });

  it('loopback request failure aborts upstream with a named reason; control noise is contained', async () => {
    const sink = sendSink();
    const host = createTunnelHost({ localPort: 1, connectionId: 'conn-10', send: sink.send, flowControl: false });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch;
    try {
      await host.handleFrame(requestHead());
      await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.StreamAbort));
      const unreachable = sink.frames.find((f) => f.type === TunnelFrameType.StreamAbort)!;
      expect(JSON.parse(unreachable.payload.toString('utf8')).reason).toBe('loopback request failed after transfer');
    } finally {
      globalThis.fetch = originalFetch;
    }
    // noise: Pong, unexpected HttpResponse, out-of-flow DeliveryAck, fragmented HttpBody guard
    await host.handleFrame(frame(TunnelFrameType.Pong, 0, Buffer.alloc(0)));
    await host.handleFrame(frame(TunnelFrameType.HttpResponse, 9, encodeJsonPayload({ status: 200, headers: {} })));
    await host.handleFrame(frame(TunnelFrameType.DeliveryAck, 0, toAck(500))); // flowControl off: ignored, channel alive
    await host.handleFrame(frame(TunnelFrameType.HttpBody, 9, Buffer.from('x'), true)); // fragmented non-WS: channel-class guard
    await host.handleFrame(frame(TunnelFrameType.Ping, 0, Buffer.alloc(0)));
    await expectEventually(() => sink.frames.some((f) => f.type === TunnelFrameType.Pong && f.streamId === 0)); // keepalive pump alive
    expect(host.stats().open).toBe(0);
    host.dispose();
  });

  it('allowlist guards hold their shape (unit rows)', () => {
    expect(isAllowedRelayHttpPath('/health')).toBe(true);
    expect(isAllowedRelayHttpPath('/api/session')).toBe(true);
    expect(isAllowedRelayHttpPath('/auth/session')).toBe(true);
    expect(isAllowedRelayHttpPath('/apix')).toBe(false);
    expect(isAllowedRelayHttpPath('/healthz')).toBe(false);
    expect(isAllowedRelayHttpPath('/etc/passwd')).toBe(false);
    expect(isAllowedRelayWebSocketPath('/api/terminal/ws')).toBe(true);
    expect(isAllowedRelayWebSocketPath('/api/nope/ws')).toBe(false);
    expect(BODY_BUFFER_MAX_BYTES).toBe(512 * 1024);
  });
});
