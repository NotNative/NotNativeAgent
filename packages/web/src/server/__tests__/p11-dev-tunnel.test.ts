// SPDX-License-Identifier: Apache-2.0
/** P11-24 focused host-end tests: auth matrix, transport bytes, and bounds. */
import { createServer, type Server } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData, type WebSocket as WireSocket } from 'ws';
import { attachDevTunnelWebsocket, authorizeDevTunnelUpgrade, parseDevTunnelTarget, relayConnection } from '../preview/dev-tunnel.ts';
import { getUiAuthController, installNativeUiAuth, resetUiAuthForTests } from '../lib/auth/ui-auth.ts';
import { incomingRequestUrl } from '../terminal/wire.ts';
import type { IncomingMessage } from 'node:http';

const dir = mkdtempSync(join(tmpdir(), 'nnd-p11-dev-tunnel-'));
process.env.NOTNATIVE_DATA_DIR = dir;
function environment(password: string): void {
  if (password.length === 0) delete process.env.NOTNATIVE_UI_PASSWORD;
  else process.env.NOTNATIVE_UI_PASSWORD = password;
  resetUiAuthForTests();
  return;
}
const clientToken = getUiAuthController().getClientStore().createClient({ label: 'desktop', clientKind: 'desktop' }).token;
const sessionToken = getUiAuthController().issueSessionToken(60_000).token;
afterAll(() => { delete process.env.NOTNATIVE_DATA_DIR; rmSync(dir, { recursive: true, force: true }); });

function target(token?: string): URL {
  const url = new URL('http://localhost/api/dev-tunnel?port=3000');
  if (token !== undefined) url.searchParams.set('oc_url_token', token);
  return url;
}

function mintedToken(): string {
  const controller = getUiAuthController();
  const headers = new Headers({ authorization: `Bearer ${clientToken}`, host: 'localhost' });
  const mint = controller.mintUrlTokenFromRequest(headers, new URL('http://localhost/api/dev-servers'), 'GET');
  return (mint.body as { token: string }).token;
}

describe('dev-tunnel contract', () => {
  afterEach(() => environment(''));

  it('parses only the exact path and bounded port', () => {
    expect(parseDevTunnelTarget('/api/dev-tunnel?port=3000')).toBe(3000);
    expect(parseDevTunnelTarget('/api/dev-tunnel/sub?port=3000')).toBeNull();
    expect(parseDevTunnelTarget('/api/dev-tunnel?port=0')).toBeNull();
    expect(parseDevTunnelTarget('/api/dev-tunnel?port=65536')).toBeNull();
  });

  it('uses the real upgrade Host and rejects malformed authority or absolute targets', () => {
    const parse = (url: string, host: string) => incomingRequestUrl({ url, headers: { host } } as IncomingMessage);
    expect(parse('/api/dev-tunnel?port=3000', '127.0.0.1:32145')?.origin).toBe('http://127.0.0.1:32145');
    expect(parse('/api/terminal/ws', '[::1]:32145')?.origin).toBe('http://[::1]:32145');
    for (const host of ['127.0.0.1:32145@evil.invalid', '127.0.0.1:32145/path', '127.0.0.1:99999']) {
      expect(parse('/api/dev-tunnel', host)).toBeNull();
    }
    expect(parse('http://evil.invalid/api/dev-tunnel', '127.0.0.1:32145')).toBeNull();
  });

  it('requires native authentication without a password and stops admission after revocation', () => {
    environment('');
    const origin = 'http://127.0.0.1:32145';
    const binding = installNativeUiAuth({ installationId: 'nna_'+'a'.repeat(64), dataId: 'data_'+'b'.repeat(64), generation: 'test-generation', origin });
    const url = new URL(origin+'/api/dev-tunnel?port=3000');
    const headers = new Headers({ host: url.host, origin, upgrade: 'websocket' });
    expect(authorizeDevTunnelUpgrade(url, headers)).toBe(false);
    const { ticket } = binding.controller.nativeHandle()!.issueTicket();
    const grant = binding.controller.nativeBootstrap({ ticket }, headers, new URL(origin+'/auth/native-bootstrap'), '127.0.0.1');
    headers.set('cookie', grant.setCookie!.split(';')[0]!);
    expect(authorizeDevTunnelUpgrade(url, headers)).toBe(true);
    binding.controller.close();
    expect(authorizeDevTunnelUpgrade(url, headers)).toBe(false);
    binding.release();
  });

  it('applies the H.2 auth matrix and exact URL-token target', () => {
    environment('secret');
    const tokenFromFresh = getUiAuthController().getClientStore().createClient({ label: 'tls-client', clientKind: 'desktop' }).token;
    const client = new Headers({ authorization: `Bearer ${tokenFromFresh}`, host: 'localhost' });
    const browser = new Headers(client);
    browser.set('origin', 'http://localhost/dev');
    const foreign = new Headers(client);
    foreign.set('origin', 'http://evil.invalid/');
    const session = new Headers({ cookie: `oc_ui_session=${sessionToken}`, host: 'localhost', upgrade: 'websocket' });
    expect(authorizeDevTunnelUpgrade(target(), client)).toBe(true);
    expect(authorizeDevTunnelUpgrade(target(), browser)).toBe(true);
    expect(authorizeDevTunnelUpgrade(target(), foreign)).toBe(false);
    expect(authorizeDevTunnelUpgrade(target(), session)).toBe(false);
    const token = mintedToken();
    expect(authorizeDevTunnelUpgrade(target(token), session)).toBe(true);
    expect(authorizeDevTunnelUpgrade(new URL(`http://localhost/api/dev-tunnel/sub?port=3000&oc_url_token=${token}`), session)).toBe(false);
    environment('');
    expect(authorizeDevTunnelUpgrade(target(), new Headers({ host: 'localhost' }))).toBe(true);
  });

});

