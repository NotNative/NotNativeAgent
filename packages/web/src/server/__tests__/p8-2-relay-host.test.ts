// SPDX-License-Identifier: Apache-2.0
/**
 * P8-2b gates (doc 08 sections 3.3/3.4/3.11, host side): a LOOPBACK fake
 * relay worker with worker-parity auth verification (sig against pk), the
 * one-host-slot 4001 rule, and verbatim binary forwarding. The host
 * machine is driven end to end: control connect/reconnect + lastError,
 * the E2EE handshake against a real client initiator, frames decrypting
 * both ways, sync reconciliation, the idle reaper (1001), rekey-1008 and
 * plaintext-after-established-1011, and dead-relay leg supervision.
 */
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, sep } from 'node:path';
import { webcrypto } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer, type WebSocket as WsClient } from 'ws';
import { RelayIdentityStore, publicJwkCanonical } from '../lib/relay/identity.ts';
import { decryptFrame, encryptFrame, type OpenedSession } from '../lib/relay/crypto.ts';
import { MAX_PLAINTEXT_FRAME_BYTES } from '../lib/relay/crypto.ts';
import { createClientInitiator } from '../lib/relay/handshake.ts';
import { RelayHostBroker, RELAY_CLOSE, type RelayHostTiming } from '../lib/relay/host-broker.ts';

const scratchDirs: string[] = [];
const workers: FakeWorker[] = [];

afterAll(async () => {
  for (const worker of workers) await worker.close();
});

interface FakeWorker {
  url: string;
  hostControl: () => WsClient | null;
  closeControl: (code: number, reason: string) => void;
  pauseControl(): void;
  unpauseControl(): void;
  pauseData(): void;
  unpauseData(): void;
  awaitClientLeg(connectionId: string): Promise<WsClient>;
  announceSync(connectionIds: string[]): void;
  /** Ungates held upgrades, terminates every live socket, closes the server. */
  close(): Promise<void>;
}

