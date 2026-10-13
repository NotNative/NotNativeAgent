// SPDX-License-Identifier: Apache-2.0
/** Auth-gated, bounded readiness probe for a user-selected loopback preview. */
import type { Hono } from 'hono';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseLoopbackProbeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname.toLowerCase())
      || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

type ProbeFetch = (url: string, init: RequestInit) => Promise<Response>;

export function registerProbeUrlRoutes(app: Hono, fetcher: ProbeFetch = fetch): void {
  app.post('/api/system/probe-url', async (c) => {
    const body = await readJsonBodyBounded(c.req.raw, 4096);
    const url = parseLoopbackProbeUrl(body?.url);
    if (!url) return c.json({ ok: false, error: 'Invalid loopback URL' }, 400);
    try {
      const response = await fetcher(url, { method: 'GET', redirect: 'manual',
        signal: AbortSignal.timeout(1500), credentials: 'omit' });
      await response.body?.cancel().catch(() => undefined);
      return c.json({ ok: response.status >= 200 && response.status < 600, status: response.status });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message.slice(0, 200) : 'probe failed' });
    }
  });
}
