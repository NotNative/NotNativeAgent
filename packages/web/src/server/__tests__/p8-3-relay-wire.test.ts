// SPDX-License-Identifier: Apache-2.0
/**
 * P8-3a gates part 3 (doc 08 sections 3.5-3.9 assembly): the PRODUCTION
 * wire — the default hostFactory (real broker + per-leg L3 mux: the
 * dispatcher, the §3.7 batch container, the §3.8 scheduler, and the real
 * `ws` loopback adapter) driven over the loopback fake worker. An HTTP
 * request rides the encrypted leg to a real local stub server and back;
 * a WsOpen dials a real local ws upstream through the production adapter;
 * a replayed ciphertext closes the leg (counter regression, fail closed).
 */
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type WebSocket as WsClient } from 'ws';
import { RelayIdentityStore, publicJwkCanonical } from '../lib/relay/identity.ts';
import { decryptFrame, encryptFrame, type OpenedSession } from '../lib/relay/crypto.ts';
import { createClientInitiator } from '../lib/relay/handshake.ts';
import {
  TunnelFrameType,
  encodeJsonPayload,
  encodeTunnelFrame,
} from '../lib/relay/tunnel-codec.ts';
import { decodeFrameOrContainer } from '../lib/relay/batch.ts';
import { createRelayHostService, type RelayHostService } from '../lib/relay/host-service.ts';
import { RelayConfigStore } from '../lib/relay/relay-config.ts';
import { RelayHostLock } from '../lib/relay/host-lock.ts';
import { closeAllFakeWorkers, createFakeWorker, type FakeWorker } from './helpers/relay-fake-worker.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p83-wire-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
delete process.env.NOTNATIVE_RELAY_HOST;
delete process.env.NOTNATIVE_ELECTRON_DEV;

let identity: RelayIdentityStore | null = null;
let service: RelayHostService | null = null;
let worker: FakeWorker | null = null;
let stubServer: http.Server | null = null;
let stubPort = 0;
let upstreamSeenPing = false;
let upstreamCloseCode: number | null = null;

beforeAll(async () => {
  stubServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? 'http://x/probe', 'http://x');
    response.writeHead(200, { 'content-type': 'application/json', 'x-stub': url.pathname });
    response.end(JSON.stringify({ ok: true, path: url.pathname, query: url.search }));
  });
  const wss = new WebSocketServer({ noServer: true });
  stubServer.on('upgrade', (request, socket, head) => {
    const target = new URL(request.url ?? '/api/event/ws', 'http://x');
    if (target.pathname !== '/api/event/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.send('upstream-hello');
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary && data.toString('utf8') === 'client-ping') upstreamSeenPing = true;
        ws.send(`echo:${isBinary ? 'BIN' : data.toString('utf8')}`);
      });
      ws.on('close', (code: number) => {
        upstreamCloseCode = code;
      });
    });
  });
  await new Promise<void>((resolve) => stubServer!.listen(0, '127.0.0.1', () => {
    stubPort = (stubServer!.address() as { port: number }).port;
    resolve();
  }));
  identity = new RelayIdentityStore(isolatedDataDir);
  worker = await createFakeWorker();
  const config = new RelayConfigStore(isolatedDataDir);
  config.write({ enabled: true, relayUrl: worker.url });
  service = createRelayHostService({
    dataDir: isolatedDataDir,
    identity,
    config,
    lock: new RelayHostLock({ dataDir: isolatedDataDir }),
    demandSignals: [() => true],
    localPort: stubPort,
    timing: { claimWatcherMs: 30, demandPollMs: 60_000, claimTakeoverGraceMs: 120 },
  });
  service.start();
  await waitFor(async () => {
    const status = await service?.getStatus();
    return status !== undefined && status.state === 'connected' && (worker?.hostControl() ?? null) !== null;
  }, 3000);
});

afterAll(async () => {
  await closeAllFakeWorkers();
  service?.dispose();
  await new Promise<void>((resolve) => stubServer?.close(() => resolve()));
  rmSync(isolatedDataDir, { recursive: true, force: true });
});

