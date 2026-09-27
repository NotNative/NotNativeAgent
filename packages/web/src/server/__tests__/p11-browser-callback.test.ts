import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { BrowserControlBroker } from '../preview/browser-control-broker.ts';
import { registerBrowserControlCallback } from '../preview/browser-control-callback.ts';

const secret = 's'.repeat(43);
function fixture() {
  const app = new Hono();
  const broker = new BrowserControlBroker();
  registerBrowserControlCallback(app, broker, secret);
  const post = (body: unknown, token?: string) => app.request('http://127.0.0.1/api/browser-control/request', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-nnd-browser-token': token } : {}) },
    body: JSON.stringify(body),
  });
  return { broker, post };
}

describe('private NNA browser callback', () => {
  it('rejects UI-only access and malformed actions before broker dispatch', async () => {
    const { broker, post } = fixture();
    expect((await post({ action: 'browser.snapshot', parameters: {} })).status).toBe(401);
    expect((await post({ action: 'browser.click', parameters: {} }, secret)).status).toBe(400);
    expect((await post({ action: 'browser.snapshot', parameters: { url: 'x' } }, secret)).status).toBe(400);
    expect((await post({ action: 'browser.inspect', parameters: {} }, secret)).status).toBe(400);
    expect((await post({ action: 'browser.inspect', parameters: { selector: '#x', extra: true } }, secret)).status).toBe(400);
    expect((await post({ action: 'browser.click', parameters: { selector: '#x' } }, secret)).status).toBe(400);
    expect((await post({ action: 'browser.scroll', parameters: { direction: 'down' } }, secret)).status).toBe(400);
    expect((await post({ action: 'browser.open', parameters: { url: 'x', extra: true } }, secret)).status).toBe(400);
    broker.dispose();
  });

  it('dispatches a token-authenticated snapshot to a claimed desktop', async () => {
    const { broker, post } = fixture();
    broker.registerClient('desktop', true, (request) => {
      expect(request.action).toBe('browser.snapshot');
      expect(broker.claim(request.requestId, 'desktop')).toBe(true);
      expect(broker.resolve(request.requestId, 'desktop', { ok: true, data: { title: 'Test' } })).toBe(true);
    });
    const response = await post({ action: 'browser.snapshot', parameters: {} }, secret);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { title: 'Test' } });
    broker.dispose();
  });

  it('fails closed when no desktop is connected', async () => {
    const { broker, post } = fixture();
    const response = await post({ action: 'browser.snapshot', parameters: {} }, secret);
    expect(response.status).toBe(503);
    broker.dispose();
  });

  it('dispatches a bounded inspect selector to a capable desktop', async () => {
    const { broker, post } = fixture();
    broker.registerClient('desktop', true, (request) => {
      expect(request.action).toBe('browser.inspect');
      expect(request.parameters).toEqual({ selector: '#send' });
      expect(broker.claim(request.requestId, 'desktop')).toBe(true);
      broker.resolve(request.requestId, 'desktop', { ok: true, data: { tag: 'button' } });
    });
    const response = await post({ action: 'browser.inspect', parameters: { selector: '#send' } }, secret);
    expect(await response.json()).toEqual({ ok: true, data: { tag: 'button' } });
    broker.dispose();
  });

  it('dispatches an exact-page click target to a capable desktop', async () => {
    const { broker, post } = fixture();
    broker.registerClient('desktop', true, (request) => {
      expect(request.action).toBe('browser.click');
      expect(request.parameters).toEqual({ selector: '#send', expectedUrl: 'https://example.org/' });
      expect(broker.claim(request.requestId, 'desktop')).toBe(true);
      broker.resolve(request.requestId, 'desktop', { ok: true, data: { activated: true, settled: false } });
    });
    const response = await post({ action: 'browser.click', parameters: {
      selector: '#send', expectedUrl: 'https://example.org/',
    } }, secret);
    expect(response.status).toBe(200);
    broker.dispose();
  });

  it('dispatches an exact-page scroll direction to a capable desktop', async () => {
    const { broker, post } = fixture();
    broker.registerClient('desktop', true, (request) => {
      expect(request.action).toBe('browser.scroll');
      expect(request.parameters).toEqual({ direction: 'down', expectedUrl: 'https://example.org/' });
      expect(broker.claim(request.requestId, 'desktop')).toBe(true);
      broker.resolve(request.requestId, 'desktop', { ok: true, data: { scrollY: 400 } });
    });
    const response = await post({ action: 'browser.scroll', parameters: {
      direction: 'down', expectedUrl: 'https://example.org/',
    } }, secret);
    expect(response.status).toBe(200);
    broker.dispose();
  });
});
