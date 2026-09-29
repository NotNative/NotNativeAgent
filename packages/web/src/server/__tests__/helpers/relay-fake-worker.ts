// SPDX-License-Identifier: Apache-2.0
/**
 * Fake relay worker prosthesis (test-only; doc 08 §3.3 rows): worker-parity
 * ECDSA auth verification against the presented pk, one-host-slot 4001
 * replacement, verbatim text/binary forwarding (kind preserved), upgrade
 * gates for deterministic lastError/timeout windows, and controlled sync
 * announcements. Shared by the P8-2b broker gates and the P8-3 service
 * gates (the E2E wire plugs real legs through it).
 */
import http from 'node:http';
import { webcrypto } from 'node:crypto';
import { WebSocketServer, type WebSocket as WsClient } from 'ws';

export interface FakeWorker {
  url: string;
  hostControl: () => WsClient | null;
  closeControl: (code: number, reason: string) => void;
  pauseControl(): void;
  unpauseControl(): void;
  pauseData(): void;
  unpauseData(): void;
  awaitClientLeg(connectionId: string): Promise<WsClient>;
  announceSync(connectionIds: string[]): void;
  /** Injects a worker -> host `connected` announcement (duplicate-leg pins). */
  announceConnected(connectionId: string): void;
  /** Ungates held upgrades, terminates every live socket, closes the server. */
  close(): Promise<void>;
}

const workers: FakeWorker[] = [];

export async function closeAllFakeWorkers(): Promise<void> {
  for (const worker of workers) await worker.close();
  workers.splice(0, workers.length);
}

export function createFakeWorker(): Promise<FakeWorker> {
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
        ws.close(4010, 'signature rejected');
        return;
      }
      if (role === 'host-control') {
        if (hostControlSocket !== null && hostServerId === serverId) {
          hostControlSocket.close(4001, 'Control replaced');
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
      ws.close(4010, 'unknown role');
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
  const worker: FakeWorker = {
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
    announceConnected(connectionId: string): void {
      hostControlSocket?.send(JSON.stringify({ type: 'connected', connectionId }));
    },
    close(): Promise<void> {
      ungateAll();
      const terminateAll = (): void => { for (const client of wss.clients) client.terminate(); };
      terminateAll();
      return new Promise((resolve) => {
        setTimeout(() => { // reaped late arrivals cannot keep the server open
          terminateAll();
          httpServer.closeAllConnections?.();
          httpServer.close(() => resolve());
        }, 25);
      });
    },
  };
  workers.push(worker);
  return new Promise((resolveWithWorker) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      worker.url = `ws://127.0.0.1:${port}/ws`;
      resolveWithWorker(worker);
    });
  });
}

export async function verifyHostSig(pk: string, sig: string, payload: string): Promise<boolean> {
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
