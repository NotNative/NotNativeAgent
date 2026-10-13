// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserControlBroker, BrowserControlError, type BrowserRequest } from '../preview/browser-control-broker.ts';

afterEach(() => vi.useRealTimers());

describe('in-process browser control broker', () => {
  it('requires a capable desktop client for inspection, but allows a panel opener', async () => {
    const broker = new BrowserControlBroker();
    const requests: BrowserRequest[] = [];
    broker.registerClient('opener', false, (request) => requests.push(request));
    await expect(broker.request('browser.snapshot', {})).rejects.toMatchObject({ status: 503 });
    expect(requests).toHaveLength(0);
    const opened = broker.request('browser.open', { url: 'https://example.org/' });
    expect(requests).toHaveLength(1);
    expect(broker.claim(requests[0]!.requestId, 'opener')).toBe(true);
    expect(broker.resolve(requests[0]!.requestId, 'opener', { ok: true, data: { opened: true } })).toBe(true);
    await expect(opened).resolves.toEqual({ ok: true, data: { opened: true } });
    broker.dispose();
  });

  it('grants one claimant and rejects a loser or late result', async () => {
    const broker = new BrowserControlBroker();
    const requests: BrowserRequest[] = [];
    broker.registerClient('a', true, (request) => requests.push(request));
    broker.registerClient('b', true, () => undefined);
    const pending = broker.request('browser.snapshot', {});
    const id = requests[0]!.requestId;
    expect(broker.claim(id, 'a')).toBe(true);
    expect(broker.claim(id, 'b')).toBe(false);
    expect(broker.resolve(id, 'b', { ok: true, data: 'wrong owner' })).toBe(false);
    expect(broker.resolve(id, 'a', { ok: true, data: 'snapshot' })).toBe(true);
    expect(broker.resolve(id, 'a', { ok: true, data: 'late' })).toBe(false);
    await expect(pending).resolves.toEqual({ ok: true, data: 'snapshot' });
    broker.dispose();
  });

  it('settles aborts, timeouts, and disconnects without leaving claims alive', async () => {
    vi.useFakeTimers();
    const broker = new BrowserControlBroker();
    const requests: BrowserRequest[] = [];
    const close = broker.registerClient('desktop', true, (request) => requests.push(request));
    const signal = new AbortController();
    const aborted = broker.request('browser.inspect', {}, { signal: signal.signal });
    signal.abort();
    await expect(aborted).rejects.toMatchObject({ status: 499 });
    expect(broker.claim(requests[0]!.requestId, 'desktop')).toBe(false);
    const timed = broker.request('browser.snapshot', {}, { timeoutMs: 1000 });
    const timedRejection = expect(timed).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(1000);
    await timedRejection;
    const disconnected = broker.request('browser.click', { selector: '#save' });
    expect(broker.claim(requests[2]!.requestId, 'desktop')).toBe(true);
    close();
    await expect(disconnected).rejects.toMatchObject({ status: 503 });
    expect(broker.resolve(requests[2]!.requestId, 'desktop', { ok: true, data: {} })).toBe(false);
    broker.dispose();
  });

  it('does not let a failed sender or a duplicate client identity leave an owned request', async () => {
    const broker = new BrowserControlBroker();
    broker.registerClient('bad', true, () => { throw new Error('broken transport'); });
    await expect(broker.request('browser.snapshot', {})).rejects.toMatchObject({ status: 503 });
    const requests: BrowserRequest[] = [];
    const close = broker.registerClient('desktop', true, (request) => requests.push(request));
    expect(() => broker.registerClient('desktop', true, () => undefined)).toThrow('already registered');
    const pending = broker.request('browser.snapshot', {});
    expect(broker.claim(requests[0]!.requestId, 'desktop')).toBe(true);
    close();
    await expect(pending).rejects.toBeInstanceOf(BrowserControlError);
    broker.dispose();
  });

  it('rejects an undelivered late client claim and fails promptly when the only recipient disconnects', async () => {
    vi.useFakeTimers();
    const broker = new BrowserControlBroker();
    const requests: BrowserRequest[] = [];
    const close = broker.registerClient('first', true, (request) => requests.push(request));
    const pending = broker.request('browser.snapshot', {}, { timeoutMs: 120_000 });
    broker.registerClient('late', true, () => undefined);
    const id = requests[0]!.requestId;
    expect(broker.claim(id, 'late')).toBe(false);
    close();
    await expect(pending).rejects.toMatchObject({ status: 503,
      message: expect.stringContaining('before accepting') });
    expect(vi.getTimerCount()).toBe(0);
    broker.dispose();
  });

  it('does not dispatch an already claimed request to another desktop', async () => {
    const broker = new BrowserControlBroker();
    const second: BrowserRequest[] = [];
    broker.registerClient('first', true, (request) => {
      expect(broker.claim(request.requestId, 'first')).toBe(true);
    });
    broker.registerClient('second', true, (request) => second.push(request));
    const pending = broker.request('browser.click', { selector: '#save' });
    expect(second).toHaveLength(0);
    broker.dispose();
    await expect(pending).rejects.toMatchObject({ status: 503 });
  });

  it('keeps an unclaimed request available to a second actual recipient after one disconnects', async () => {
    const broker = new BrowserControlBroker();
    const requests: BrowserRequest[] = [];
    const closeFirst = broker.registerClient('first', true, (request) => requests.push(request));
    broker.registerClient('second', true, (request) => requests.push(request));
    const pending = broker.request('browser.snapshot', {});
    expect(requests).toHaveLength(2);
    closeFirst();
    expect(broker.claim(requests[1]!.requestId, 'second')).toBe(true);
    expect(broker.resolve(requests[1]!.requestId, 'second', { ok: true, data: 'second result' })).toBe(true);
    await expect(pending).resolves.toEqual({ ok: true, data: 'second result' });
    broker.dispose();
  });

  it('reports an indeterminate result when an owner disconnects or an owned request aborts', async () => {
    const broker = new BrowserControlBroker();
    const requests: BrowserRequest[] = [];
    const close = broker.registerClient('desktop', true, (request) => requests.push(request));
    const pending = broker.request('browser.click', { selector: '#save' });
    expect(broker.claim(requests[0]!.requestId, 'desktop')).toBe(true);
    close();
    await expect(pending).rejects.toMatchObject({ status: 503,
      message: expect.stringContaining('may have changed') });
    const signal = new AbortController();
    broker.registerClient('replacement', true, (request) => requests.push(request));
    const aborting = broker.request('browser.type', { text: 'hello' }, { signal: signal.signal });
    expect(broker.claim(requests[1]!.requestId, 'replacement')).toBe(true);
    signal.abort();
    await expect(aborting).rejects.toMatchObject({ status: 499,
      message: expect.stringContaining('may still complete') });
    broker.dispose();
  });
});
