// SPDX-License-Identifier: Apache-2.0
/** P11-24 §H.5 tests: reusable direct transport and bounded pending bytes. */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevTunnelClient, toWebSocketUrl } from '../lib/dev-tunnel/client.mjs';

class FakeWebSocket extends EventEmitter {
  readyState = 0;
  close = vi.fn(() => this.terminate());
  terminate = vi.fn(() => {
    Object.defineProperty(this, 'readyState', { value: 3, configurable: true });
    this.emit('close');
  });
  send = vi.fn((_data, _options) => this.emit('sent', _data));
}

describe('direct dev-tunnel contract', () => {
  it('rejects non-special schemes before conversion', () => {
    expect(toWebSocketUrl('http://example.invalid:8000/base?x=1').href).toBe('ws://example.invalid:8000/base?x=1');
    expect(toWebSocketUrl('https://example.invalid/base').protocol).toBe('wss:');
    expect(() => toWebSocketUrl('app://relay-virtual/base')).toThrow(RangeError);
    expect(() => toWebSocketUrl('file:///dev/null')).toThrow(RangeError);
  });
});

describe('direct dev-tunnel transport', () => {
  type Cleanup = () => Promise<void>;
  const cleanups: Cleanup[] = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  async function listenTCP(): Promise<{ server: Server; port: number }> {
    const server = createServer((socket) => socket.on('data', (data) => socket.write(data)));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { server, port: (server.address() as { port: number }).port };
  }

  it('opens one reusable listener per runtime base and target port', async () => {
    const upstream = await listenTCP();
    const urls: URL[] = [];
    const headersSeen: Record<string, string>[] = [];
    const client = createDevTunnelClient({
      connectWebSocket: (url, headers) => {
        urls.push(url);
        headersSeen.push(headers);
        const socket = new FakeWebSocket();
        setTimeout(() => { socket.readyState = 1; socket.emit('open'); }, 5);
        return socket;
      },
    });
    cleanups.push(async () => client.closeAll());
    const first = await client.open({ baseUrl: 'http://example.invalid:8000', port: upstream.port, clientToken: 'test-client-token' });
    const second = await client.open({ baseUrl: 'http://example.invalid:8000', port: upstream.port });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.localPort).toBe(first.localPort);
    connect(first.localPort, '127.0.0.1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).toHaveLength(1);
    expect(urls[0]!.href).toBe(`ws://example.invalid:8000/api/dev-tunnel?port=${upstream.port}`);
    expect(headersSeen[0]!.authorization).toBe('Bearer test-client-token');
    expect(first.url).toBe(`http://127.0.0.1:${first.localPort}/`);
  });

  it('reuses one pending open across simultaneous callers', async () => {
    const upstream = await listenTCP();
    let openConnections = 0;
    const client = createDevTunnelClient({
      connectWebSocket: () => {
        openConnections += 1;
        const socket = new FakeWebSocket();
        socket.readyState = 1;
        setTimeout(() => socket.emit('open'), 10);
        return socket;
      },
    });
    cleanups.push(async () => client.closeAll());
    const [a, b] = await Promise.all([
      client.open({ baseUrl: 'http://example.invalid', port: upstream.port }),
      client.open({ baseUrl: 'http://example.invalid', port: upstream.port }),
    ]);
    expect(a.localPort).toBe(b.localPort);
    expect([a.reused, b.reused]).toEqual([false, true]);
    expect(a.url).toBe(b.url);
    expect(openConnections).toBe(0);
    connect(a.localPort, '127.0.0.1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openConnections).toBe(1);
  });

  it('buffers first pending bytes until its own handshake completes', async () => {
    const upstream = await listenTCP();
    const socket = new FakeWebSocket();
    socket.readyState = 0;
    const client = createDevTunnelClient({ connectWebSocket: () => socket });
    cleanups.push(async () => client.closeAll());
    const opened = client.open({ baseUrl: 'http://example.invalid', port: upstream.port });
    socket.readyState = 1;
    socket.emit('open');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tunnel = await opened;
    socket.readyState = 0;
    const source: Socket = connect(tunnel.localPort, '127.0.0.1');
    await once(source, 'connect');
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.write('pending-request');
    socket.readyState = 1;
    socket.emit('open');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.send).toHaveBeenCalled();
    expect(String((socket.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1)![0])).toBe('pending-request');
    source.destroy();
  });

  it('terminates a pending WebSocket when its local source disconnects', async () => {
    const upstream = await listenTCP();
    const socket = new FakeWebSocket();
    socket.readyState = 0;
    const client = createDevTunnelClient({ connectWebSocket: () => socket });
    cleanups.push(async () => client.closeAll());
    const opened = client.open({ baseUrl: 'http://example.invalid', port: upstream.port });
    socket.readyState = 1;
    socket.emit('open');
    const tunnel = await opened;
    const source = connect(tunnel.localPort, '127.0.0.1');
    await once(source, 'connect');
    source.destroy();
    await once(source, 'close');
    expect(socket.terminate).toHaveBeenCalled();
  });

  it('destroys only an overflowing connection and keeps peers alive', async () => {
    const upstream = await listenTCP();
    const socket = new FakeWebSocket();
    socket.readyState = 1;
    const connections: FakeWebSocket[] = [];
    const client = createDevTunnelClient({
      connectWebSocket: () => {
        const connection = new FakeWebSocket();
        connection.readyState = 1;
        connections.push(connection);
        return connection;
      },
      maxPendingBytes: 100,
    });
    cleanups.push(async () => client.closeAll());
    const opened = client.open({ baseUrl: 'http://example.invalid', port: upstream.port });
    socket.emit('open');
    const tunnel = await opened;
    const oversize: Socket = connect(tunnel.localPort, '127.0.0.1');
    const peer: Socket = connect(tunnel.localPort, '127.0.0.1');
    await once(oversize, 'connect');
    await once(peer, 'connect');
    oversize.write(Buffer.alloc(50));
    await new Promise((resolve) => setTimeout(resolve, 10));
    oversize.end(Buffer.alloc(51));
    await expect(vi.waitFor(() => { expect(oversize.destroyed).toBe(true); }, { timeout: 200 })).resolves.toBeUndefined();
    connections[0]!.emit('close');
    connections[1]!.readyState = 1;
    connections[1]!.emit('open');
    const peerReply = new Promise<Buffer>((resolve) => connections[1]!.once('sent', resolve));
    peer.write('peer-ok');
    expect(await peerReply).toEqual(Buffer.from('peer-ok'));
    expect(connections[1]!.readyState).toBe(1);
    oversize.destroy();
    peer.destroy();
  });
});
