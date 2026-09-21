// SPDX-License-Identifier: Apache-2.0
/**
 * P9-1 app wiring gate (doc 12 §D.3/§D.5): the message-queue routes
 * register inside registerApiSurfaces — BEHIND the global /api gate and
 * BEFORE the generic harness proxy catch-all. Runs in its own file so the
 * NOTNATIVE_DATA_DIR env snapshot binds through the boot shim before any
 * queue module import (env-boot.ts is FIRST: import order binds the data
 * dir before env.ts initializes).
 */
import { BOOT_DATA_DIR } from './helpers/env-boot.ts'; // import order matters: see file head
import { existsSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeQueueHarness, installFakeHarness, rawItem, WORK_TREE, waitUntil } from './helpers/queue-fakes.ts';
import { QUEUE_FILE_NAME } from '../queue/queue-store.ts';

const dataDir = BOOT_DATA_DIR;
const origin = 'http://app.test';
const jsonHeaders = { 'content-type': 'application/json' };

let harness: FakeQueueHarness | null = null;

afterAll(() => {
  import('../queue/queue-runtime.ts')
    .then(({ getMessageQueueRuntime }) => getMessageQueueRuntime().dispose()) // stop the singleton pump
    .catch(() => undefined);
  harness?.releaseHeldSends();
});

describe('app registration (§D.3 wiring)', () => {
  it('rides the global /api gate ahead of the proxy; the store file lands in the data dir', async () => {
    harness = new FakeQueueHarness();
    installFakeHarness(harness);
    harness.enqueueOutcome({ kind: 'hold' }); // keep the head in flight so the store check is deterministic
    const { createApp } = await import('../app.ts');
    const app = createApp();
    const response = await app.fetch(new Request(`${origin}/api/message-queue/sessions/app-s/items`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ directory: WORK_TREE, item: rawItem({ content: 'through the gate' }) }),
    }));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { itemId: string }).itemId).toMatch(/^queued-/u);
    // registration-order pin: the proxy passthrough never saw this family
    expect(harness.servedPaths.some((path) => path.includes('/message-queue'))).toBe(false);
    // the default singleton persisted through its own data-dir file
    await waitUntil(() => existsSync(joinPath(dataDir, QUEUE_FILE_NAME)), 1600);
    const persisted = JSON.parse(readFileSync(joinPath(dataDir, QUEUE_FILE_NAME), 'utf8')) as { sessions: Record<string, unknown> };
    expect(persisted.sessions['app-s']).toBeDefined();
  });
});
