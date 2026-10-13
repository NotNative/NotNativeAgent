// SPDX-License-Identifier: Apache-2.0
/** F5 step 3: real NNA sessions generate through the native assist seam;
 *  synthetic session ids never ride it. The NNA assist contract accepts one
 *  bounded line with no control characters and clamps max_output_tokens to
 *  [256, 2048], so the desktop must flatten its multi-line drafts and clamp
 *  its token asks before calling the seam. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callHarness } = vi.hoisted(() => ({ callHarness: vi.fn() }));
vi.mock('../queue/queue-adapter-calls.ts', () => ({
  callHarness: (request: Request) => callHarness(request),
  harnessRequest: (path: string, directory: string | null, init?: RequestInit) => ({ path, directory, init }),
  HARNESS_INTERNAL_ORIGIN: 'http://harness.internal',
}));

import { generateSmallModel } from './small-model.ts';

beforeEach(() => { callHarness.mockReset(); });

/** Mirrors the NNA assist request validation (nnd-assist.js) so the desktop
 *  can never claim the seam with a request the contract would reject. */
function nndAssistRequestValid(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 && keys.length !== 2) return false;
  if (typeof record.prompt !== 'string') return false;
  if (record.prompt.length < 1 || record.prompt.length > 8192) return false;
  if (/[\u0000-\u001f\u007f]/u.test(record.prompt)) return false;
  if (keys.length === 2) {
    const tokens = record.max_output_tokens;
    if (!Number.isInteger(tokens) || (tokens as number) < 256 || (tokens as number) > 2048) return false;
  }
  return true;
}

function assistBodies(): Array<Record<string, unknown>> {
  return callHarness.mock.calls
    .map((call) => (call[0]! as { path?: string; init?: { path?: string, body?: string } }))
    .filter((call) => String(call.path).includes('/assist'))
    .map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);
}

describe('native assist generation routing (F5 step 3)', () => {
  it('routes a real ses_ session to the assist seam and returns its bounded result', async () => {
    callHarness.mockResolvedValue(Response.json({ text: 'ok', providerID: 'openai_main', modelID: 'gpt-nano' }));
    const response = await generateSmallModel({ prompt: 'hi', sessionID: 'ses_abc', directory: '/r', maxOutputTokens: 800 }, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'ok', providerID: 'openai_main', modelID: 'gpt-nano', source: 'nna-assist' });
    expect(callHarness).toHaveBeenCalledTimes(1);
    const request = callHarness.mock.calls[0]![0]! as { path: string; init: { body: string, method: string } };
    expect(request.path).toBe('/v1/nnd/sessions/ses_abc/assist');
    expect(request.init.method).toBe('POST');
    expect(JSON.parse(String(request.init.body))).toEqual({ prompt: 'hi', max_output_tokens: 800 });
  });

  it('flattens a multi-line system+prompt draft into the single line the seam accepts', async () => {
    callHarness.mockResolvedValue(Response.json({ text: 'ok', providerID: 'p', modelID: 'm' }));
    const response = await generateSmallModel({
      prompt: 'line one\nline two',
      system: 'Return JSON only.',
      sessionID: 'ses_abc', directory: '/r', maxOutputTokens: 512,
    }, {});
    expect(response.status).toBe(200);
    const [body] = assistBodies();
    expect(body).toEqual({ prompt: 'Return JSON only. line one line two', max_output_tokens: 512 });
    // Invariant: every request the desktop sends to the seam satisfies the
    // NNA assist contract — otherwise the seam was never usable natively.
    expect(nndAssistRequestValid(body)).toBe(true);
  });

  it('clamps the token ask into the seam contract instead of being rejected', async () => {
    callHarness.mockResolvedValue(Response.json({ text: 'ok', providerID: 'p', modelID: 'm' }));
    // 64 tokens (AI rename) previously omitted max_output_tokens (<256);
    // the contract floor keeps the field present and valid.
    await generateSmallModel({ prompt: 'name me', sessionID: 'ses_abc', directory: '/r', maxOutputTokens: 64 }, {});
    expect(assistBodies()[0]).toEqual({ prompt: 'name me', max_output_tokens: 256 });
    // A 5000-token ask exceeds the seam ceiling; clamping keeps the native
    // path instead of bouncing to the legacy wire.
    callHarness.mockClear();
    callHarness.mockResolvedValue(Response.json({ text: 'ok', providerID: 'p', modelID: 'm' }));
    await generateSmallModel({ prompt: 'long', sessionID: 'ses_abc', directory: '/r', maxOutputTokens: 5000 }, {});
    expect(assistBodies()[0]).toEqual({ prompt: 'long', max_output_tokens: 2048 });
    expect(nndAssistRequestValid(assistBodies()[0])).toBe(true);
  });

  it('never claims the seam with a control character the contract rejects', async () => {
    callHarness.mockResolvedValue(Response.json({ text: 'ok', providerID: 'p', modelID: 'm' }));
    // U+0007 is not whitespace, so flattening cannot remove it: the desktop
    // must fall through rather than send a request NNA would 4xx.
    await generateSmallModel({ prompt: 'bad\u0007prompt', sessionID: 'ses_abc', directory: '/r' }, {});
    expect(assistBodies()).toHaveLength(0);
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
