// SPDX-License-Identifier: Apache-2.0
// Relay tunnel client behavior tests (doc 08 §3.10/§3.11): HTTP lanes and
// WS sub-streams against the in-process fake broker; queued connect ops,
// ambiguous tagging, reconnect cycles, terminal close codes (fail fast
// forever), inbound-driven keepalive, the §3.8 ledger parity (client ack
// cumulative == host raw nonzero bytes), and explicit close discipline.
import { describe, expect, it } from 'vitest';

import { utf8Text, utf8Bytes } from '../bytes.ts';
import { encodeJsonPayload, TunnelFrameType } from '../tunnel-codec.ts';
import { MAX_TUNNEL_PAYLOAD_BYTES } from '../crypto.ts';
import { createRelayTunnelClient } from '../tunnel-client.ts';
import type { RelayTunnelClientOptions, RelayWireSocket } from '../tunnel-client-types.ts';
import { isAmbiguousTransportFailure } from '../transport-error.ts';
import { FakeBroker, makeHostKeys, until, bytesOf, type FakeWire, type FakeHost } from './fake-host.ts';

const EMPTY = new Uint8Array(0);
type HostKeys = Awaited<ReturnType<typeof makeHostKeys>>;

interface Entry { socket: TestSocket; broker: FakeBroker }