const CLIENT_ROLE_PARAMS = 'v=1&role=client&appId=openchamber';

interface WireFrame {
  type: number;
  streamId: number;
  payload: Buffer;
}

interface ClientLeg {
  session: OpenedSession;
  socket: WsClient;
  inbound: Buffer[];
  closed: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      void Promise.resolve()
        .then(predicate)
        .then((met) => {
          if (met) { resolve(); return; }
          if (Date.now() - start > timeoutMs) { reject(new Error('condition not reached in time')); return; }
          setTimeout(tick, 10);
        })
        .catch(reject);
    };
    tick();
  });
}

function decodeHostTraffic(message: Buffer): WireFrame[] {
  const decoded = decodeFrameOrContainer(message);
  if (decoded === null) throw new Error(`unrecognized container 0x${message.toString('hex').slice(0, 8)}`);
  const raw = decoded.kind === 'single' ? [decoded.frame] : decoded.frames;
  return raw.map((frameBuffer) => ({
    type: frameBuffer[0]! & 0x7f,
    streamId: frameBuffer.readUInt32BE(1),
    payload: frameBuffer.subarray(5),
  }));
}

/** Frame streamer over one leg: decodes each new wire message once, in
 * order, and hands back the tunnel frames it carried. */
function makeFrameStream(leg: ClientLeg, startWireIndex: number): () => Promise<WireFrame[]> {
  let cursor = startWireIndex;
  return async (): Promise<WireFrame[]> => {
    await waitFor(() => leg.inbound.length > cursor, 2500);
    const out: WireFrame[] = [];
    for (const wire of leg.inbound.slice(cursor)) {
      const plaintext = Buffer.from(await decryptFrame(leg.session.hostToClient, wire));
      out.push(...decodeHostTraffic(plaintext));
    }
    cursor = leg.inbound.length;
    return out;
  };
}

async function establishLeg(connectionId: string): Promise<ClientLeg> {
  if (worker === null || identity === null) throw new Error('harness not ready');
  const url = new URL(worker.url);
  url.search = `${CLIENT_ROLE_PARAMS}&serverId=${await identity.serverId()}&connectionId=${connectionId}`;
  const socket = new WebSocket(url.toString());
  const hostEncPublicJwk = (await identity.resolve()).encryption.publicJwk;
  const leg: ClientLeg = { session: null as unknown as OpenedSession, socket, inbound: [], closed: null };
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', () => resolveOpen());
    socket.once('error', rejectOpen);
  });
  const machine = createClientInitiator({
    hostEncPublicJwk: publicJwkCanonical(hostEncPublicJwk),
    capabilities: { batch: true, flowControl: true },
    sendText: (text) => socket.send(text, { binary: false }),
    onClose: () => undefined,
    onEstablished: (established) => {
      leg.session = established.session;
    },
    helloRetryMs: 30,
    helloTimeoutMs: 1500,
  });
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) leg.inbound.push(data);
    else void machine.onText(data);
  });
  socket.on('close', (code: number) => {
    leg.closed = leg.closed ?? code;
  });
  await machine.start();
  await waitFor(() => leg.session !== null, 2000);
  await waitFor(async () => ((await service?.getStatus())?.connectedClients ?? 0) >= 1, 2000);
  return leg;
}

function sendTunnelFrame(
  leg: ClientLeg,
  frame: { type: TunnelFrameType; streamId: number; hasMore: boolean; payload: Buffer },
): Promise<void> {
  const plaintext = Buffer.concat([Buffer.of(0x00), encodeTunnelFrame(frame)]);
  return encryptFrame(leg.session.clientToHost, plaintext).then((cipher) => {
    leg.socket.send(cipher);
  });
}

/** §3.7 bare ship: NON-buffered singles leave ENVELOPE-FREE on the wire
 * (the [0x01] header byte is a legal frame type — HttpRequest). */
