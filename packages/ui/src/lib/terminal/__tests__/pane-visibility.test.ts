// SPDX-License-Identifier: Apache-2.0
/** W-55: pane-visibility primitives + keepalive retained-pane gating. */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVisibilityGatedInterval, isDocumentVisible, subscribeDocumentVisibility } from '../../pane-visibility.ts';
import { startKeepaliveTouch, KEEPALIVE_TOUCH_MS, __resetObserverForTests } from '../observer.ts';
import * as serverApi from '../../server-api.ts';

describe('pane visibility (W-55)', () => {
  beforeEach(() => { touched.length = 0; __resetObserverForTests(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const touched: string[][] = [];

  it('reports document visibility and notifies subscribers on change', () => {
    expect(isDocumentVisible()).toBe(true);
    const seen: boolean[] = [];
    const stop = subscribeDocumentVisibility(visible => seen.push(visible));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    stop();
    expect(seen).toEqual([false, true]);
    expect(isDocumentVisible()).toBe(true);
  });

  it('the gated interval skips ticks while hidden and fires on return', () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    const stop = createVisibilityGatedInterval(() => ticks.push(ticks.length), 1_000);
    vi.advanceTimersByTime(3_000);
    expect(ticks.length).toBe(3);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); // still hidden: no catch-up tick
    vi.advanceTimersByTime(5_000);
    expect(ticks.length).toBe(3); // suppressed while hidden
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(ticks.length).toBe(4); // catch-up tick on return
    vi.advanceTimersByTime(2_000);
    expect(ticks.length).toBe(6); // resumes
    stop();
    vi.useRealTimers();
  });

  it('the terminal keepalive does not touch sessions while the window is hidden', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(serverApi, 'touchTerminalSessions').mockImplementation(async (ids: string[]) => { touched.push([...ids]); });
    const stop = startKeepaliveTouch(() => ['sess-1']);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_TOUCH_MS);
    expect(touched).toEqual([['sess-1']]);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await vi.advanceTimersByTimeAsync(KEEPALIVE_TOUCH_MS * 3);
    expect(touched.length).toBe(1); // suppressed while hidden
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await vi.advanceTimersByTimeAsync(KEEPALIVE_TOUCH_MS);
    expect(touched.length).toBe(2); // resumes when visible
    stop();
    vi.useRealTimers();
  });
});
