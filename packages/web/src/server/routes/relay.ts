// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host management routes (doc 08 §3.15, full rows in doc 03 §5.35):
 * all behind the global UI auth gate (registered inside the /api scope).
 * status 500s at internal trouble; enable normalizes the URL (ws/wss,
 * default otherwise), persists enabled:true and restarts the host with a
 * force-claim; disable persists enabled:false and stops host + watcher.
 */
import { Hono } from 'hono';
import { getRelayHostService } from '../lib/relay/host-service.ts';
import { resetRelayHostServiceForTests } from '../lib/relay/host-service.ts';
import { RELAY_ENABLE_BODY_MAX_BYTES } from '../lib/relay/relay-config.ts';

export function resetRelayRoutesForTests(): void {
  resetRelayHostServiceForTests();
}

const INTERNAL_FAILURE = 'relay status unavailable';

export function registerRelayRoutes(app: Hono): void {
  app.get('/api/openchamber/relay/status', async (c) => {
    try {
      return c.json(await getRelayHostService().getStatus());
    } catch {
      return c.json({ error: INTERNAL_FAILURE }, 500);
    }
  });

  app.post('/api/openchamber/relay/enable', async (c) => {
    const body = await readEnableBody(c.req.raw);
    if (body === null) return c.json({ error: 'enable body must be JSON under 16 KiB' }, 400);
    try {
      return c.json(await getRelayHostService().enable(body.relayUrl));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  app.post('/api/openchamber/relay/disable', async (c) => {
    try {
      return c.json(await getRelayHostService().disable());
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
}

async function readEnableBody(request: Request): Promise<{ relayUrl?: string } | null> {
  try {
    const text = await readTextBounded(request, RELAY_ENABLE_BODY_MAX_BYTES);
    if (text === null) return null; // oversize: cancelled mid-stream, never fully buffered
    if (text.trim().length === 0) return {};
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const doc = parsed as Record<string, unknown>;
    if (doc.relayUrl !== undefined && typeof doc.relayUrl !== 'string') return null;
    return { relayUrl: doc.relayUrl as string | undefined };
  } catch {
    return null;
  }
}

/** 16 KiB bounded read (§3.15 enable-body budget): the reader cancels at
 * the cap instead of buffering an unbounded body before the size check. */
async function readTextBounded(raw: Request, max: number): Promise<string | null> {
  const stream = raw.body?.getReader();
  if (stream === undefined) return '';
  const decoder = new TextDecoder();
  let total = '';
  let budget = max;
  while (budget >= 0) {
    const next = await stream.read();
    if (next.done) return total + decoder.decode();
    const chunk = decoder.decode(next.value, { stream: true });
    total += chunk;
    budget -= chunk.length;
    if (budget < 0) {
      await stream.cancel().catch(() => undefined);
      return null;
    }
  }
  return null;
}