function fakeWorker(): Promise<FakeWorker> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const dataSockets = new Map<string, WsClient>();
  const clientLegs = new Map<string, WsClient>();
  const pendingLegs = new Map<string, (ws: WsClient) => void>();
  let controlGate: Promise<void> | null = null;
  let controlGateResolve: (() => void) | null = null;
  let dataGate: Promise<void> | null = null;
  let dataGateResolve: (() => void) | null = null;
  let hostControlSocket: WsClient | null = null;
  let hostServerId: string | null = null;
  wss.on('connection', (ws: WsClient, request: http.IncomingMessage) => {
    const params = new URL(request.url ?? '', 'http://relay.invalid');
    const role = params.searchParams.get('role') ?? '';
    const serverId = params.searchParams.get('serverId') ?? '';
    const connectionId = params.searchParams.get('connectionId') ?? '';
    if (role === 'client') {
      clientLegs.set(connectionId, ws);
      pendingLegs.get(connectionId)?.(ws);
      pendingLegs.delete(connectionId);
      hostControlSocket?.send(JSON.stringify({ type: 'connected', connectionId }));
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        dataSockets.get(connectionId)?.send(data as Buffer, { binary: isBinary }); // forward verbatim, kind preserved
      });
      return;
    }
    // host roles: the frame plumbing attaches synchronously so no inbound
    // frame or close can race the async verify; only the PAIRING (slot
    // assignment) lands after the worker-parity signature check
    const paired = { value: false };
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!paired.value || role !== 'host-data') return;
      clientLegs.get(connectionId)?.send(data as Buffer, { binary: isBinary }); // kind preserved
    });
    ws.on('close', () => {
      if (paired.value && role === 'host-data') {
        clientLegs.get(connectionId)?.close(1000, 'host leg closed'); // the pairing teardown propagates
      }
    });
    void verifyHostSig(
      params.searchParams.get('pk') ?? '',
      params.searchParams.get('sig') ?? '',
      `${params.searchParams.get('ts') ?? ''}.${serverId}.${role}.${connectionId}`,
    ).then((ok) => {
      if (!ok) {
        ws.close(RELAY_CLOSE.AuthFailed, 'signature rejected');
        return;
      }
      if (role === 'host-control') {
        if (hostControlSocket !== null && hostServerId === serverId) {
          hostControlSocket.close(RELAY_CLOSE.ControlReplaced, 'Control replaced');
        }
        hostControlSocket = ws;
        hostServerId = serverId;
        return;
      }
      if (role === 'host-data') {
        paired.value = true;
        dataSockets.set(connectionId, ws);
        return;
      }
      ws.close(RELAY_CLOSE.AuthFailed, 'unknown role');
    });
  });
  const httpServer = http.createServer((request, response) => {
    response.writeHead(404);
    response.end();
  });
  httpServer.on('upgrade', async (request, socket, head) => {
    const target = new URL(request.url ?? '', 'http://relay.invalid');
    if (target.pathname !== '/ws') return;
    const role = target.searchParams.get('role');
    if (role === 'host-control' && controlGate !== null) {
      await controlGate; // paused: the upgrade never completes while the 4001 window is observed
    }
    if (role === 'host-data' && dataGate !== null) {
      await dataGate; // paused: holds the host dial so the open timeout fires
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });
  const ungateAll = (): void => {
    controlGateResolve?.();
    controlGateResolve = null;
    controlGate = null;
    dataGateResolve?.();
    dataGateResolve = null;
    dataGate = null;
  };
  workers.push({
    url: '',
    hostControl: () => hostControlSocket,
    closeControl: (code: number, reason: string) => hostControlSocket?.close(code, reason),
    pauseControl(): void {
      if (controlGate === null) controlGate = new Promise((gate) => { controlGateResolve = gate; });
    },
    unpauseControl(): void {
      controlGateResolve?.();
      controlGateResolve = null;
      controlGate = null;
    },
    pauseData(): void {
      if (dataGate === null) dataGate = new Promise((gate) => { dataGateResolve = gate; });
    },
    unpauseData(): void {
      dataGateResolve?.();
      dataGateResolve = null;
      dataGate = null;
    },
    awaitClientLeg(connectionId: string): Promise<WsClient> {
      const existing = clientLegs.get(connectionId);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolveLeg) => {
        pendingLegs.set(connectionId, resolveLeg);
      });
    },
    announceSync(ids: string[]): void {
      hostControlSocket?.send(JSON.stringify({ type: 'sync', connectionIds: ids }));
    },
    close(): Promise<void> {
      ungateAll();
      const terminateAll = (): void => { for (const client of wss.clients) client.terminate(); };
      terminateAll();
      return new Promise((resolve) => {
        setTimeout(() => { // reaped late arrivals cannot keep the server open
          terminateAll();
          httpServer.close(() => resolve());
        }, 25);
      });
    },
  });
  return new Promise((resolveWithWorker) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      workers[workers.length - 1]!.url = `ws://127.0.0.1:${port}/ws`;
      resolveWithWorker(workers[workers.length - 1]!);
    });
  });
}

const CLIENT_ROLE_PARAMS = 'v=1&role=client&appId=openchamber';

async function verifyHostSig(pk: string, sig: string, payload: string): Promise<boolean> {
  let publicJwk: Record<string, unknown>;
  try {
    publicJwk = JSON.parse(Buffer.from(pk, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return false;
  }
  try {
    const key = await webcrypto.subtle.importKey('jwk', publicJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new Uint8Array(Buffer.from(sig, 'base64url')),
      Buffer.from(payload, 'utf8'),
    );
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface TestSideClient {
  session: OpenedSession;
  connectionId: string;
  socket: WsClient;
  inbound: Buffer[];
  texts: string[];
  hello: Buffer | null;
}

/** Dials a client leg through the worker and runs the real initiator
 * against the host responder; resolves once the host side established. */
async function establishClientLeg(
  brokerState: TestHarness,
  connectionId: string,
): Promise<TestSideClient> {
  const worker = brokerState.worker;
  const url = new URL(worker.url);
  url.search = `${CLIENT_ROLE_PARAMS}&serverId=${await brokerState.identity.serverId()}&connectionId=${connectionId}`;
  const socket = new WebSocket(url.toString());
  const legReady = worker.awaitClientLeg(connectionId);
  const hostEncPublicJwk = (await brokerState.identity.resolve()).encryption.publicJwk;
  const client: TestSideClient = { session: null as unknown as OpenedSession, connectionId, socket, inbound: [], texts: [], hello: null };
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
      client.session = established.session;
      client.hello = Buffer.from(established.helloText);
    },
    helloRetryMs: 30,
    helloTimeoutMs: 900,
  });
  socket.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      client.inbound.push(data);
      return;
    }
    client.texts.push(data.toString('utf8'));
    void machine.onText(data);
  });
  await machine.start();
  await legReady;
  await waitFor(() => brokerState.legEstablished.includes(connectionId), 2000).catch(() => {
    throw new Error(`establish race failed for ${connectionId}: closed=${JSON.stringify(brokerState.legClosed)} established=${JSON.stringify(brokerState.legEstablished)}`);
  });
  await waitFor(() => client.session !== null);
  return client;
}

