// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-tab executor channel (F7 scoped capability): an authenticated
 * browser tab of the NND app registers as a browser-control client so
 * inspection/capture/annotation can execute with Electron never launched.
 * The tab performs actions only against same-origin pages served through
 * the preview proxy; capture is DOM-mode and reports itself as such.
 */
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { authorizeDevTunnelUpgrade } from './dev-tunnel.ts';
import { incomingHeaders, incomingRequestUrl } from '../terminal/wire.ts';
import type { BrowserControlBroker, BrowserRequest, BrowserResult } from './browser-control-broker.ts';

const PATH = '/api/browser-control/ws';
const MAX_TAB_CLIENTS = 8;
const MAX_PAYLOAD_BYTES = 65_536;

export interface BrowserTabExecutorWiring { dispose(): void }

interface TabSession {
  id: string;
  release: () => void;
  socket: WebSocket;
}

function rawStatus(socket: import('node:net').Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function parseResult(value: unknown): BrowserResult | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { ok?: unknown; data?: unknown; error?: unknown };
  if (record.ok === true) return { ok: true, data: record.data };
  if (record.ok === false && typeof record.error === 'string') {
    return { ok: false, error: record.error.slice(0, 500) };
  }
  return null;
}

export function attachBrowserTabExecutor(server: HttpServer, broker: BrowserControlBroker): BrowserTabExecutorWiring {
  let disposed = false;
  let sequence = 0;
  const sessions = new Set<TabSession>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  const drop = (session: TabSession): void => {
    if (!sessions.delete(session)) return;
    session.release();
    try { session.socket.close(); } catch { session.socket.terminate(); }
  };

  const bind = (client: WebSocket, request: IncomingMessage): void => {
    sequence += 1;
    const id = 'tab-' + String(sequence);
    const session: TabSession = { id, release: () => undefined, socket: client };
    const send = (payload: unknown): void => {
      if (client.readyState === client.OPEN) client.send(JSON.stringify(payload));
    };
    session.release = broker.registerClient(id, true, (brokerRequest: BrowserRequest) => send({
      type: 'request', requestId: brokerRequest.requestId,
      action: brokerRequest.action, parameters: brokerRequest.parameters,
    }));
    sessions.add(session);
    send({ type: 'registered', id, peer: request.socket.remoteAddress ?? '' });
    client.on('message', (raw: RawData) => {
      let message: { type?: unknown; requestId?: unknown; result?: unknown };
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === 'claim' && typeof message.requestId === 'string') {
        send({ type: 'claimed', requestId: message.requestId, granted: broker.claim(message.requestId, id) });
      } else if (message.type === 'result' && typeof message.requestId === 'string') {
        const result = parseResult(message.result);
        if (result) broker.resolve(message.requestId, id, result);
      } else if (message.type === 'unregister') drop(session);
    });
    client.on('close', () => drop(session));
    client.on('error', () => drop(session));
  };

  const onUpgrade = (request: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void => {
    const url = incomingRequestUrl(request);
    if (!url || url.pathname !== PATH) return;
    if (disposed || sessions.size >= MAX_TAB_CLIENTS
      || !authorizeDevTunnelUpgrade(url, incomingHeaders(request))) {
      rawStatus(socket, '403 Forbidden');
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => bind(client, request));
  };
  server.on('upgrade', onUpgrade);

  return {
    dispose(): void {
      disposed = true;
      for (const session of [...sessions]) drop(session);
      wss.close();
    },
  };
}
