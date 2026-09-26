// SPDX-License-Identifier: Apache-2.0
/**
 * Transport pin for the scheduled-task client: these tests ride the REAL
 * runtimeFetch pipeline (nothing mocks `lib/runtime-fetch.ts`), so a 400/409
 * error body must still be readable when the client parses it. No layer of
 * the pipeline consumes a response body before returning it - it observes
 * statuses only (runtime-auth-expiry) - and the coalescing layer never
 * applies to these routes (different allowlist). The one stubbed seam is the
 * underlying native fetch, which runtime-fetch captures at module evaluation:
 * vi.hoisted runs before the static imports evaluate, so `capturedFetch`
 * binds the stub.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const globalScope = globalThis as { fetch?: typeof fetch };
  const previous = globalScope.fetch;
  const native = vi.fn<(input: RequestInfo, init?: RequestInit) => Promise<Response>>();
  globalScope.fetch = native as unknown as typeof fetch;
  return { native, previous };
});

import {
  deleteScheduledTask, listScheduledTasks, runScheduledTask, schedulerStatus,
} from '../scheduled-tasks-api.ts';

const native = hoisted.native;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { native.mockReset(); });

afterAll(() => {
  (globalThis as { fetch?: unknown }).fetch = hoisted.previous;
});

describe('scheduled-task client over the real runtimeFetch pipeline', () => {
  it('keeps the server 409 refusal string verbatim through the real transport', async () => {
    native.mockResolvedValueOnce(json(409, { error: 'task is already running or queued' }));
    const outcome = await runScheduledTask('alpha', 'loop:alpha:daily');
    // A pre-consumed error body would fold into the generic message instead.
    expect(outcome).toEqual({ ok: false, status: 409, error: 'task is already running or queued' });
    expect(native).toHaveBeenCalledWith('/api/projects/alpha/scheduled-tasks/loop%3Aalpha%3Adaily/run',
      expect.objectContaining({ method: 'POST', credentials: 'include' }));
  });

  it('keeps the server 400 pattern refusal verbatim through the real transport', async () => {
    native.mockResolvedValueOnce(json(400, { error: 'unsupported characters in projectId' }));
    const outcome = await listScheduledTasks('a/b');
    expect(outcome).toEqual({ ok: false, status: 400, error: 'unsupported characters in projectId' });
    expect(native).toHaveBeenCalledWith('/api/projects/a%2Fb/scheduled-tasks',
      expect.objectContaining({ credentials: 'include' }));
  });

  it('folds a non-JSON failure body from the real transport into the bounded message', async () => {
    native.mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const outcome = await deleteScheduledTask('alpha', 't1');
    expect(outcome).toEqual({ ok: false, status: 500, error: 'scheduled-task request failed (500)' });
  });

  it('passes a 200 run-now body through the real transport untouched', async () => {
    native.mockResolvedValueOnce(json(200, {
      ok: false, status: 'error', sessionID: 'ses-9', queue: [],
      task: { id: 't1', name: 'daily', enabled: true },
    }));
    const outcome = await runScheduledTask('alpha', 't1');
    expect(outcome).toEqual({
      ok: false, status: 'error', sessionID: 'ses-9', queue: [],
      task: { id: 't1', name: 'daily', enabled: true },
    });
  });

  it('retrieves the status snapshot through the real transport', async () => {
    native.mockResolvedValueOnce(json(200, {
      running: { global: 1, byProject: { alpha: 1 } }, queued: 0, tasks: [],
    }));
    const outcome = await schedulerStatus();
    expect(outcome).toEqual({
      ok: true,
      status: { running: { global: 1, byProject: { alpha: 1 } }, queued: 0, tasks: [] },
    });
  });
});
