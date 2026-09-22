// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * RealTerminalApi (SLICE-B): wire-frame → RuntimeAPIs TerminalStreamEvent
 * projection (snapshot/restarted/output/exit/reconnecting, hello·pong
 * suppressed), createSession result mapping (ok/!ok), socket writes with
 * {t:'write'}, and close() riding the DELETE endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';

vi.mock('../../server-api.ts', () => ({
  closeTerminalSession: vi.fn(async () => true),
  createTerminalSession: vi.fn(async () => ({ ok: true, sessionId: 'made', cols: 100, rows: 30, status: 'running', mode: 'interactive' as const, purpose: { type: 'terminal' as const } })),
  listTerminalShells: vi.fn(async () => [{ id: 'pwsh', name: 'PowerShell', bin: 'pwsh.exe' }]),
  resizeTerminalSession: vi.fn(async () => true),
}));

import { createTerminalSession, closeTerminalSession } from '../../server-api.ts';
import { createRealTerminalApi, wireFrameToStreamEvent } from '../terminal-adapter.ts';
import { setTerminalTransportFactory, __resetTerminalTransportForTests } from '../../terminal/transport-singleton.ts';
import { encodeTerminalFrame, type TerminalEventFrame, type WireSocket, type WebSocketFactory } from '../../terminal/wire.ts';

interface FakeSocket extends WireSocket {
  sent: string[];
}

let lastSocket: FakeSocket | null = null;

function transportFactory(): WebSocketFactory {
  return (): FakeSocket => {
    const socket: FakeSocket = {
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      sent: [],
      send: (data) => { socket.sent.push(String.fromCharCode(...Array.from(data as Uint8Array))); },
      close: () => undefined,
    };
    lastSocket = socket;
    setTimeout(() => socket.onopen?.(), 0);
    return socket;
  };
}

async function pushInbound(frame: TerminalEventFrame): Promise<void> {
  const bytes = Buffer.from(encodeTerminalFrame(frame));
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  lastSocket?.onmessage?.({ data: exact });
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  __resetTerminalTransportForTests();
  setTerminalTransportFactory(transportFactory());
});

afterEach(() => {
  __resetTerminalTransportForTests();
  lastSocket = null;
});

describe('RealTerminalApi (SLICE-B terminal wiring)', () => {
  it('projects wire frames onto the RuntimeAPIs stream contract', () => {
    expect(wireFrameToStreamEvent({ v: 3, t: 'hello' })).toBeNull();
    expect(wireFrameToStreamEvent({ v: 3, t: 'pong' })).toBeNull();
    const snapshot = wireFrameToStreamEvent({ v: 3, t: 'snapshot', s: 'a', q: 4, history: 'ready$ ', cols: 80, rows: 24, status: 'running' });
    expect(snapshot).toEqual({ type: 'snapshot', sequence: 4, data: 'ready$ ', cols: 80, rows: 24, status: 'running' });
    const exited = wireFrameToStreamEvent({ v: 3, t: 'snapshot', s: 'a', q: 5, history: '', cols: 80, rows: 24, status: 'exited', exitCode: 2, signal: 1 });
    expect(exited).toEqual({ type: 'snapshot', sequence: 5, data: '', cols: 80, rows: 24, status: 'exited', exitCode: 2, signal: 1 });
    expect(wireFrameToStreamEvent({ v: 3, t: 'restarted', s: 'a', q: 6, history: '' })).toEqual({ type: 'snapshot', sequence: 6, data: '' });
    expect(wireFrameToStreamEvent({ v: 3, t: 'output', s: 'a', q: 7, d: 'f', r: 'ff' })).toEqual({ type: 'data', sequence: 7, data: 'ff' });
    expect(wireFrameToStreamEvent({ v: 3, t: 'output', s: 'a', q: 8, d: 'f' })).toEqual({ type: 'data', sequence: 8, data: 'f' });
    expect(wireFrameToStreamEvent({ v: 3, t: 'exit', s: 'a', q: 9, exitCode: 0 })).toEqual({ type: 'exit', exitCode: 0, signal: null, status: 'exited' });
    expect(wireFrameToStreamEvent({ v: 3, t: 'reconnecting', s: 'a', attempt: 2 })).toEqual({ type: 'reconnecting', attempt: 2 });
  });

  it('createSession maps the REST result; a refusal throws', async () => {
    const api = createRealTerminalApi();
    const created = await api.createSession({ cwd: '/x', cols: 100, rows: 30 });
    expect(created).toMatchObject({ sessionId: 'made', cols: 100, rows: 30, status: 'running' });
    expect(createTerminalSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/x', cols: 100, rows: 30 }));
    (createTerminalSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ ok: false, error: 'no pty backend' }));
    await expect(api.createSession({ cwd: '/x' })).rejects.toThrow('no pty backend');
  });

  it('connect pipes projected events; sendInput writes; close rides DELETE', async () => {
    const api = createRealTerminalApi();
    const events: unknown[] = [];
    const subscription = api.connect('s1', {
      onEvent: (event) => events.push(event),
      onError: (error) => events.push({ error }),
    });
    await pushInbound({ v: 3, t: 'snapshot', s: 's1', q: 1, history: 'hi', cols: 80, rows: 24, status: 'running' });
    api.sendInput('s1', 'ls\r');
    const writeFrame = JSON.parse(lastSocket!.sent.map((row) => row.slice(1)).find((body) => body.includes('"write"'))!) as { t: string; s: string; d: string };
    expect(writeFrame).toMatchObject({ t: 'write', s: 's1', d: 'ls\r' });
    expect(events).toEqual([{ type: 'snapshot', sequence: 1, data: 'hi', cols: 80, rows: 24, status: 'running' }]);
    subscription.close();
    await api.close!('s1');
    expect(closeTerminalSession).toHaveBeenCalledWith('s1');
  });
});