function sendBareTunnelFrame(
  leg: ClientLeg,
  frame: { type: TunnelFrameType; streamId: number; hasMore: boolean; payload: Buffer },
): Promise<void> {
  const plaintext = encodeTunnelFrame(frame);
  return encryptFrame(leg.session.clientToHost, plaintext).then((cipher) => {
    leg.socket.send(cipher);
  });
}

describe('mixed-mode demux (the 0x01 tag vs bare HttpRequest disambiguation)', () => {
  const head = encodeJsonPayload({ method: 'GET', path: '/api/probe', query: {}, headers: {} });

  it('a bare HttpRequest (first byte 0x01) stays a SINGLE instead of miscasting as a container', () => {
    const bare = Buffer.concat([Buffer.of(0x01), Buffer.from('00000069', 'hex'), head]);
    const decoded = decodeFrameOrContainer(bare);
    expect(decoded !== null && decoded.kind === 'single' ? decoded.frame.length : 0).toBe(bare.length);
    const parsed = decoded !== null && decoded.kind === 'single' ? JSON.parse(decoded.frame.subarray(5).toString('utf8')) : null;
    expect(parsed).toMatchObject({ method: 'GET', path: '/api/probe' });
  });

  it('real containers win: N≥2 and single-frame [0x01] container runs of BUFFERED frames', () => {
    const bodyFrame = encodeTunnelFrame({ type: TunnelFrameType.HttpBody, streamId: 9, hasMore: false, payload: Buffer.from('chunk') });
    const two = Buffer.concat([Buffer.of(0x01), ((): Buffer => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(bodyFrame.length, 0);
      return Buffer.concat([head, bodyFrame]);
    })(), ((): Buffer => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(bodyFrame.length, 0);
      return Buffer.concat([head, bodyFrame]);
    })()]);
    const decoded = decodeFrameOrContainer(two);
    expect(decoded !== null && decoded.kind === 'batch' ? decoded.frames.length : 0).toBe(2);
    const one = two.subarray(0, 1 + 4 + bodyFrame.length);
    expect(decodeFrameOrContainer(one) !== null && decodeFrameOrContainer(one)!.kind === 'batch').toBe(true);
  });

  it('junk 0x01-prefixed payloads stay fail-closed (null) when no legal shape exists', () => {
    expect(decodeFrameOrContainer(Buffer.from([0x01, 0x00, 0x00, 0x05]))).toBeNull(); // truncated container, sub-header bare
    expect(decodeFrameOrContainer(Buffer.of(0x01))).toBeNull();
    // a big stale length inside a body makes the container parse impossible
    // -> the bare fallback needs ≥5 bytes: this one still parses (type-1 row,
    // refused by the dispatcher) rather than misfielding a phantom batch
    const fatLength = Buffer.concat([Buffer.of(0x01), Buffer.from('00FFFFFF', 'hex'), Buffer.alloc(6, 0x7b)]);
    expect(decodeFrameOrContainer(fatLength) !== null && decodeFrameOrContainer(fatLength)!.kind === 'single').toBe(true);
  });

  it('bare HttpRequest rides the PRODUCTION leg end to end (the 0x01 tag cannot kill it)', async () => {
    const leg = await establishLeg('wire-bare-http');
    await sendBareTunnelFrame(leg, {
      type: TunnelFrameType.HttpRequest,
      streamId: 105,
      hasMore: false,
      payload: encodeJsonPayload({ method: 'GET', path: '/api/probe', query: { q: '1' }, headers: {} }),
    });
    const stream = makeFrameStream(leg, 0);
    const frames = await stream();
    const response = frames.find((frame) => frame.type === TunnelFrameType.HttpResponse);
    expect(response?.streamId).toBe(105);
    expect(JSON.parse(response!.payload.toString('utf8'))).toMatchObject({ status: 200 });
    expect(frames.some((frame) => frame.type === TunnelFrameType.StreamEnd && frame.streamId === 105)).toBe(true);
    await disposeByReplay(leg);
  });
});

