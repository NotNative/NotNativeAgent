// SPDX-License-Identifier: Apache-2.0
import { Hono } from 'hono';
import { ENV } from '../env.ts';
import { peekRelayServerId } from '../lib/relay/identity.ts';

export const SERVER_API_COMPATIBILITY = Object.freeze({
  apiVersion: 1,
  minClientApiVersion: 1,
  capabilities: Object.freeze(['api.runtime-url.v1']),
});

/** Public, non-sensitive identity and API compatibility surface for clients. */
export function createVersionRoutes(): Hono {
  const app = new Hono();
  const startedAt = new Date().toISOString();
  app.get('/api/version', async (c) => c.json({
    status: 'ok',
    openchamberVersion: ENV.version,
    runtime: process.env?.NOTNATIVE_RUNTIME ?? 'web',
    startedAt,
    compatibility: SERVER_API_COMPATIBILITY,
    serverId: await peekRelayServerId(),
  }, 200, { 'cache-control': 'no-store' }));
  return app;
}
