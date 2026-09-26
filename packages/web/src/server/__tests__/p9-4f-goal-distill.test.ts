// SPDX-License-Identifier: Apache-2.0
/** P9-4f B.6.3 objective distillation pins: the byte-exact template +
 * marker registers, the 5000-char gate (<= passes through, no port call),
 * the distilled clamp, the excerpt split (half before, half after), and
 * every port outcome (success, null, throw, absent) landing either the
 * distilled text or the registered excerpt fallback. */
import { describe, expect, it, vi } from 'vitest';
import {
  DISTILL_SYSTEM_PROMPT, TRIM_MARKER, fitObjective, headTailExcerpt, type DistillPort,
} from '../goals/goal-distill.ts';
import { DISTILLED_OBJECTIVE_CHAR_LIMIT, GOAL_OBJECTIVE_CHAR_LIMIT } from '../goals/goal-constants.ts';

describe('B.6.3 objective distillation', () => {
  it('registers the template and marker byte-exact (ASCII rendition)', () => {
    expect(DISTILL_SYSTEM_PROMPT).toBe([
      'You distill a large task description into the COMPLETION CRITERIA a progress auditor will judge against.',
      'Return ONLY the criteria text - no preamble, no headers, no markdown fences.',
      'Capture: the end goals, what must exist and work when the task is fully done, and how each major part is verified. Omit implementation steps.',
      'Preserve verbatim any file paths, commands, and identifiers that define the task.',
      'Stay under 4000 characters.',
      'Write in the same language as the task text.',
    ].join('\n'));
    expect(TRIM_MARKER).toBe('\n\n[. objective trimmed for the auditor - the full prompt was delivered in the chat message .]\n\n');
  });

  it('an objective at or under the limit passes through untouched, port never called', async () => {
    const raw = 'x'.repeat(GOAL_OBJECTIVE_CHAR_LIMIT);
    const generate: DistillPort = vi.fn(async () => 'never');
    await expect(fitObjective(raw, { generate })).resolves.toEqual({ text: raw, distilled: false, fallback: false });
    expect(generate).not.toHaveBeenCalled();
    const short = await fitObjective('plain objective', { generate });
    expect(short).toEqual({ text: 'plain objective', distilled: false, fallback: false });
  });

  it('a successful distill wins over the limit and clamps to the distilled budget', async () => {
    const raw = 'y'.repeat(GOAL_OBJECTIVE_CHAR_LIMIT + 7);
    const seen: Array<[string, { providerID: string; modelID: string } | null]> = [];
    const fits = await fitObjective(raw, {
      generate: async (text, preference) => { seen.push([text, preference ?? null]); return 'z'.repeat(DISTILLED_OBJECTIVE_CHAR_LIMIT + 50); },
      preference: { providerID: 'acme', modelID: 'fast' },
    });
    expect(fits.distilled).toBe(true);
    expect(fits.fallback).toBe(false);
    expect(fits.text).toHaveLength(DISTILLED_OBJECTIVE_CHAR_LIMIT);
    expect(seen).toEqual([[raw, { providerID: 'acme', modelID: 'fast' }]]);
  });

  it('an empty distill answer counts as a refusal, not a success', async () => {
    const fits = await fitObjective('y'.repeat(5001), { generate: async () => '' });
    expect(fits.distilled).toBe(false);
    expect(fits.fallback).toBe(true);
    const whitespace = await fitObjective('y'.repeat(5001), { generate: async () => '\n \t ' });
    expect(whitespace.distilled).toBe(false);
    expect(whitespace.fallback).toBe(true);
  });

  it('a throwing port folds to the excerpt fallback, never rejects', async () => {
    const fits = await fitObjective('y'.repeat(5001), { generate: async () => { throw new Error('429'); } });
    expect(fits).toMatchObject({ distilled: false, fallback: true });
    expect(fits.text).toHaveLength(DISTILLED_OBJECTIVE_CHAR_LIMIT);
  });

  it('an absent port (P-11 not wired) answers the excerpt fallback', async () => {
    const fits = await fitObjective('y'.repeat(5001));
    expect(fits.fallback).toBe(true);
    expect(fits.text).toHaveLength(DISTILLED_OBJECTIVE_CHAR_LIMIT);
  });

  it('the excerpt is head + marker + tail at half/half of the budget', () => {
    const raw = 'abc'.repeat(2000); // 6000 chars, distinct head/tail content
    const excerpt = headTailExcerpt(raw, DISTILLED_OBJECTIVE_CHAR_LIMIT, TRIM_MARKER);
    const body = DISTILLED_OBJECTIVE_CHAR_LIMIT - TRIM_MARKER.length;
    expect(excerpt).toHaveLength(DISTILLED_OBJECTIVE_CHAR_LIMIT);
    const [head, tail] = excerpt.split(TRIM_MARKER) as [string, string];
    expect(head).toBe(raw.slice(0, Math.floor(body / 2)));
    expect(tail).toBe(raw.slice(raw.length - (body - Math.floor(body / 2))));
    expect(excerpt.slice(head.length, head.length + TRIM_MARKER.length)).toBe(TRIM_MARKER);
  });

  it('the excerpt works with custom budgets and never goes negative on tiny inputs', () => {
    const tiny = headTailExcerpt('abc', 20, '\n\n[m .]\n\n');
    expect(tiny).toBe('abc\n\n[m .]\n\n'); // smaller than the budget: whole text rides
    const clipped = headTailExcerpt('0123456789'.repeat(3), 14, '.m.');
    expect(clipped).toHaveLength(14);
    expect(clipped).toContain('.m.');
  });
});
