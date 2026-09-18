// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Session observer gates (doc 07 section 7.3): 5 s cadence while visible
 * and online, coalesced in-flight requests (one request per tick across
 * consumers), immediate wake only when visible+online (hide is a pause),
 * the last unsubscribe closes the loop and deletes the scope (dead
 * directory scopes cannot accumulate), keepalive touch fires each 10 min
 * for non-empty id lists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server-api.ts', () => ({
  listTerminalSessions: vi.fn(async () => []),
  touchTerminalSessions: vi.fn(async () => undefined),
}));

import { listTerminalSessions, touchTerminalSessions } from '../../server-api.ts';
import { KEEPALIVE_TOUCH_MS, OBSERVER_CADENCE_MS, __resetObserverForTests, observeTerminalSessions, startKeepaliveTouch } from '../observer.ts';

const DIR = '/observed';

/** Fake timers advance synchronously; the in-flight promise chain settles
 * on microtasks, so a drain between advances lets the next tick fire. */
async function drainJobs(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  (listTerminalSessions as unknown as ReturnType<typeof vi.fn>).mockClear();
  (touchTerminalSessions as unknown as ReturnType<typeof vi.fn>).mockClear();
  __resetObserverForTests();
});

afterEach(() => {
  __resetObserverForTests();
});

describe('observeTerminalSessions (doc 07 section 7.3)', () => {
  it('polls on the 5 s cadence while visible+online and wakes on focus', async () => {
    vi.useFakeTimers();
    const stop = observeTerminalSessions(DIR, () => undefined);
    expect(listedCalls()).toBe(1); // immediate refresh on mount
    await drainJobs(); // the request settles; the next tick may fire a new one
    vi.advanceTimersByTime(OBSERVER_CADENCE_MS);
    await drainJobs();
    vi.advanceTimersByTime(OBSERVER_CADENCE_MS);
    await drainJobs();
    expect(listedCalls()).toBe(3);
    window.dispatchEvent(new Event('focus'));
    expect(listedCalls()).toBe(4); // immediate wake
    stop();
    vi.advanceTimersByTime(OBSERVER_CADENCE_MS * 3);
    await drainJobs();
    expect(listedCalls()).toBe(4); // loop closed with the listener
    vi.useRealTimers();
  });

  it('an in-flight request coalesces: one request per tick across consumers of one scope', () => {
    (listTerminalSessions as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise(() => undefined)); // never settles
    vi.useFakeTimers();
    const stopA = observeTerminalSessions(DIR, () => undefined);
    const stopB = observeTerminalSessions(DIR, () => undefined); // same scope
    expect(listedCalls()).toBe(1); // the shared scope request
    expect(vi.getTimerCount()).toBe(1); // one interval for the directory scope
    vi.advanceTimersByTime(OBSERVER_CADENCE_MS * 2);
    expect(listedCalls()).toBe(1); // ticks queue behind the in-flight call (refreshAgain)
    stopA();
    stopB();
    expect(vi.getTimerCount()).toBe(0); // the last listener closed the loop
    vi.useRealTimers();
  });

  it('wake events while hidden (or offline) do not fire a wasted request', async () => {
    vi.useFakeTimers();
    const stop = observeTerminalSessions(DIR, () => undefined);
    await drainJobs(); // the mount request settles before the wake checks
    (listTerminalSessions as unknown as ReturnType<typeof vi.fn>).mockClear();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true, writable: false });
    document.dispatchEvent(new Event('visibilitychange')); // hide is a pause, not a refresh
    await drainJobs();
    expect(listedCalls()).toBe(0);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false, writable: false });
    document.dispatchEvent(new Event('visibilitychange')); // reveal wakes immediately
    expect(listedCalls()).toBe(1);
    stop();
    vi.useRealTimers();
  });

  it('the last unsubscribe deletes the scope: a new mount starts a fresh scope and loop', () => {
    vi.useFakeTimers();
    const stop = observeTerminalSessions(DIR, () => undefined);
    stop();
    expect(vi.getTimerCount()).toBe(0); // no interval survives the last listener
    const stopAgain = observeTerminalSessions(DIR, () => undefined);
    expect(listedCalls()).toBeGreaterThan(0); // new scope = immediate refresh
    stopAgain();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

describe('startKeepaliveTouch (doc 07 section 3.6)', () => {
  it('touches only listed non-empty id sets every 10 min', () => {
    vi.useFakeTimers();
    let ids: string[] = ['sess-1'];
    const stop = startKeepaliveTouch(() => ids);
    vi.advanceTimersByTime(KEEPALIVE_TOUCH_MS);
    expect(touchTerminalSessions).toHaveBeenCalledWith(['sess-1']);
    ids = [];
    vi.advanceTimersByTime(KEEPALIVE_TOUCH_MS);
    expect(touchTerminalSessions).toHaveBeenCalledTimes(1); // nothing listed: no wasted touch
    stop();
    vi.advanceTimersByTime(KEEPALIVE_TOUCH_MS);
    expect(touchTerminalSessions).toHaveBeenCalledTimes(1); // loop stopped
    vi.useRealTimers();
  });
});

function listedCalls(): number {
  return (listTerminalSessions as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
}