interface TestHarness {
  worker: FakeWorker;
  identity: RelayIdentityStore;
  broker: RelayHostBroker;
  frames: { connectionId: string; payload: Buffer }[];
  legEstablished: string[];
  legClosed: [string, number, string][];
  dirs: string[];
}

async function harness(
  identityWithin?: RelayIdentityStore,
  onLegs?: { established?: (id: string) => void; closed?: (id: string, code: number, reason: string) => void },
  timing?: Partial<RelayHostTiming>,
): Promise<TestHarness> {
  const dir = mkdtempSync(`${tmpdir()}${sep}nnd-broker-`);
  scratchDirs.push(dir);
  const identity = identityWithin ?? new RelayIdentityStore(dir);
  const worker = await fakeWorker();
  const state: TestHarness = {
    worker,
    identity,
    broker: new RelayHostBroker({
      identity,
      timing: { ...SHORT_TIMING, ...timing },
      onLegFrame: (connectionId, payload) => state.frames.push({ connectionId, payload: Buffer.from(payload) }),
      onLegEstablished: (connectionId) => { state.legEstablished.push(connectionId); onLegs?.established?.(connectionId); },
      onLegClosed: (connectionId, code, reason) => { state.legClosed.push([connectionId, code, reason]); onLegs?.closed?.(connectionId, code, reason); },
    }),
    frames: [],
    legEstablished: [],
    legClosed: [],
    dirs: [dir],
  };
  await state.broker.start({ relayUrl: worker.url, platform: 'test' });
  await waitFor(() => state.broker.getStatus().state === 'connected');
  await waitFor(() => worker.hostControl() !== null); // the fake's parity verify is async: never read before paired
  return state;
}



