// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal WS wire (doc 07 sections 2.1/3.1/3.6/4.8): ONE socket path
 * /api/terminal/ws, binary frames (0x01 + JSON v3), 64 KiB server
 * maxPayload, 15 s protocol-level ping on every open socket. The
 * URL-token/auth gate slot is registered (E-07-3): the v1 gate admits
 * loopback peers only. Dead sockets detach from every session on close/
 * error (E-07-12) so held attachments cannot block the idle reaper; the
 * disposition closes clients with a 1 s terminate race (section 4.8).
 */
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { TERMINAL_WS_MAX_PAYLOAD_BYTES, TERMINAL_WS_PATH, encodeFrame } from './protocol.ts';
import { TerminalRuntime } from './session-core.ts';
import { originAdmittedByHeaders } from '../lib/http/request-security.ts';
import type { SocketLike } from './records.ts';
import { readPublicOrigin } from '../lib/settings-store.ts';

export const SERVER_WS_PING_INTERVAL_MS = 15_000;
export const TERMINAL_WS_CLOSE_GRACE_MS = 1_000; // section 4.8: ws.close() with a 1 s race-fallback

export interface TerminalWiring { dispose(): void }

/** E-07-3 auth slot (doc 08 §2.6): the credential predicate rides next to
 * the loopback cap; URL-token/cookie checks stay in lib/auth (ui-auth). */
export type TerminalUpgradeGate = (url: URL, headers: Headers, method: string) => boolean;

function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return true; // in-process/uds: the desktop host dials loopback by design
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

export function attachTerminalWebsocket(server: HttpServer, runtime: TerminalRuntime, gate?: TerminalUpgradeGate): TerminalWiring {
  const wss = new WebSocketServer({ noServer: true, maxPayload: TERMINAL_WS_MAX_PAYLOAD_BYTES });
  const onUpgrade = (request: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void => {
    const rawUrl = String(request.url ?? '');
    const url = new URL(rawUrl, 'http://notnative.invalid');
    const path = url.pathname;
    if (path !== TERMINAL_WS_PATH) return; // other upgrades are not ours
    if (!isLoopbackPeer(request.socket.remoteAddress)) {
      socket.destroy(); // 403 equivalent for the WS upgrade gate (E-07-3 slot)
      return;
    }
    const headers = incomingHeaders(request);
    // Doc 08 §9 checklist step 14: a browser Origin header must name this
    // instance's host (x-forwarded-host/publicOrigin candidates included);
    // protocol never compares (edge-terminated TLS), absent origin passes.
    if (!originAdmittedByHeaders({
      originHeader: headers.get('origin'),
      hostHeader: headers.get('host'),
      forwardedHostHeader: headers.get('x-forwarded-host'),
    }, readPublicOrigin(), process.env.NOTNATIVE_DESKTOP_UI_ORIGIN)) {
      socket.destroy();
      return;
    }
    if (!admittedByGate(url, headers, request.method ?? 'GET', gate)) {
      socket.destroy(); // fail closed: a throwing gate must not crash the upgrade listener
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wireClient(client, runtime));
  };
  server.on('upgrade', onUpgrade);
  const ping = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.ping(); // protocol-level keepalive (15 s)
    }
  }, SERVER_WS_PING_INTERVAL_MS);
  return {
    dispose(): void {
      clearInterval(ping);
      server.off('upgrade', onUpgrade);
      for (const client of wss.clients) client.close();
      // section 4.8: clients that won't close get terminated after the 1 s race
      const escalation = setTimeout(() => {
        for (const client of wss.clients) client.terminate();
      }, TERMINAL_WS_CLOSE_GRACE_MS);
      escalation.unref();
      wss.close(() => { clearTimeout(escalation); });
    },
  };
}

function admittedByGate(url: URL, headers: Headers, method: string, gate: TerminalUpgradeGate | undefined): boolean {
  if (gate === undefined) return true;
  try {
    return gate(url, headers, method);
  } catch {
    return false;
  }
}

/** §9 gate input: multi-valued headers join with ", " so a DOUBLED Origin
 *  (or Host) stays a single unparseable value - dropping the extras would
 *  masquerade a disallowed origin as an absent one and pass the gate. */
export function incomingHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      headers.set(name, value.join(', '));
      continue;
    }
    if (typeof value === 'string') headers.set(name, value);
  }
  return headers;
}

function wireClient(client: WebSocket, runtime: TerminalRuntime): void {  const adapter = socketAdapter(client);
  client.send(encodeFrame({ v: 3, t: 'hello' }));
  client.on('message', (data: WebSocket.RawData) => {
    try {
      const result = runtime.handleSocketFrame(adapter, data);
      if (result.unknownSessionError !== undefined) adapter.send(result.unknownSessionError);
    } catch {
      adapter.send(encodeFrame({ v: 3, t: 'error', code: 'BAD_FRAME', fatal: false })); // intake must never crash the process
    }
  });
  const release = (): void => runtime.detachSocket(adapter); // a held dead attachment would block the idle reaper forever
  client.on('close', release);
  client.on('error', release);
}

function socketAdapter(client: WebSocket): SocketLike {
  return {
    send: (frame: Buffer): void => {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    },
    close: (): void => { client.close(); },
  };
}