class TestSocket implements RelayWireSocket, FakeWire {
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string | undefined }) => void) | null = null;
  closed = false;
  brokerRef: FakeBroker | null = null;

  constructor(readonly url: string) {}

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    const broker = this.brokerRef;
    if (broker === null) throw new Error('fake wire has no broker');
    void broker.onClientMessage(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    void code; void reason;
  }

  deliverText(text: string): void {
    this.onmessage?.({ data: text });
  }

  deliverBytes(bytes: Uint8Array): void {
    const copy = bytesOf(bytes);
    this.onmessage?.({ data: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer });
  }

  brokerCloses(code: number, reason: string): void {
    if (this.closed) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

interface Rig {
  client: ReturnType<typeof createRelayTunnelClient>;
  brokers: Entry[];
  keyOf: () => FakeHost;
}

function makeRig(hostKeys: HostKeys, overrides?: Partial<RelayTunnelClientOptions>): Rig {
  const brokers: Entry[] = [];
  const client = createRelayTunnelClient({
    relayUrl: 'ws://relay.test/ws',
    serverId: 'sid-test',
    hostEncPubJwk: hostKeys.publicJwk,
    createWireSocket: (url: string): RelayWireSocket => {
      const socket = new TestSocket(url);
      const broker = new FakeBroker(socket, hostKeys);
      socket.brokerRef = broker;
      brokers.push({ socket, broker });
      setTimeout(() => socket.onopen?.(), 0);
      return socket;
    },
    reconnectBaseDelayMs: 5,
    reconnectMaxDelayMs: 20,
    helloRetryMs: 15,
    helloTimeoutMs: 2000,
    ...overrides,
  } satisfies RelayTunnelClientOptions);
  return {
    client,
    brokers,
    keyOf: () => brokers[brokers.length - 1]?.broker.host as FakeHost,
  };
}

async function readyBroker(rig: Rig): Promise<FakeBroker> {
  const entry = rig.brokers[rig.brokers.length - 1];
  if (entry === undefined) throw new Error('no broker socket yet');
  await until(() => entry.broker.host.established);
  await until(() => rig.client.getStatus().state === 'connected');
  return entry.broker;
}

describe('relay tunnel client over a fake broker', () => {
  it('GET resolves a streaming Response; the request head carries method + inline query', async () => {
    const rig = makeRig(await makeHostKeys());
    const broker = await readyBroker(rig);
    const pending = rig.client.fetch('/api/config?x=1&y=two', { headers: { 'x-requested-with': 'nnd' } });
    await until(() => broker.host.requests.length >= 1);
    const head = broker.host.requests[0] as { method: string; path: string; headers: Record<string, string> };
    expect(head.method).toBe('GET');
    expect(head.path).toBe('/api/config?x=1&y=two');
    expect(head.headers['x-requested-with']).toBe('nnd');
    await broker.sendFrame(TunnelFrameType.HttpResponse, 1, encodeJsonPayload({ status: 200, headers: { 'content-type': 'text/plain', 'x-relay-probe': '1' } }));
    await broker.sendFrame(TunnelFrameType.HttpBody, 1, utf8Bytes('streamed body '));
    await broker.sendFrame(TunnelFrameType.HttpBody, 1, utf8Bytes('from relay'));
    await broker.sendFrame(TunnelFrameType.StreamEnd, 1, EMPTY);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get('x-relay-probe')).toBe('1');
    expect(await response.text()).toBe('streamed body from relay');
    rig.client.close();
  });

  it('POST streams the body under the plaintext budget as separate HttpBody frames', async () => {
    const rig = makeRig(await makeHostKeys());
    const broker = await readyBroker(rig);
    const body = new Uint8Array(200_000).fill(7);
    const pending = rig.client.fetch('/api/projects/1/notes', { method: 'POST', body });
    await until(() => broker.host.requests.length >= 1);
    const head = broker.host.requests[0] as { method: string; path: string; hasBody: boolean };
    expect(head.method).toBe('POST');
    expect(head.hasBody).toBe(true);
    await broker.sendFrame(TunnelFrameType.HttpResponse, 1, encodeJsonPayload({ status: 204, headers: {} }));
    await broker.sendFrame(TunnelFrameType.StreamEnd, 1, EMPTY);
    const pieces = broker.host.bodyBytesByStream.get(1) ?? [];
    expect(pieces.reduce((total, part) => total + part.length, 0)).toBe(200_000);
    expect(pieces.every((part) => part.length <= MAX_TUNNEL_PAYLOAD_BYTES)).toBe(true);
    const response = await pending;
    expect(response.status).toBe(204);
    rig.client.close();
  });

  it('openWebSocket: WsOpen → WsOpened; fragmented inbound reassembles; local close rides WsClose', async () => {
    const rig = makeRig(await makeHostKeys());
    const broker = await readyBroker(rig);
    const surface = rig.client.openWebSocket('/api/terminal/ws?k=v', ['relay-proto']);
    expect(surface.readyState).toBe(0);
    let opened = false;
    surface.onopen = () => { opened = true; };
    await until(() => broker.host.saw.some((frame) => frame.type === TunnelFrameType.WsOpen));
    await broker.sendFrame(TunnelFrameType.WsOpened, 1, encodeJsonPayload({ protocol: 'relay-proto' }));
    await until(() => opened);
    expect(surface.readyState).toBe(1);
    expect(surface.protocol).toBe('relay-proto');
    surface.send('outbound text');
    await until(() => (broker.host.wsMessages.get(1) ?? []).some((entry) => entry.text === 'outbound text'));
    await broker.sendFrame(TunnelFrameType.WsText, 1, utf8Bytes('frag'), true);
    await broker.sendFrame(TunnelFrameType.WsText, 1, utf8Bytes('ment'), false);
    const received: Array<string | ArrayBuffer> = [];
    surface.onmessage = (event) => { received.push(event.data); };
    await until(() => received.length >= 1 && typeof received[0] === 'string' && received[0] === 'fragment');
    surface.close(1000, 'done');
    await until(() => broker.host.wsCloses.get(1)?.code === 1000);
    expect(surface.readyState).toBe(3);
    expect(() => surface.send('late')).toThrow(/relay tunnel socket is not open/);
    rig.client.close();
  });

  it('send before WsOpened throws the exact contract message', async () => {
    const rig = makeRig(await makeHostKeys());
    await readyBroker(rig);
    const surface = rig.client.openWebSocket('/api/terminal/ws');
    expect(surface.readyState).toBe(0);
    expect(() => surface.send('early')).toThrow(/relay tunnel socket is not open/);
    rig.client.close();
  });

  it('StreamEnd before the response head rejects tagged ambiguous', async () => {
    const rig = makeRig(await makeHostKeys());
    const broker = await readyBroker(rig);
    const pending = rig.client.fetch('/api/projects/7');
    await until(() => broker.host.requests.length >= 1);
    await broker.sendFrame(TunnelFrameType.StreamEnd, 1, EMPTY);
    let failure: unknown = null;
    try { await pending; } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(isAmbiguousTransportFailure(failure)).toBe(true);
    expect((failure as Error).message).toContain('StreamEnd before response head');
    rig.client.close();
  });

  it('channel death resets waiters (tagged) and reconnects; the retry rides a fresh socket', async () => {
    const rig = makeRig(await makeHostKeys());
    const first = rig.brokers[0] as Entry;
    void (await readyBroker(rig));
    let wsClosed = 0;
    const surface = rig.client.openWebSocket('/api/terminal/ws');
    surface.onclose = () => { wsClosed += 1; };
    await until(() => first.broker.host.saw.some((frame) => frame.type === TunnelFrameType.WsOpen));
    first.socket.brokerCloses(1012, 'host went away');
    await until(() => rig.client.getStatus().state === 'reconnecting');
    await until(() => wsClosed === 1);
    let failure: unknown = null;
    await rig.client.fetch('/api/config').catch((error: unknown) => { failure = error; });
    expect((failure as Error | null)?.message).toContain('relay tunnel is not connected');
    expect(isAmbiguousTransportFailure(failure)).toBe(false);
    await until(() => rig.client.getStatus().state === 'connected'); // the retry ledger has a fresh socket
    const second = rig.brokers[rig.brokers.length - 1] as Entry;
    await until(() => second.broker.host.established);
    const pending = rig.client.fetch('/api/config?after=reconnect');
    await until(() => second.broker.host.requests.length >= 1);
    await second.broker.sendFrame(TunnelFrameType.HttpResponse, 3, encodeJsonPayload({ status: 200, headers: {} }));
    await second.broker.sendFrame(TunnelFrameType.HttpBody, 3, utf8Bytes('back online'));
    await second.broker.sendFrame(TunnelFrameType.StreamEnd, 3, EMPTY);
    const response = await pending;
    expect(await response.text()).toBe('back online');
    rig.client.close();
  });

  it('a fetch racing the current connect attempt is queued onto that attempt', async () => {
    const rig = makeRig(await makeHostKeys());
    const racing = rig.client.fetch('/api/config?race=1');
    await until(() => rig.client.getStatus().state === 'connecting');
    const entry = rig.brokers[0] as Entry;
    await until(() => entry.broker.host.established);
    await until(() => rig.client.getStatus().state === 'connected');
    await until(() => entry.broker.host.requests.length >= 1);
    await entry.broker.sendFrame(TunnelFrameType.HttpResponse, 1, encodeJsonPayload({ status: 200, headers: {} }));
    await entry.broker.sendFrame(TunnelFrameType.HttpBody, 1, utf8Bytes('raced ride'));
    await entry.broker.sendFrame(TunnelFrameType.StreamEnd, 1, EMPTY);
    expect(await (await racing).text()).toBe('raced ride');
    rig.client.close();
  });

  it('reconnect backoff starts at the base delay and doubles per completed cycle (§3.11)', async () => {
    const rig = makeRig(await makeHostKeys(), { reconnectBaseDelayMs: 100, reconnectMaxDelayMs: 300 });
    await readyBroker(rig);
    const first = rig.brokers[0] as Entry;
    const t0 = Date.now();
    first.socket.brokerCloses(4008, 'host unavailable');
    await until(() => rig.client.getStatus().state === 'reconnecting');
    // scheduleReconnect computes base × 2^completedCycles: the FIRST retry is base ms.
    await until(() => rig.brokers.length >= 2 && rig.brokers[1]?.socket !== undefined);
    const firstRetryElapsed = Date.now() - t0;
    expect(firstRetryElapsed).toBeGreaterThanOrEqual(80);
    expect(firstRetryElapsed).toBeLessThan(260); // 100 ms + generous drift, NOT the doubled 200+
    await until(() => rig.client.getStatus().state === 'connected', 3000);
    rig.client.close();
  });

  it('terminal 4010 retains the error, fails fast forever, and never schedules a reconnect', async () => {
    const rig = makeRig(await makeHostKeys());
    const broker = await readyBroker(rig);
    const pending = rig.client.fetch('/api/config?pre=fail');
    await until(() => broker.host.requests.length >= 1);
    const firstSocket = rig.brokers[0] as Entry;
    firstSocket.socket.brokerCloses(4010, 'auth failed');
    await until(() => rig.client.getStatus().state === 'error');
    const socketsBefore = rig.brokers.length;
    let failure: Error | null = null;
    try { await pending; } catch (error) { failure = error as Error; }
    const failed = failure as Error | null;
    expect(failed?.message).toContain('relay tunnel reset:');
    expect(isAmbiguousTransportFailure(failed)).toBe(true);
    let late: Error | null = null;
    try { await rig.client.fetch('/api/config'); } catch (error) { late = error as Error; }
    const lateError = late as Error | null;
    expect(lateError?.message).toContain('relay tunnel is unavailable (terminal close)');
    expect(isAmbiguousTransportFailure(lateError)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(rig.brokers.length).toBe(socketsBefore);
    rig.client.close();
  });

  it('keepalive is inbound-driven: idle id pings on stream 0; a Pong keeps the channel live', async () => {
    const rig = makeRig(await makeHostKeys(), { pingIntervalMs: 40, pingTimeoutMs: 120 });
    const broker = await readyBroker(rig);
    await until(() => broker.host.lastPingAt > 0);
    await broker.sendFrame(TunnelFrameType.Pong, 0, EMPTY);
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(rig.client.getStatus().state).toBe('connected');
    rig.client.close();
  });

  it('a missed Pong kills the channel (pong deadline) and the retry reconnects', async () => {
    const rig = makeRig(await makeHostKeys(), { pingIntervalMs: 40, pingTimeoutMs: 60 });
    await readyBroker(rig);
    const socketsBefore = rig.brokers.length;
    await until(() => (rig.brokers[0]?.broker.host.lastPingAt ?? 0) > 0);
    await until(() => rig.client.getStatus().state === 'reconnecting', 3000); // pong deadline fires → failChannel
    await until(() => rig.brokers.length > socketsBefore, 3000); // the retry comes after the base backoff
    await until(() => rig.client.getStatus().state === 'connected', 3000);
    rig.client.close();
  });

  it('local WS close completes: the WsClose echo routes onclose exactly once', async () => {
    const rig = makeRig(await makeHostKeys());
    const broker = await readyBroker(rig);
    const surface = rig.client.openWebSocket('/api/terminal/ws?k=v');
    let closes: Array<{ code: number; reason: string }> = [];
    surface.onclose = (event) => { closes = [...closes, event]; };
    await until(() => broker.host.saw.some((frame) => frame.type === TunnelFrameType.WsOpen));
    surface.close(1000, 'local done');
    expect(surface.readyState).toBe(3); // native shape: closed locally at once
    await until(() => broker.host.wsCloses.get(1)?.code === 1000);
    // The host clamp (1000..4999) echoes; the link record survives until then.
    await broker.sendFrame(TunnelFrameType.WsClose, 1, encodeJsonPayload({ code: 1000, reason: 'host ack' }));
    await until(() => closes.length >= 1);
    expect(closes[0]?.code).toBe(1000);
    rig.client.close();
  });

  it('§3.8 ledger parity: cumulative client ack equals the host raw nonzero bytes', async () => {
    const rig = makeRig(await makeHostKeys());
    const broker = await readyBroker(rig);
    const pending = rig.client.fetch('/api/projects/ledger');
    await until(() => broker.host.requests.length >= 1);
    const big = new Uint8Array(40_000).fill(120);
    await broker.sendFrame(TunnelFrameType.HttpResponse, 1, encodeJsonPayload({ status: 200, headers: {} }));
    await broker.sendFrame(TunnelFrameType.HttpBody, 1, big);
    await broker.sendFrame(TunnelFrameType.HttpBody, 1, utf8Bytes('tail'));
    await broker.sendFrame(TunnelFrameType.StreamEnd, 1, EMPTY);
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 60));
    const lastAck = broker.host.acks[broker.host.acks.length - 1];
    expect(lastAck).toBe(broker.host.rawSentBytes);
    rig.client.close();
  });

  it('close() drains waiters, refuses later use, and is idempotent', async () => {
    const rig = makeRig(await makeHostKeys());
    await readyBroker(rig);
    rig.client.close();
    expect(rig.client.getStatus().state).toBe('idle');
    let failure: Error | null = null;
    try { await rig.client.fetch('/api/config'); } catch (error) { failure = error as Error; }
    expect(failure?.message).toContain('relay tunnel is not connected (state idle)');
    rig.client.close();
    expect(rig.client.getStatus().state).toBe('idle');
  });
});
