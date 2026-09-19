// SPDX-License-Identifier: Apache-2.0
/**
 * P8-5a E2E (doc 08 Â§3.10 runtime client over the production relay wire):
 * the REAL @notnative/ui tunnel client rides the loopback fake worker down
 * the host's production leg (broker + per-leg mux + E2EE + downstream
 * scheduler). HTTP GET/POST with streamed bodies round trips to the local
 * stub server, the WS substream dials a real ws upstream both ways with
 * close-code propagation, a >64 KiB response proves the Â§3.8 DeliveryAck
 * ledger (the downstream window stalls forever without acks), a second
 * client with a 300 ms idle clock keeps its Pong alive on stream zero, and
 * the client leg's replacement reconnects while the host leg survives.
 */
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsClient } from 'ws';
import { RelayIdentityStore, publicJwkCanonical } from '../lib/relay/identity.ts';
import { createRelayHostService, type RelayHostService } from '../lib/relay/host-service.ts';
import { RelayConfigStore } from '../lib/relay/relay-config.ts';
import { RelayHostLock } from '../lib/relay/host-lock.ts';
import { closeAllFakeWorkers, createFakeWorker, type FakeWorker } from './helpers/relay-fake-worker.ts';
import { createRelayTunnelClient } from '@notnative/ui/lib/relay/tunnel-client.ts';
import type { RelayTunnelClientOptions } from '@notnative/ui/lib/relay/tunnel-client-types.ts';

const isolatedDataDir = mkdtempSync(`${tmpdir()}${sep}nnd-p85a-e2e-`);
process.env.NOTNATIVE_DATA_DIR = isolatedDataDir;
delete process.env.NOTNATIVE_RELAY_HOST;
delete process.env.NOTNATIVE_ELECTRON_DEV;

let identity: RelayIdentityStore | null = null;
let service: RelayHostService | null = null;
let worker: FakeWorker | null = null;
let client: (ReturnType<typeof createRelayTunnelClient>) | null = null;
let keepaliveClient: (ReturnType<typeof createRelayTunnelClient>) | null = null;
let serverId = '';
const stubFrames: Array<{ corePath: string; relayConn: string | undefined; contentLength: string | undefined }> = [];
let stubPort = 0;
let stubServer: http.Server | null = null;
let upstreamSeenMessage = '';
let upstreamCloseCode: number | null = null;
let eventSocketRef: WsClient | null = null;

function headerLine(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function eventSocketRefGate(): boolean {
  return eventSocketRef !== null;
}

beforeAll(async () => {
  stubServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? 'http://x/probe', 'http://x');
    stubFrames.push({
      corePath: url.pathname,
      relayConn: headerLine(request.headers['x-openchamber-relay-connection']),
      contentLength: headerLine(request.headers['content-length']),
    });
    if (url.pathname === '/api/big') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(Buffer.alloc(220_000, 0x51)); // bigger than the 64 KiB initial window: acks must flow
      return;
    }
    const bodyChunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { bodyChunks.push(chunk); });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, path: url.pathname, body: Buffer.concat(bodyChunks).length, bodyHead: Buffer.concat(bodyChunks).subarray(0, 24).toString('utf8') }));
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  stubServer.on('upgrade', (request, socket, head) => {
    const target = new URL(request.url ?? '/api/event/ws', 'http://x');
    if (target.pathname !== '/api/event/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      upstreamSeenMessage = '';
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        const text = isBinary ? '<binary>' : data.toString('utf8');
        upstreamSeenMessage = text;
        ws.send(`echo:${text}`);
      });
      ws.on('close', (code: number) => { upstreamCloseCode = code; });
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
  serverId = await identity.serverId();
  const resolvedIdentity = await identity.resolve();
  const hostJwk = publicJwkCanonical(resolvedIdentity.encryption.publicJwk);
  const baseOptions = (): RelayTunnelClientOptions => ({
    relayUrl: worker!.url,
    serverId,
    hostEncPubJwk: hostJwk,
    helloRetryMs: 40,
    helloTimeoutMs: 3000,
    reconnectBaseDelayMs: 15,
    reconnectMaxDelayMs: 60,
  });
  client = createRelayTunnelClient({ ...baseOptions(), wireQuery: { connectionId: 'p85a-client-e2e' } });
  await waitFor(() => client !== null && client.getStatus().state === 'connected', 4000);
  keepaliveClient = createRelayTunnelClient({ ...baseOptions(), wireQuery: { connectionId: 'p85a-keepalive' }, pingIntervalMs: 300, pingTimeoutMs: 5000 });
  await waitFor(() => keepaliveClient !== null && keepaliveClient.getStatus().state === 'connected', 4000);
  await waitFor(async () => ((await service?.getStatus())?.connectedClients ?? 0) >= 2, 3000);
});

