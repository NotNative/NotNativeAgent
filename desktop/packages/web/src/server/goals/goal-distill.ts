// SPDX-License-Identifier: Apache-2.0
/**
 * B.6.3 objective distillation (P9-4f): when an objective exceeds the
 * 5000-char limit at creation, the small-model port distills it into
 * completion criteria; a transient call failure or an ABSENT port (the
 * P-11 small-model module is a doc-02 slice, not yet wired) folds to the
 * registered head+tail excerpt carrying the trim marker — half the
 * budget before, half after. The template and marker register verbatim
 * in the ASCII rendition the goal-prompt family uses (§B.6.1 precedent).
 */
import { DISTILLED_OBJECTIVE_CHAR_LIMIT, GOAL_OBJECTIVE_CHAR_LIMIT } from './goal-constants.ts';

export const DISTILL_SYSTEM_PROMPT = [
  'You distill a large task description into the COMPLETION CRITERIA a progress auditor will judge against.',
  'Return ONLY the criteria text - no preamble, no headers, no markdown fences.',
  'Capture: the end goals, what must exist and work when the task is fully done, and how each major part is verified. Omit implementation steps.',
  'Preserve verbatim any file paths, commands, and identifiers that define the task.',
  'Stay under 4000 characters.',
  'Write in the same language as the task text.',
].join('\n');

/** The fallback marker, verbatim; the caller may adopt the UI wording
 * variant but never drop the bracketed untrusted-data convention. */
export const TRIM_MARKER =
  '\n\n[. objective trimmed for the auditor - the full prompt was delivered in the chat message .]\n\n';

/** The small-model seam (P-11 §7.4 direct provider call). Refusal answers
 * null; throws are transient failures. `preference` restricts the call to
 * the session's own provider/model (B.6.3 restrictToPreferredProvider). */
export type DistillPort = (
  raw: string,
  preference?: { providerID: string; modelID: string } | null,
) => Promise<string | null>;

export interface FittedObjective {
  text: string;
  distilled: boolean;
  fallback: boolean;
}

/** Head+tail excerpt: half the spends BEFORE the marker, half after. */
export function headTailExcerpt(
  raw: string,
  budget: number = DISTILLED_OBJECTIVE_CHAR_LIMIT,
  marker: string = TRIM_MARKER,
): string {
  const body = Math.max(0, budget - marker.length);
  const head = raw.slice(0, Math.floor(body / 2));
  const tailSpan = Math.min(Math.max(0, raw.length - head.length), body - head.length);
  const tail = tailSpan > 0 ? raw.slice(raw.length - tailSpan) : '';
  return head + marker + tail;
}

/** The B.6.3 fit: under the limit passes through untouched; over the
 * limit prefers a successful distill (clamped to the distilled budget)
 * and otherwise registers the excerpt fallback (`fallback: true`). */
export async function fitObjective(
  raw: string,
  opts: { generate?: DistillPort; preference?: { providerID: string; modelID: string } | null } = {},
): Promise<FittedObjective> {
  if (raw.length <= GOAL_OBJECTIVE_CHAR_LIMIT) {
    return { text: raw, distilled: false, fallback: false };
  }
  const generate = opts.generate;
  if (generate) {
    try {
      const distilled = await generate(raw, opts.preference ?? null);
      const criteria = typeof distilled === 'string' ? distilled.trim() : '';
      if (criteria !== '') {
        return { text: criteria.slice(0, DISTILLED_OBJECTIVE_CHAR_LIMIT), distilled: true, fallback: false };
      }
    } catch {
      // transient distillation failure: the excerpt is the registered
      // fallback, never a throw into the goal-planting flow
    }
  }
  return { text: headTailExcerpt(raw), distilled: false, fallback: true };
}