describe('dev-tunnel transport', () => {
  let wiring: ReturnType<typeof attachDevTunnelWebsocket> | undefined;
  let http: HttpServer | undefined;
  let relay: Server | undefined;

  afterEach(async () => {
    wiring?.dispose();
    wiring = undefined;
    if (http !== undefined) await new Promise<void>((resolve) => http!.close(() => resolve()));
    http = undefined;
    if (relay !== undefined) await new Promise<void>((resolve) => relay!.close(() => resolve()));
    relay = undefined;
  });

  async function fixture(): Promise<{ httpPort: number; relayPort: number; attempts: { count: number } }> {
    relay = createServer((socket) => socket.pipe(socket));
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    const relayPort = (relay.address() as { port: number }).port;
    http = createHttpServer();
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const httpPort = (http.address() as { port: number }).port;
    const attempts = { count: 0 };
    wiring = attachDevTunnelWebsocket(http, {
      availablePorts: async () => { attempts.count += 1; return [relayPort]; },
      dialTimeoutMs: 20,
    });
    return { httpPort, relayPort, attempts };
  }

  it('relays bytes both directions and closes symmetrically', async () => {
    const { httpPort, relayPort } = await fixture();
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/api/dev-tunnel?port=${relayPort}`);
    await once(ws, 'open');
    const browserBytes = new Promise<Buffer>((resolve) => ws.once('message', (data: RawData) => resolve(data as Buffer)));
    ws.send('client-up');
    await expect(browserBytes).resolves.toEqual(Buffer.from('client-up'));
    ws.close();
    await once(ws, 'close');
  });

  it('disposal terminates an established tunnel and its upstream connection', async () => {
    const { httpPort, relayPort } = await fixture();
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/api/dev-tunnel?port=${relayPort}`);
    await once(ws, 'open');
    const closed = once(ws, 'close');
    wiring!.dispose();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('does not admit an upgrade whose discovery completes after disposal', async () => {
    const { httpPort, relayPort } = await fixture();
    wiring!.dispose();
    let finish!: (ports: number[]) => void;
    let entered!: () => void;
    const discovered = new Promise<void>((resolve) => { entered = resolve; });
    wiring = attachDevTunnelWebsocket(http!, { availablePorts: () => { entered(); return new Promise((resolve) => { finish = resolve; }); } });
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/api/dev-tunnel?port=${relayPort}`);
    const rejected = new Promise<void>((resolve) => ws.once('error', () => resolve()));
    await discovered;
    wiring.dispose();
    finish([relayPort]);
    await rejected;
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
  });

  it('403s an unavailable port before upstream dialing', async () => {
    const { httpPort, attempts } = await fixture();
    const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/api/dev-tunnel?port=9999`);
    const status = await new Promise<number>((resolve) => {
      ws.once('error', (error: Error) => resolve(error.message.includes('403') ? 403 : 0));
      ws.once('open', () => resolve(101));
      setTimeout(() => resolve(-1), 100);
    });
    expect(status).toBe(403);
  });

  it('caps 64 open sockets per host and uses fresh discovery for every upgrade', async () => {
    const fixturePorts = await fixture();
    const opened: WebSocket[] = [];
    for (let index = 0; index < 64; index += 1) {
      const ws = new WebSocket(`ws://127.0.0.1:${fixturePorts.httpPort}/api/dev-tunnel?port=${fixturePorts.relayPort}`);
      await once(ws, 'open');
      opened.push(ws);
      expect(fixturePorts.attempts.count).toBe(index + 1);
    }
    const declined = new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${fixturePorts.httpPort}/api/dev-tunnel?port=${fixturePorts.relayPort}`);
      ws.once('error', () => resolve());
      ws.once('open', () => resolve());
    });
    await declined;
    expect(fixturePorts.attempts.count).toBe(64);
    for (const ws of opened) ws.terminate();
  });

  it('reserves the per-host cap before concurrent discovery finishes', async () => {
    const fixturePorts = await fixture();
    const sockets: WebSocket[] = [];
    const outcomes = await Promise.all(Array.from({ length: 65 }, () => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${fixturePorts.httpPort}/api/dev-tunnel?port=${fixturePorts.relayPort}`);
      sockets.push(ws);
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    })));
    expect(outcomes.filter((outcome) => outcome === 'open')).toHaveLength(64);
    expect(fixturePorts.attempts.count).toBe(64);
    for (const ws of sockets) ws.terminate();
  });

  it('closes a stalled upstream dial after the 5-second-equivalent timeout', async () => {
    const client = new EventEmitter() as WireSocket;
    const requester = new EventEmitter() as never as import('node:net').Socket;
    const upstream = new EventEmitter() as never as import('node:net').Socket;
    client.close = vi.fn(() => undefined);
    client.terminate = vi.fn(() => {
      Object.defineProperty(client, 'readyState', { value: WebSocket.CLOSED, configurable: true });
      (client as EventEmitter).emit('close');
    });
    (requester as unknown as { destroy: (error?: Error) => void }).destroy = vi.fn((error?: Error) => { if (error) throw error; });
    (upstream as unknown as { destroy: (error?: Error) => void }).destroy = vi.fn((error?: Error) => { if (error) throw error; });
    (upstream as unknown as { setNoDelay: (value: boolean) => void }).setNoDelay = vi.fn(() => undefined);
    Object.defineProperty(client, 'readyState', { value: 'OPEN', configurable: true });
    const upstreamFactory = vi.fn(() => upstream);
    relayConnection(client, requester, 3000, 10, 10, upstreamFactory);
    await expect(new Promise((resolve) => client.once('close', () => resolve('close')))).resolves.toBe('close');
    expect(upstreamFactory).toHaveBeenCalledOnce();
    expect(upstream.destroy).toHaveBeenCalled();
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });

  it('pauses upstream reads above 1 MB and resumes on the poll', async () => {
    const echo = createServer((socket) => socket.pipe(socket));
    echo.listen(0, '127.0.0.1');
    await once(echo, 'listening');
    const port = (echo.address() as { port: number }).port;
    const client = new EventEmitter() as WireSocket;
    const requester = new EventEmitter() as never as import('node:net').Socket;
    client.close = vi.fn(() => undefined);
    client.terminate = vi.fn(() => undefined);
    (requester as unknown as { destroy: (error?: Error) => void }).destroy = vi.fn((error?: Error) => { if (error) throw error; });
    Object.defineProperty(client, 'readyState', { value: 'OPEN' });
    Object.defineProperty(client, 'bufferedAmount', { value: 0, configurable: true });
    let paused = false;
    let resumed = 0;
    const real = connect({ host: '127.0.0.1', port });
    const factory = vi.fn(() => {
      Object.defineProperties(real, {
        pause: { value: () => { paused = true; } },
        resume: { value: () => { paused = false; resumed += 1; } },
      });
      return real;
    });
    const closed = new Promise((resolve) => client.once('close', resolve));
    relayConnection(client, requester, port, 5_000, 10, factory);
    await once(real, 'connect');
    Object.defineProperty(client, 'bufferedAmount', { value: 1_000_001, configurable: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(paused).toBe(true);
    Object.defineProperty(client, 'bufferedAmount', { value: 0, configurable: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(paused).toBe(false);
    expect(resumed).toBeGreaterThan(0);
    closed.then(() => real.destroy());
    (client as EventEmitter).emit('close');
    await closed;
    echo.close();
    void client; void requester;
  });
});