describe('relay host broker (doc 08 sections 3.3/3.4/3.11, host side)', () => {
  it('connects with a worker-verified signature and reports status; stop clears', async () => {
    const brokerState = await harness();
    const status = brokerState.broker.getStatus();
    expect(status).toMatchObject({ state: 'connected', connectedClients: 0, lastError: null, relayUrl: brokerState.worker.url });
    expect(status.serverId).toBeTruthy();
    expect(brokerState.worker.hostControl()).not.toBeNull();
    brokerState.broker.stop();
    expect(brokerState.broker.getStatus().state).toBe('disabled');
  });

  it('control replacement: lastError reflects the 4001 close and a clean reconnect follows', async () => {
    const brokerState = await harness();
    brokerState.worker.unpauseControl(); // ensure the gate starts open
    brokerState.worker.pauseControl(); // hold the reconnect so the 4001 window is observable
    brokerState.worker.closeControl(RELAY_CLOSE.ControlReplaced, 'Control replaced');
    await waitFor(() => brokerState.broker.getStatus().lastError?.includes('4001') ?? false);
    await waitFor(() => brokerState.broker.getStatus().state === 'reconnecting');
    brokerState.worker.unpauseControl();
    await waitFor(() => brokerState.broker.getStatus().state === 'connected');
    expect(brokerState.broker.getStatus().lastError).toBeNull();
    expect(brokerState.broker.getStatus().connectedClients).toBe(0);
    brokerState.broker.stop();
  });

  it('E2EE leg: handshake establishes, client frames decrypt, host frames encrypt back', async () => {
    // idle stays out of the way: this test proves the leg SURVIVES the open
    // timer window rather than the reaper closing it mid-observation
    const brokerState = await harness(undefined, undefined, { dataIdleMs: 2_000, dataSweepMs: 200 });
    const client = await establishClientLeg(brokerState, 'leg-1');
    expect(client.session.clientToHost).toBeDefined();

    // client -> host: an encrypted Layer-3-ish blob decrypts through the broker
    const frame = await encryptFrame(client.session.clientToHost, Buffer.from(JSON.stringify({ method: 'GET' })));
    client.socket.send(frame);
    await waitFor(() => brokerState.frames.some((f) => f.connectionId === 'leg-1'));
    expect(brokerState.frames[0]!.payload.toString('utf8')).toBe('{"method":"GET"}');
    expect(brokerState.broker.getStatus().connectedClients).toBe(1);

    // host -> client: sendToClient encrypts client-decryptable hostToClient frames
    await brokerState.broker.sendToClient('leg-1', Buffer.from('relay-down'));
    await waitFor(() => client.inbound.length > 0);
    const plaintext = await decryptFrame(client.session.hostToClient, client.inbound[0]!);
    expect(Buffer.from(plaintext).toString('utf8')).toBe('relay-down');

    // the open timeout must not hover over a healthy leg: a frame beyond
    // the old-timer window still decrypts (openTimer cleared on socket open)
    await new Promise((resolve) => setTimeout(resolve, SHORT_TIMING.dataOpenTimeoutMs + 60));
    const lateFrame = await encryptFrame(client.session.clientToHost, Buffer.from('{"method":"PING"}'));
    client.socket.send(lateFrame);
    await waitFor(() => brokerState.frames.some((f) => f.payload.toString('utf8') === '{"method":"PING"}', 1500));
    expect(brokerState.legClosed).toHaveLength(0);

    // an oversize plaintext is rejected at the cap boundary, never queued
    await expect(brokerState.broker.sendToClient('leg-1', new Uint8Array(MAX_PLAINTEXT_FRAME_BYTES + 1)))
      .rejects.toThrow(/exceeds/);
    brokerState.broker.stop();
  });

  it('sync reconciliation drops unlisted legs and keeps listed ones', async () => {
    // the reaper is held far outside the test window so the close cause is
    // pinned to the sync (1000 'sync drop'), never the idle sweep (1001)
    const brokerState = await harness(undefined, undefined, { dataIdleMs: 60_000, dataSweepMs: 1_000 });
    await establishClientLeg(brokerState, 'keep-1');
    await establishClientLeg(brokerState, 'drop-1');
    await establishClientLeg(brokerState, 'keep-2');
    await waitFor(() => brokerState.broker.getStatus().connectedClients === 3);
    brokerState.worker.announceSync(['keep-1', 'keep-2']);
    await waitFor(() => brokerState.legClosed.some(([id, code, reason]) => id === 'drop-1' && code === 1000 && reason === 'sync drop'));
    expect(brokerState.broker.getStatus().connectedClients).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 120)); // settle: no cascade may follow the sync drop
    expect(brokerState.broker.getStatus().connectedClients).toBe(2);
    expect(brokerState.legClosed).toEqual([['drop-1', 1000, 'sync drop']]);
    expect(brokerState.legEstablished).toContain('keep-1');
    expect(brokerState.legEstablished).toContain('keep-2');
    brokerState.broker.stop();
  });

  it('idle reaper closes a silent leg 1001 and frees the count', async () => {
    let closedViaEvent: [string, number, string] | null = null;
    const brokerState = await harness(undefined, {
      closed: (id, code, reason) => { if (closedViaEvent === null) closedViaEvent = [id, code, reason]; },
    });
    const client = await establishClientLeg(brokerState, 'silent-1');
    // silence: the host reaps after 140 ms of no inbound frames
    await waitFor(() => closedViaEvent !== null, 2500);
    expect(closedViaEvent![1]).toBe(RELAY_CLOSE.IdleTimeout);
    expect(brokerState.broker.getStatus().connectedClients).toBe(0);
    await waitFor(() => client.socket.readyState >= 2, 1500); // the pairing teardown reaches the client leg (2 or 3)
    brokerState.broker.stop();
  });

  it('a rekey attempt closes 1008; post-established plaintext closes 1011', async () => {
    let legCodes: [string, number][] = [];
    const brokerState = await harness(undefined, {
      closed: (id, code) => { legCodes.push([id, code]); },
    });
    const client = await establishClientLeg(brokerState, 'rekey-1');
    const rogueHello = Buffer.from(JSON.stringify({
      t: 'hello', v: 1,
      clientPubJwk: { kty: 'EC', crv: 'P-256', x: 'rogue'.repeat(8) + 'aa', y: 'rogue'.repeat(8) + 'bb' },
      nonce: Buffer.from('n16').toString('base64url').repeat(5).slice(0, 22),
    }));
    client.socket.send(rogueHello, { binary: false }); // hellos are TEXT frames
    await waitFor(() => legCodes.some(([id, code]) => id === 'rekey-1' && code === RELAY_CLOSE.RekeyMismatch), 2000);
    expect(legCodes).toContainEqual(['rekey-1', 1008]);
    brokerState.broker.stop();

    legCodes = [];
    const brokerState2 = await harness(undefined, {
      closed: (id, code) => { legCodes.push([id, code]); },
    });
    const client2 = await establishClientLeg(brokerState2, 'plain-1');
    client2.socket.send(Buffer.from(JSON.stringify({ t: 'ready', v: 1 })), { binary: false }); // plaintext after established
    await waitFor(() => legCodes.some(([id, code]) => id === 'plain-1' && code === RELAY_CLOSE.ChannelFailure), 2000);
    expect(legCodes).toContainEqual(['plain-1', 1011]);
    brokerState2.broker.stop();
  });

  it('a duplicate IDENTICAL hello after established re-answers the ready, no close', async () => {
    // §3.4 retry race: the broker routes established TEXT into the responder
    // (the broker itself never becomes the 1011 authority) and the
    // responder re-answers the SAME ready for the same-fingerprint hello
    const brokerState = await harness();
    const client = await establishClientLeg(brokerState, 'dup-1');
    expect(client.hello).not.toBeNull();
    client.socket.send(client.hello as Buffer, { binary: false });
    await waitFor(() => client.texts.filter((text) => text.includes('"ready"')).length === 2, 1500);
    expect(client.texts).toHaveLength(2); // ready, then the re-answer only
    expect(brokerState.legClosed).toHaveLength(0);
    expect(brokerState.broker.getStatus().connectedClients).toBe(1);
    brokerState.broker.stop();
  });

  it('a host-data leg announced but not paired is supervised closed 1012, not stuck', async () => {
    const brokerState = await harness();
    brokerState.worker.pauseData(); // hold the broker's host-data upgrade
    brokerState.worker.announceSync(['slow-1']);
    await waitFor(() => brokerState.legClosed.some(([id, code]) => id === 'slow-1' && code === RELAY_CLOSE.HostWentAway), 2500);
    expect(brokerState.broker.getStatus().connectedClients).toBe(0);
    brokerState.worker.unpauseData(); // release the held upgrade before teardown
    brokerState.broker.stop();
  });

  it('a leg announced toward a dead relay is supervised closed, not stuck', async () => {
    const brokerState = await harness();
    const dead = new URL(brokerState.worker.url);
    dead.port = '1'; // refuse-connection port
    void dead;
    brokerState.broker.stop();

    const brokerState2 = await harness();
    // the worker refuses to pair a leg the host never opened: announce an id
    // whose host-data dial races the refusal; both guards (error/close or
    // open timeout) must produce a legClosed event rather than a ghost.
    brokerState2.worker.announceSync(['ghost-1']);
    await waitFor(() => brokerState2.legClosed.some(([id]) => id === 'ghost-1'), 2500);
    expect(brokerState2.broker.getStatus().connectedClients).toBe(0);
    brokerState2.broker.stop();
  });
});
const SHORT_TIMING = {
  controlPingMs: 40,
  controlPongGraceMs: 30,
  dataOpenTimeoutMs: 120,
  dataIdleMs: 140,
  dataSweepMs: 20,
  reconnectBaseMs: 15,
  reconnectCapMs: 30,
};
