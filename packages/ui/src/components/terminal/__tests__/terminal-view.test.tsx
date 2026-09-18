// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * TerminalView flow gates (doc 07 Flow 1 + sections 6.3/6.4): create with
 * sessionId = tabId at provisional size, transport subscribe after the
 * session resolves, snapshot REPLACES the buffer and is rendered, quick
 * keys send the documented control sequences, the input line writes with
 * CR, Ctrl+C clears the UI line, exit appends the localized line, a failed
 * create marks exited and never re-creates automatically, and the kill
 * button rides the force-kill endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { Buffer } from 'node:buffer';

vi.mock('../../../lib/server-api.ts', () => ({
  closeTerminalSession: vi.fn(async () => true),
  createTerminalSession: vi.fn(async (request: { sessionId?: string }) => ({ ok: true, sessionId: request.sessionId ?? 'made', cols: 80, rows: 24, status: 'running', mode: 'interactive' as const, purpose: { type: 'terminal' as const } })),
  listTerminalShells: vi.fn(async () => []),
  listTerminalSessions: vi.fn(async () => []),
  restartTerminalSession: vi.fn(async () => true),
  resizeTerminalSession: vi.fn(async () => true),
  forceKillTerminals: vi.fn(async () => ({ ok: true, killedCount: 1 })),
}));

import { createTerminalSession, forceKillTerminals } from '../../../lib/server-api.ts';
import { TerminalView } from '../TerminalView.tsx';
import { I18nProvider } from '../../I18nProvider.tsx';
import { __resetTerminalsForTests, getTerminalBuffer, normalizeTerminalDirectory, useTerminalStore } from '../../../lib/terminal/store.ts';
import { setTerminalTransportFactory, __resetTerminalTransportForTests } from '../../../lib/terminal/transport-singleton.ts';

import { encodeTerminalFrame, type TerminalEventFrame, type WireSocket, type WebSocketFactory } from '../../../lib/terminal/wire.ts';

const DIR = '/termproj';

interface FakeSocket extends WireSocket {
  sent: string[];
}

let lastSocket: FakeSocket | null = null;

function transportFactory(): WebSocketFactory {
  return (url: string): FakeSocket => {
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
    void url;
    return socket;
  };
}

async function pushInbound(frame: TerminalEventFrame): Promise<void> {
  const bytes = Buffer.from(encodeTerminalFrame(frame));
  const exact = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  lastSocket?.onmessage?.({ data: exact });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function sentFrames(): { t: string; s?: string; d?: string }[] {
  return (lastSocket?.sent ?? []).map((row) => JSON.parse(row.slice(1)) as { t: string; s?: string; d?: string });
}

let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;

async function renderView(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(<I18nProvider><TerminalView directory={DIR} visible /></I18nProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 10));
    await Promise.resolve();
  });
}

async function typeAndSubmit(value: string): Promise<void> {
  const login = document.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(login, value);
    login.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    login.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  __resetTerminalsForTests();
  __resetTerminalTransportForTests();
  setTerminalTransportFactory(transportFactory());
  document.body.innerHTML = '';
  (createTerminalSession as unknown as ReturnType<typeof vi.fn>).mockClear();
});

afterEach(() => {
  __resetTerminalTransportForTests();
  try {
    act(() => rootHandle?.unmount());
  } finally {
    container?.remove();
    container = null;
    rootHandle = null;
    lastSocket = null;
  }
});

describe('TerminalView flow (doc 07 Flow 1 v1)', () => {
  it('creates with sessionId=tabId at 80x24, subscribes, replays the snapshot, writes input + quick keys', async () => {
    await renderView();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((done) => setTimeout(done, 5));
    });
    expect(createTerminalSession).toHaveBeenCalledTimes(1);
    const request = (createTerminalSession as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { cwd: string; sessionId: string; cols: number; rows: number };
    expect(request.cwd).toBe(DIR);
    expect(request.cols).toBe(80);
    expect(request.rows).toBe(24);
    const key = normalizeTerminalDirectory(DIR);
    const tab = useTerminalStore.getState().dirs[key]!.tabs[0]!;
    expect(request.sessionId).toBe(tab.id); // section F1 step 5: sessionId = tabId

    const attach = sentFrames().find((frame) => frame.t === 'attach');
    expect(attach).toEqual({ v: 3, t: 'attach', s: request.sessionId });

    await pushInbound({ v: 3, t: 'snapshot', s: request.sessionId, q: 1, history: 'ready$ ', cols: 80, rows: 24, status: 'running' });


    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.querySelector('[data-testid="terminal-text"]')?.textContent).toBe('ready$ '); // snapshot REPLACES the buffer

    await typeAndSubmit('ls');
    const writes = sentFrames().filter((frame) => frame.t === 'write');
    expect(writes.at(-1)!.d).toBe('ls\r'); // CR per section 6.4
    await act(async () => {
      (document.querySelector('[data-testid="terminal-quick-key-Ctrl+C"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(sentFrames().some((frame) => frame.t === 'write' && frame.d === '\u0003')).toBe(true); // 0x03 per section 6.4
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      const input = document.querySelector('[data-testid="terminal-input"]') as HTMLInputElement;
      setter.call(input, 'pending line'); // typed text the shell would read as its input line
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect((document.querySelector('[data-testid="terminal-input"]') as HTMLInputElement).value).toBe('pending line');
    await act(async () => {
      (document.querySelector('[data-testid="terminal-quick-key-Ctrl+C"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect((document.querySelector('[data-testid="terminal-input"]') as HTMLInputElement).value).toBe(''); // SIGINT cancels the UI line too
    await pushInbound({ v: 3, t: 'exit', s: request.sessionId, q: 2, exitCode: 3 });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(getTerminalBuffer(key, tab.id).text.includes('[process exited (code 3)]')).toBe(true);
    await act(async () => {
      (document.querySelector('[data-testid="terminal-kill-session"]') as HTMLElement).click();
      await Promise.resolve();
    });
    expect(forceKillTerminals).toHaveBeenCalledWith({ sessionId: request.sessionId }); // Kill = force-kill endpoint (section 3.7)
  });

  it('a failed create marks exited and never re-creates automatically (no create storm)', async () => {
    (createTerminalSession as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ ok: false, error: 'shell not available' }));
    await renderView();
    await act(async () => {
      await Promise.resolve();
      await new Promise((done) => setTimeout(done, 10));
    });
    expect(createTerminalSession).toHaveBeenCalledTimes(1); // one attempt
    const key = normalizeTerminalDirectory(DIR);
    const tab = useTerminalStore.getState().dirs[key]!.tabs[0]!;
    expect(tab.lifecycle).toBe('exited'); // demoted, awaiting user action
    await act(async () => {
      await Promise.resolve();
      await new Promise((done) => setTimeout(done, 20));
    });
    expect(createTerminalSession).toHaveBeenCalledTimes(1); // still one: exited is never re-created
  });
});
