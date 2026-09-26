// SPDX-License-Identifier: Apache-2.0
/** Private NNA-child callback; UI sessions and URL tokens grant no access. */
import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';
import { BrowserControlBroker, BrowserControlError } from './browser-control-broker.ts';

function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function registerBrowserControlCallback(app: Hono, broker: BrowserControlBroker, secret: string): void {
  app.post('/api/browser-control/request', async (c) => {
    if (!secretMatches(c.req.header('x-nnd-browser-token'), secret)) return c.json({ error: 'unauthorized' }, 401);
    const body = await readJsonBodyBounded(c.req.raw, 4096);
    if (!body || !['browser.open', 'browser.snapshot', 'browser.inspect'].includes(String(body.action ?? ''))
      || !body.parameters || typeof body.parameters !== 'object' || Array.isArray(body.parameters))
      return c.json({ error: 'invalid browser action' }, 400);
    const parameters = body.parameters as Record<string, unknown>;
    if (body.action === 'browser.open') {
      if (Object.keys(parameters).length !== 1 || typeof parameters.url !== 'string' || parameters.url.length > 2048)
        return c.json({ error: 'invalid browser URL' }, 400);
    } else if (body.action === 'browser.inspect') {
      if (Object.keys(parameters).length !== 1 || typeof parameters.selector !== 'string'
        || !parameters.selector || parameters.selector.length > 500) return c.json({ error: 'invalid CSS selector' }, 400);
    } else if (Object.keys(parameters).length !== 0) return c.json({ error: 'snapshot takes no parameters' }, 400);
    try {
      const result = await broker.request(body.action as 'browser.open' | 'browser.snapshot' | 'browser.inspect', parameters,
        { signal: c.req.raw.signal });
      return c.json(result);
    } catch (error) {
      if (error instanceof BrowserControlError) return c.json({ error: error.message }, error.status === 499 ? 408 : error.status);
      return c.json({ error: 'browser control failed' }, 500);
    }
  });
}
