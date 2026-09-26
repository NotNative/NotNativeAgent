// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const ipc = { listeners: new Map() };
import { createInvokeFace } from '../../../../electron/ipc-face.mjs';

function setup() {
  ipc.listeners.clear();
  const sender = new EventEmitter();
  sender.id = 42;
  sender.mainFrame = { processId: 7, routingId: 1, url: 'http://127.0.0.1:57123/' };
  sender.sent = [];
  sender.send = (channel, payload) => sender.sent.push({ channel, payload });
  const release = vi.fn();
  const broker = { registerClient: vi.fn().mockReturnValue(release), claim: vi.fn().mockReturnValue(true),
    resolve: vi.fn().mockReturnValue(true) };
  createInvokeFace({ origin: () => 'http://127.0.0.1:57123', appPathPrefix: () => 'file:///nnd',
    bootInfo: () => ({}), mainContents: () => sender, browserControl: () => broker },
  { ipcMain: { on: (name, listener) => ipc.listeners.set(name, listener) },
    shell: { openExternal: vi.fn().mockResolvedValue(undefined) } }).register();
  const send = (command, payload = {}, frame = sender.mainFrame) => {
    ipc.listeners.get('nnd:desktop-invoke')({ sender, senderFrame: frame, frames: [frame] },
      { seq: sender.sent.length + 1, command, payload });
    return sender.sent.at(-1).payload;
  };
  return { sender, broker, release, send };
}

describe('desktop browser IPC identity boundary', () => {
  it('refuses a child frame, then binds claim and result to main sender id', () => {
    const { sender, broker, send } = setup();
    expect(send('desktop_browser_register', {}, { processId: 7, routingId: 2,
      url: 'http://127.0.0.1:57123/' }).error).toBe('desktop-main-frame-required');
    expect(broker.registerClient).not.toHaveBeenCalled();
    expect(send('desktop_browser_register').ok).toBe(true);
    const [id, capable, emit] = broker.registerClient.mock.calls[0];
    expect(id).toBe('42'); expect(capable).toBe(true);
    emit({ requestId: 'browser-00000000-0000-0000-0000-000000000001', action: 'browser.snapshot', parameters: {} });
    expect(sender.sent.at(-1).channel).toBe('nnd:browser-request');
    const requestId = 'browser-00000000-0000-0000-0000-000000000001';
    expect(send('desktop_browser_claim', { requestId, clientId: 'spoofed' }).result.granted).toBe(true);
    expect(broker.claim).toHaveBeenCalledWith(requestId, '42');
    expect(send('desktop_browser_result', { requestId, clientId: 'spoofed',
      result: { ok: true, data: { title: 'Ready' } } }).result.matched).toBe(true);
    expect(broker.resolve).toHaveBeenCalledWith(requestId, '42', { ok: true, data: { title: 'Ready' } });
  });

  it('unregisters without listener leaks and drops a client on main navigation', () => {
    const { sender, release, send } = setup();
    expect(send('desktop_browser_register').ok).toBe(true);
    expect(sender.listenerCount('destroyed')).toBe(1);
    expect(sender.listenerCount('did-start-navigation')).toBe(1);
    expect(send('desktop_browser_unregister').ok).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(sender.listenerCount('destroyed')).toBe(0);
    expect(sender.listenerCount('did-start-navigation')).toBe(0);
    expect(send('desktop_browser_register').ok).toBe(true);
    sender.emit('did-start-navigation', { isMainFrame: true, isInPlace: false });
    expect(release).toHaveBeenCalledTimes(2);
    expect(send('desktop_browser_claim', { requestId: 'browser-00000000-0000-0000-0000-000000000001' }).error)
      .toBe('browser-client-not-registered');
  });
});