describe('production relay wire (broker + leg mux + loopback)', () => {
  it('an HTTP request rides the encrypted leg to the real loopback server and back', async () => {
    const leg = await establishLeg('wire-1');
    await sendTunnelFrame(leg, {
      type: TunnelFrameType.HttpRequest,
      streamId: 101,
      hasMore: false,
      payload: encodeJsonPayload({ method: 'GET', path: '/api/probe', query: { q: '1' }, headers: {} }),
    });
    const stream = makeFrameStream(leg, 0);
    const frames = await stream();
    const response = frames.find((frame) => frame.type === TunnelFrameType.HttpResponse);
    expect(response?.streamId).toBe(101);
    const head = JSON.parse(response!.payload.toString('utf8')) as { status: number; headers: Record<string, string> };
    expect(head.status).toBe(200);
    expect(head.headers['x-stub']).toBe('/api/probe');
    const body = Buffer.concat(frames.filter((frame) => frame.type === TunnelFrameType.HttpBody && frame.streamId === 101).map((frame) => frame.payload));
    expect(JSON.parse(body.toString('utf8'))).toMatchObject({ ok: true, path: '/api/probe' });
    expect(frames.some((frame) => frame.type === TunnelFrameType.StreamEnd && frame.streamId === 101)).toBe(true);
    await disposeByReplay(leg);
  });

  it('a WsOpen dials the real local ws upstream; texts and closes cross both ways', async () => {
    const leg = await establishLeg('wire-ws');
    const stream = makeFrameStream(leg, 0);
    await sendTunnelFrame(leg, {
      type: TunnelFrameType.WsOpen,
      streamId: 103,
      hasMore: false,
      payload: encodeJsonPayload({ path: '/api/event/ws', protocols: [] }),
    });
    const opened = (await stream()).find((frame) => frame.type === TunnelFrameType.WsOpened);
    expect(opened?.streamId).toBe(103);
    const hello = (await stream()).find((frame) => frame.type === TunnelFrameType.WsText);
    expect(hello?.payload.toString('utf8')).toBe('upstream-hello');
    await sendTunnelFrame(leg, {
      type: TunnelFrameType.WsText,
      streamId: 103,
      hasMore: false,
      payload: Buffer.from('client-ping'),
    });
    const echo = (await stream()).find((frame) => frame.type === TunnelFrameType.WsText);
    expect(echo?.payload.toString('utf8')).toBe('echo:client-ping');
    expect(upstreamSeenPing).toBe(true);
    await sendTunnelFrame(leg, {
      type: TunnelFrameType.WsClose,
      streamId: 103,
      hasMore: false,
      payload: encodeJsonPayload({ code: 1000, reason: 'done' }),
    });
    const closeFrame = (await stream()).find((frame) => frame.type === TunnelFrameType.WsClose);
    expect(closeFrame).toBeDefined();
    expect(upstreamCloseCode).not.toBeNull();
    await disposeByReplay(leg);
  });
});

/** The exact-byte replay: one accepted send, then the IDENTICAL wire
 * bytes again — the GCM counter regression closes the leg (1011). */
async function disposeByReplay(leg: ClientLeg): Promise<void> {
  const before = leg.inbound.length;
  const plaintext = Buffer.concat([Buffer.of(0x00), encodeTunnelFrame({
    type: TunnelFrameType.Ping,
    streamId: 0,
    hasMore: false,
    payload: Buffer.alloc(0),
  })]);
    const wire = await encryptFrame(leg.session.clientToHost, plaintext);
    leg.socket.send(wire);
    await waitFor(() => leg.inbound.length > before, 2500); // the host's Pong proves the send was consumed
    leg.socket.send(wire); // exact replay: same bytes, same counter -> 1011
  await waitFor(() => leg.socket.readyState >= 2, 2500);
  expect(leg.closed).not.toBeNull();
  await waitFor(async () => ((await service?.getStatus())?.connectedClients ?? 0) === 0, 2000);
}
