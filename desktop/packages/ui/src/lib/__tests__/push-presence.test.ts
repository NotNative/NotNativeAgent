// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pushPresenceId, startPushPresence } from '../push-presence.ts';
import type { PushApi } from '../api/push-types.ts';

function surface() {
  const fakeWindow = new EventTarget();
  let focused = true; let visible = true; let current = true;
  const fakeDocument = Object.assign(new EventTarget(), { hasFocus: () => focused });
  Object.defineProperty(fakeDocument, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
  const send = vi.fn().mockResolvedValue({ ok: true });
  const stop = startPushPresence({ api: { setVisibility: send } as unknown as PushApi, clientId: 'tab', current: () => current,
    window: fakeWindow as unknown as Window, document: fakeDocument as unknown as Document });
  return { send, stop, focus: (value: boolean) => { focused = value; fakeWindow.dispatchEvent(new Event(value ? 'focus' : 'blur')); },
    visible: (value: boolean) => { visible = value; fakeDocument.dispatchEvent(new Event('visibilitychange')); },
    close: () => fakeWindow.dispatchEvent(new Event('pagehide')), show: () => fakeWindow.dispatchEvent(new Event('pageshow')),
    switch: () => { current = false; } };
}
afterEach(() => vi.useRealTimers());
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('push presence lifecycle', () => {
  it('creates random window identity without secure-context-only randomUUID', () => {
    const source = { getRandomValues: vi.fn((bytes: Uint8Array) => bytes.fill(171)) };
    expect(pushPresenceId(source as unknown as Crypto)).toBe('ab'.repeat(16));
    expect(source.getRandomValues).toHaveBeenCalledOnce();
  });
  it('does not reassert a pagehide lease until pageshow, including BFCache restoration', async () => {
    vi.useFakeTimers(); const item = surface(); await settle();
    item.close(); await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    item.focus(true); await settle();
    expect(item.send.mock.calls.slice(1).every(([presence]) => presence.visible === false)).toBe(true);
    item.show(); await settle();
    expect(item.send).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    item.stop();
  });
  it('heartbeats and releases the window lease on disposal', async () => {
    vi.useFakeTimers(); const item = surface();
    expect(item.send).toHaveBeenLastCalledWith({ visible: true, clientId: 'tab', sequence: 1, platform: 'web' });
    await settle(); await vi.advanceTimersByTimeAsync(20_000);
    expect(item.send).toHaveBeenCalledTimes(2);
    item.stop(); await settle();
    expect(item.send).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false, sequence: 3 }));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(item.send).toHaveBeenCalledTimes(3);
  });
  it('reports focus, visibility and closure without overlapping writes', async () => {
    const item = surface(); await settle();
    let resolve: () => void = () => {};
    item.send.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    item.focus(false); item.focus(true); item.visible(false);
    expect(item.send).toHaveBeenCalledTimes(2);
    resolve(); await settle();
    expect(item.send).toHaveBeenCalledTimes(2); // latest remains hidden, so no redundant write
    item.visible(true); await settle();
    expect(item.send).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
    item.close(); await settle();
    expect(item.send).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    item.stop();
  });
  it('does not send disposal or pending continuation into a different runtime', async () => {
    const item = surface(); await settle(); item.switch(); item.stop();
    await settle(); expect(item.send).toHaveBeenCalledTimes(1);
  });
  it('retries after failure on the next heartbeat', async () => {
    vi.useFakeTimers(); const item = surface(); await settle();
    item.send.mockRejectedValueOnce(new Error('offline'));
    item.focus(false); await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(item.send).toHaveBeenCalledTimes(3);
    item.stop();
  });
});
