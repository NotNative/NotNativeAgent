// SPDX-License-Identifier: Apache-2.0
/** Native NND assist-seam generation (F5 step 3).
 *
 *  Real `ses_*` sessions generate through NNA's bounded model-only seam
 *  (`POST /v1/nnd/sessions/:id/assist`); synthetic call-site ids never ride
 *  it. The seam's request contract is NNA's, not the desktop's:
 *  Why: nnd-assist.js rejects any control character (including newlines) and
 *  bounds max_output_tokens to [256, 2048], so the desktop must normalize its
 *  multi-line draft and clamp its token ask before the seam sees the request;
 *  otherwise the native path is rejected for every real caller and silently
 *  falls back to the legacy provider wire. */

import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';

const ASSIST_PROMPT_MAX_CHARS = 8192;
const ASSIST_OUTPUT_TOKEN_MAX = 2048;
const ASSIST_OUTPUT_TOKEN_MIN = 256;
// NNA's assist contract (nnd-assist.js) accepts ONE bounded visible line: the
// prompt may not contain control characters, and newlines are control
// characters. System and prompt therefore arrive as a newline-joined draft
// that must be flattened before the seam sees it.
// Invariant: the desktop never claims the assist seam for a request the NNA
// contract would reject; rejection falls through to the legacy path below.
// Why: \p{Cc} (C0 + C1 controls + DEL) is a conservative superset of the
// seam's exact C0 + DEL range — it may fall through in rarer cases but can
// never send a character the seam rejects.
const ASSIST_CONTROL_CHARS = /[\p{Cc}]/u;

/** NNA mints `ses_*` ids; synthetic call-site ids (e.g. walkthrough cache
 *  keys) are not native sessions and must not ride the assist seam. */
export function isRealSessionId(sessionID: string): boolean {
  return /^ses_[A-Za-z0-9_-]{1,64}$/u.test(sessionID);
}

export async function nativeAssistGeneration(input: {
  directory: string; sessionID: string;
  system: string; prompt: string; maxOutputTokens: number;
}, signal?: AbortSignal): Promise<Response | null> {
  const prompt = flattenAssistPrompt(`${input.system}\n\n${input.prompt}`);
  if (prompt === null || prompt.length > ASSIST_PROMPT_MAX_CHARS) return null;
  // Compatibility: the native seam's output floor is 256 tokens and its
  // ceiling is 2048; smaller or larger caller asks are clamped into that
  // range rather than bounced out of the native path. Callers still parse
  // and bound the returned text, so a larger-than-requested cap cannot leak
  // unbounded output.
  const outputTokens = Math.min(ASSIST_OUTPUT_TOKEN_MAX,
    Math.max(ASSIST_OUTPUT_TOKEN_MIN, input.maxOutputTokens));
  try {
    const response = await callHarness(harnessRequest(
      `/v1/nnd/sessions/${encodeURIComponent(input.sessionID)}/assist`, input.directory, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, max_output_tokens: outputTokens }),
        ...(signal ? { signal } : {}),
      }));
    if (!response.ok) return null;
    const value = await response.json().catch(() => null) as { text?: unknown; providerID?: unknown; modelID?: unknown } | null;
    if (value === null || typeof value.text !== 'string' || typeof value.providerID !== 'string'
      || typeof value.modelID !== 'string') return null;
    return Response.json({ text: value.text, providerID: value.providerID, modelID: value.modelID, source: 'nna-assist' });
  } catch { return null; }
}

/** Whitespace normalization: the assist contract forbids control characters,
 *  so multi-line transcripts collapse to one line instead of failing natively. */
function flattenAssistPrompt(combined: string): string | null {
  const flattened = combined.replace(/\s+/gu, ' ').trim();
  if (flattened === '' || ASSIST_CONTROL_CHARS.test(flattened)) return null;
  return flattened;
}
