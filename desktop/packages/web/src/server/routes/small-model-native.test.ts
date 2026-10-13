// SPDX-License-Identifier: Apache-2.0
/** F5 step 3: real NNA sessions generate through the native assist seam;
 *  synthetic session ids never ride it. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callHarness } = vi.hoisted(() => ({ callHarness: vi.fn() }));
vi.mock('../queue/queue-adapter-calls.ts', () => ({
  callHarness: (request: Request) => callHarness(request),
  harnessRequest: (path: string, directory: string | null, init?: RequestInit) => ({ path, directory, init }),
  HARNESS_INTERNAL_ORIGIN: 'http://harness.internal',
}));

import { generateSmallModel } from './small-model.ts';

beforeEach(() => { callHarness.mockReset(); });

describe('native assist generation routing (F5 step 3)', () => {
  it('routes a real ses_ session to the assist seam and returns its bounded result', async () => {
    callHarness.mockResolvedValue(Response.json({ text: 'ok', providerID: 'openai_main', modelID: 'gpt-nano' }));
    const response = await generateSmallModel({ prompt: 'hi', sessionID: 'ses_abc', directory: '/r', maxOutputTokens: 800 }, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'ok', providerID: 'openai_main', modelID: 'gpt-nano', source: 'nna-assist' });
    expect(callHarness).toHaveBeenCalledTimes(1);
    const request = callHarness.mock.calls[0]![0]! as { path: string; init: { body: string; method: string } };
    expect(request.path).toBe('/v1/nnd/sessions/ses_abc/assist');
    expect(request.init.method).toBe('POST');
    expect(JSON.parse(String(request.init.body))).toEqual({ prompt: '\n\nhi', max_output_tokens: 800 });
  });

  it('falls back to the legacy path for synthetic ids, oversized prompts, and harness failures', async () => {
    const assistCalls = () => callHarness.mock.calls
      .filter((call) => String((call[0]! as { path?: string }).path).includes('/assist'));
    // Synthetic walkthrough-style session id: no assist call at all.
    await generateSmallModel({ prompt: 'hi', sessionID: 'nnd-walkthrough-abc', directory: '/r' }, {});
    expect(assistCalls()).toHaveLength(0);
    // Oversized combined prompt skips the seam instead of failing natively.
    await generateSmallModel({ prompt: 'x'.repeat(9_000), sessionID: 'ses_abc', directory: '/r' }, {});
    expect(assistCalls()).toHaveLength(0);
    // A harness refusal falls through rather than failing the generation.
    callHarness.mockResolvedValue(new Response('busy', { status: 409 }));
    await generateSmallModel({ prompt: 'hi', sessionID: 'ses_abc', directory: '/r' }, {});
    expect(assistCalls()).toHaveLength(1);
  });
});
