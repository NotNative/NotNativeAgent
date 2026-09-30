// SPDX-License-Identifier: Apache-2.0
/** Host end of the raw-TCP dev tunnel (doc 13 §H.2 / §J.4). */
import { connect, type Socket } from 'node:net';
import { WebSocket, WebSocketServer, type RawData, type WebSocket as WireSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { ENV } from '../env.ts';
import { attachedHarnessPort, createDevServerScanner } from './dev-servers.ts';
import { getUiAuthController } from '../lib/auth/ui-auth.ts';
import { firstQueryParam, urlTokenTargetAllowed } from '../lib/auth/url-tokens.ts';
import { originAdmittedByHeaders } from '../lib/http/request-security.ts';
import { incomingHeaders } from '../terminal/wire.ts';

const PATH = '/api/dev-tunnel';
const MAX_SOCKETS_PER_HOST = 64;
const DIAL_TIMEOUT_MS = 5_000;
const BACKPRESSURE_BYTES = 1_000_000;
const BACKPRESSURE_POLL_MS = 20;

export interface DevTunnelOptions {
  availablePorts?: () => Promise<readonly number[]>;
  dialTimeoutMs?: number;
  backpressurePollMs?: number;
  maxPayloadBytes?: number;
}

interface HostSlot { close(): void; terminate(): void }

export interface DevTunnelWiring { dispose(): void }

export function parseDevTunnelTarget(rawUrl: string): number | null {
  const url = new URL(rawUrl, 'http://notnative.invalid');
  if (url.pathname !== PATH) return null;
  const port = Number(url.searchParams.get('port'));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** H.2's decision is independent of transport plumbing so testbuchse rows
 * cannot accidentally bypass it through handleUpgrade. */
export function authorizeDevTunnelUpgrade(url: URL, headers: Headers): boolean {
  const controller = getUiAuthController();
  if (!controller.passwordRequired()) return true;
  const origin = headers.get('origin');
  if (origin !== null) {
    if (!originAdmittedByHeaders({
      originHeader: origin, hostHeader: headers.get('host'),
      forwardedHostHeader: headers.get('x-forwarded-host'),
    }, null, process.env.NOTNATIVE_DESKTOP_UI_ORIGIN)) return false;
    return controller.upgradeAllowed(url, headers, 'GET');
  }
  const granted = controller.authenticate(headers, url, 'GET');
  if (!granted.ok) return false;
  const hasToken = firstQueryParam(url) !== null;
  if (hasToken) {
    if (!urlTokenTargetAllowed('GET', url.pathname, true)) return false;
    return controller.credentialGrant(headers, url, 'GET');
  }
  return granted.scope === 'client';
}

function rawStatus(socket: import('node:net').Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function hostKey(value: string | undefined): string { return value || 'local'; }

/** Success-only scanner caching is right for /api/dev-servers, but the tunnel
 * must make its reachability decision from a fresh enumeration. */
export function freshDevServerPorts(): Promise<readonly number[]> {
  return createDevServerScanner({ cacheMs: 0, ownPorts: () => [ENV.port, attachedHarnessPort()] })()
    .then((result) => result.ok ? result.servers.map((server) => server.port) : []);
}

export function attachDevTunnelWebsocket(server: HttpServer, options: DevTunnelOptions = {}): DevTunnelWiring {
  const dialTimeout = options.dialTimeoutMs ?? DIAL_TIMEOUT_MS;
  const pollMs = options.backpressurePollMs ?? BACKPRESSURE_POLL_MS;
  const hosts = new Map<string, Set<HostSlot>>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: options.maxPayloadBytes ?? BACKPRESSURE_BYTES });

  const canAccept = (request: IncomingMessage): boolean => {
    const key = hostKey(request.socket.remoteAddress);
    return (hosts.get(key)?.size ?? 0) < MAX_SOCKETS_PER_HOST;
  };
  const reserve = (request: IncomingMessage): HostSlot => {
    const key = hostKey(request.socket.remoteAddress);
    const sockets = hosts.get(key) ?? new Set<HostSlot>();
    const release = (): void => { sockets.delete(slot); if (sockets.size === 0) hosts.delete(key); };
    const slot: HostSlot = { close: release, terminate: (): void => undefined };
    request.socket.once('close', release);
    sockets.add(slot);
    hosts.set(key, sockets);
    return slot;
  };

  const onUpgrade = (request: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void => {
    const url = new URL(String(request.url ?? ''), 'http://notnative.invalid');
    if (url.pathname !== PATH) return;
    const port = parseDevTunnelTarget(url.pathname + url.search);
    if (port === null || !canAccept(request) || !authorizeDevTunnelUpgrade(url, incomingHeaders(request))) {
      rawStatus(socket, '403 Forbidden');
      return;
    }
    const slot = reserve(request);
    const ports = options.availablePorts;
    if (ports === undefined) { rawStatus(socket, '403 Forbidden'); return; }
    void ports().then((allowed) => {
      if (!allowed.includes(port)) {
        console.warn(`refused port ${port}: not reported by dev-server discovery`);
        rawStatus(socket, '403 That port is not an available dev server');
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        slot.terminate = (): void => client.terminate();
        relayConnection(client, socket, port, dialTimeout, pollMs, connect);
      });
    }, () => rawStatus(socket, '403 Forbidden'));
  };
  server.on('upgrade', onUpgrade);
  return {
    dispose(): void {
      server.off('upgrade', onUpgrade);
      for (const clients of hosts.values()) for (const client of clients) client.close();
      wss.close();
    },
  };
}

export function relayConnection(client: WireSocket, requester: import('node:net').Socket, port: number,
  timeoutMs: number, pollMs: number, upstreamConnect: typeof connect = connect): void {
  let upstream: Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  const close = (): void => {
    if (poll !== null) clearInterval(poll);
    poll = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    upstream?.destroy();
    upstream = null;
    requester.destroy();
    if (client.readyState !== WebSocket.CLOSED && client.readyState !== WebSocket.CLOSING) client.terminate();
  };
  client.on('close', close);
  client.on('error', close);
  client.on('message', (data: RawData) => { if (upstream?.writable) upstream.write(toBuffer(data)); });
  upstream = upstreamConnect({ host: '127.0.0.1', port });
  upstream.setNoDelay(true);
  timer = setTimeout(close, timeoutMs);
  upstream.once('connect', () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    poll = setInterval(() => {
      if (client.bufferedAmount > BACKPRESSURE_BYTES) upstream?.pause();
      else upstream?.resume();
    }, pollMs);
    poll.unref();
  });
  upstream.on('data', (chunk: Buffer) => {
    if (client.readyState === WebSocket.OPEN) client.send(chunk, { binary: true });
  });
  upstream.on('end', close);
  upstream.on('close', close);
  upstream.on('error', close);
}

function toBuffer(data: RawData): Buffer { return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Uint8Array); }
