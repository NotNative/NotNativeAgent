// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { configureNativeHarness } from '../nna-supervised.ts';
import { createNnaHarnessAdapter } from '../nna.ts';

describe('supervised native harness', () => {
  it('cannot select a remote endpoint or restart a stopped generation', () => {
    expect(() => configureNativeHarness({ endpoint: 'http://example.com', token: 'a'.repeat(32) })).toThrow();
    const controller = new AbortController(); controller.abort();
    expect(() => configureNativeHarness({ endpoint: 'http://127.0.0.1', token: 'a'.repeat(32), signal: controller.signal })).toThrow();
  });
  it('uses only fixed compatibility envelope and generation lifecycle', () => {
    const controller = new AbortController();
    const local = configureNativeHarness({ endpoint: 'http://127.0.0.1:4555', token: 'a'.repeat(32), signal: controller.signal });
    expect(local.principal()).toBe('bm5k'); expect(local.isRunning()).toBe(true);
    controller.abort(); expect(local.isRunning()).toBe(false);
  });
  it('generation cancellation aborts upstream transport after response headers', async () => {
    const controller = new AbortController(); let signal: AbortSignal | undefined;
    const requestFetch = vi.fn<typeof fetch>(async (_url, options) => {
      signal = options?.signal as AbortSignal; return new Response('ok');
    });
    const adapter = createNnaHarnessAdapter({ endpoint: 'http://127.0.0.1:4555', token: 'a'.repeat(32),
      principal: 'bm5k', signal: controller.signal, fetch: requestFetch });
    await adapter.handle(new Request('http://127.0.0.1/api/sessions'));
    expect(signal?.aborted).toBe(false); controller.abort(); expect(signal?.aborted).toBe(true);
  });
});
