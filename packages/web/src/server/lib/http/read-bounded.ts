// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded body reads for unauthenticated-adjacent surfaces: the reader
 * cancels at the cap instead of buffering arbitrary body bytes before
 * any size decision (the posture the P8-3a review pinned for the relay
 * enable route). The two copy-pasted readers in routes/auth.ts and
 * routes/relay.ts reduce to this shared module. The cap is char-based
 * (chunk-decoded UTF-8), matching the previous auth/relay semantics.
 */
export async function readTextBounded(raw: Request, maxChars: number): Promise<string | null> {
  const stream = raw.body?.getReader();
  if (stream === undefined) return '';
  const decoder = new TextDecoder();
  let total = '';
  let budget = maxChars;
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

/** JSON object body + cap (the 64 KiB pairing/clients budget): malformed,
 * oversize, or non-object bodies come back as null so handlers answer one
 * mappable 400 (§11 §5.6 redeem). */
export async function readJsonBodyBounded(raw: Request, maxChars: number): Promise<Record<string, unknown> | null> {
  const text = await readTextBounded(raw, maxChars);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