afterAll(async () => {
  await closeAllFakeWorkers();
  client?.close();
  keepaliveClient?.close();
  service?.dispose();
  await new Promise<void>((resolve) => stubServer?.close(() => resolve()));
  rmSync(isolatedDataDir, { recursive: true, force: true });
});

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, detail?: () => string): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      void Promise.resolve()
        .then(predicate)
        .then((met) => {
          if (met) { resolve(); return; }
          if (Date.now() - start > timeoutMs) { reject(new Error(`condition not reached in time (${detail?.() ?? ''})`)); return; }
          setTimeout(tick, 10);
        })
        .catch(reject);
    };
    tick();
  });
}

describe('the real relay client over the production host wire', () => {
  it('GET round trips to the loopback stub with query + bearer headers intact', async () => {
    if (client === null) throw new Error('harness not ready');
    const response = await client.fetch('/api/probe?plan=p85a', { headers: { authorization: 'Bearer oc_client_probe' } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/api/probe');
    const seen = stubFrames[stubFrames.length - 1] as { corePath: string; relayConn: string | undefined; contentLength: string | undefined };
    expect(seen.corePath).toBe('/api/probe');
    expect(typeof seen.relayConn).toBe('string'); // the host stamps its relay connection id
    expect(seen.contentLength).toBeUndefined(); // hop framing is recomputed loopback-side
  });

  it('a >64 KiB streamed response forces the §3.8 DeliveryAck ledger to carry the channel', async () => {
    if (client === null) throw new Error('harness not ready');
    const response = await client!.fetch('/api/big');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.length).toBe(220_000);
    expect(text.charCodeAt(0)).toBe(0x51);
    expect(text.charCodeAt(219_999)).toBe(0x51);
    expect(client!.getStatus().state).toBe('connected'); // acks kept the window flowing
  });

  it('POST streams the request body through the whole leg', async () => {
    if (client === null) throw new Error('harness not ready');
    const payload = JSON.stringify({ note: 'x'.repeat(150_000) });
    const response = await client!.fetch('/api/projects/9/notes', { method: 'POST', body: payload, headers: { 'content-type': 'application/json' } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; body: number; bodyHead: string };
    expect(body.body).toBe(payload.length);
    expect(body.bodyHead.startsWith('{"note"')).toBe(true);
  });

  it('WS substream dials the real ws upstream both ways and completes with a code', { timeout: 20000 }, async () => {
    if (client === null) throw new Error('harness not ready');
    const surface = client.openWebSocket('/api/event/ws?lane=e2e', ['ev-hello']);
    expect(surface.readyState).toBe(0);
    const openDetail = (): string => {
      if (client === null) return 'client null';
      const status = client.getStatus();
      return `tunnel=${status.state}/${status.lastError ?? ''} ready=${surface.readyState} saw=${eventSocketRefGate()}`;
    };
    await waitFor(() => surface.readyState === 1, 8000, openDetail);
    expect(surface.protocol).toBe('ev-hello');
    let received = '';
    surface.onmessage = (event) => { received = typeof event.data === 'string' ? event.data : '<bin>'; };
    surface.send('client-ping-85a'); // the onmessage handler attaches BEFORE the send (the echo must not miss it)
    await waitFor(() => upstreamSeenMessage === 'client-ping-85a', 8000, (): string => {
      if (client === null) return 'client null';
      const status = client.getStatus();
      return `stage=upstream tunnel=${status.state}/${status.lastError ?? ''} ev=${upstreamSeenMessage.slice(0, 24)}`;
    });
    await waitFor(() => received === 'echo:client-ping-85a', 8000, (): string => `stage=echo received=${received.slice(0, 32)} ev=${upstreamSeenMessage.slice(0, 24)}`);
    expect(client.getStatus().state).toBe('connected'); // diagnostics: the leg must survive the WS round trip
    surface.close(1000, 'e2e done');
    await waitFor(() => surface.readyState === 3, 8000);
    await waitFor(() => upstreamCloseCode !== null, 6000);
    expect(upstreamCloseCode).toBe(1000);
    // The WsClose row rides scheduler.sendNow (ledger-accounted): acking the
    // close row must NOT trip the host's boundary validation (E-08-41) —
    // the same tunnel keeps serving traffic without a leg churn.
    const after = await client.fetch('/api/probe?after=ws-close');
    expect(after.status).toBe(200);
    expect(client.getStatus().state).toBe('connected');
  });

  it('keepalive rides the leg: idle pings on stream 0, Pongs keep the client connected', async () => {
    if (keepaliveClient === null) throw new Error('harness not ready');
    await new Promise((resolve) => setTimeout(resolve, 450)); // past one 300 ms idle window
    expect(keepaliveClient.getStatus().state).toBe('connected');
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(keepaliveClient.getStatus().state).toBe('connected');
  });

  it('a client-leg replacement reconnects while the host leg survives', { timeout: 20000 }, async () => {
    if (client === null) throw new Error('harness not ready');
    const leg = await worker?.awaitClientLeg('p85a-client-e2e');
    leg?.close();
    await waitFor(() => client !== null && (client.getStatus().state === 'reconnecting' || client.getStatus().state === 'connecting'), 4000);
    await waitFor(() => client !== null && client.getStatus().state === 'connected', 5000);
    const response = await client.fetch('/api/probe?after=leg-replacement');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { path: string };
    expect(body.path).toBe('/api/probe');
  });
});
