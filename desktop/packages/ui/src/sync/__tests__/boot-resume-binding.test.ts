// SPDX-License-Identifier: Apache-2.0
/**
 * W-30 end-to-end binding: cold-start continuity (persisted last-active
 * session) → directory bootstrap enrichment (phase-2, signature-guarded
 * blocking merge) → system-resume recovery (both desktop and web aliases
 * interrupt the event pipe for an immediate reconnect round).
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { persistLastActiveSession, readLastActiveSession } from '../persist-cache.ts';
import { runPhase2 } from '../bootstrap-enrichment.ts';
import { createEventPipeline } from '../event-pipeline.ts';
import { createDirectoryStore } from '../child-store.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import type { PermissionRequest } from '../../lib/nnd/types.ts';

initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });

vi.mock('../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: vi.fn(async () => new Response('{}', { status: 200 })),
}));

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('boot/resume binding (W-30)', () => {
  it('cold-start continuity: the last active session pointer survives a restart and draft intent clears it', () => {
    persistLastActiveSession('ses_r1', 'D:/work');
    expect(readLastActiveSession()).toEqual({ sessionId: 'ses_r1', directory: 'D:/work' });
    persistLastActiveSession(null, 'D:/work'); // draft intent clears the pointer
    expect(readLastActiveSession()).toBeNull();
  });

  it('enrichment lands commands/mcp/lsp and the signature guard never resurrects settled requests', async () => {
    const store = createDirectoryStore();
    const permission: PermissionRequest = { id: 'pr1', sessionID: 's1' } as PermissionRequest;
    store.getState().patch({ permission: { s1: [permission] } });
    const client = vi.mocked(harnessClient, true);
    client.listCommands = vi.fn(async () => ({ data: [{ name: 'review' }] as never, error: null })) as never;
    client.getMcp = vi.fn(async () => ({ data: { servers: [] }, error: null })) as never;
    client.getLsp = vi.fn(async () => ({ data: [] as never, error: null })) as never;
    client.listPermissions = vi.fn(async () => ({ data: [] as never, error: null })) as never; // pr1 settled elsewhere
    client.listQuestions = vi.fn(async () => ({ data: [] as never, error: null })) as never;
    await runPhase2('D:/work', store, () => true);
    const state = store.getState();
    expect(state.command).toEqual([{ name: 'review' }]);
    expect(store.getState().permission['s1']).toBeFalsy(); // stable signature proves the omission is a real deletion
  });

  it('live mid-flight arrivals are preserved over the stale snapshot (no resurrection guard bypass)', async () => {
    const store = createDirectoryStore();
    const live: PermissionRequest = { id: 'pr_live', sessionID: 's1' } as PermissionRequest;
    const client = vi.mocked(harnessClient, true);
    client.listCommands = vi.fn(async () => ({ data: [], error: null })) as never;
    client.getMcp = vi.fn(async () => ({ data: null, error: null })) as never;
    client.getLsp = vi.fn(async () => ({ data: null, error: null })) as never;
    let deliverList!: () => void;
    client.listPermissions = vi.fn(async () => {
      store.getState().patch({ permission: { s1: [live] } }); // SSE arrival mid-flight
      return { data: [] as never, error: null }; // snapshot already omits it
    }) as never;
    client.listQuestions = vi.fn(async () => ({ data: [] as never, error: null })) as never;
    await runPhase2('D:/work', store, () => true);
    deliverList = () => undefined; void deliverList;
    expect(store.getState().permission['s1']?.map((item) => item.id)).toEqual(['pr_live']);
  });

  it('system resume from BOTH runtimes interrupts the pipe for an immediate reconnect round', async () => {
    const signals: AbortSignal[] = [];
    vi.mocked((await import('../../lib/runtime-fetch.ts')).runtimeFetch).mockImplementation(async (_input, init) => {
      const signal = init?.signal ?? new AbortController().signal;
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const reasons: string[] = [];
    const pipeline = createEventPipeline({
      transport: 'sse',
      onEvents: () => undefined,
      onConnected: () => undefined,
      onDisconnected: (reason) => reasons.push(reason),
      onTransportSwitch: () => undefined,
      isRecentBoot: () => false,
    });
    await new Promise((done) => setTimeout(done, 300));
    if (signals.length === 0) throw new Error(`no attempts; reasons=${reasons.join(' | ')}`);
    window.dispatchEvent(new Event('notnative:system-resume')); // desktop powerMonitor path
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    signals.length = 0;
    await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0)); // retry loop opens a new attempt
    window.dispatchEvent(new Event('openchamber:system-resume')); // web/PWA alias path
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
    pipeline.cleanup();
  });
});
