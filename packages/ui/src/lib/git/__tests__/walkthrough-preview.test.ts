// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.ts', () => ({ fetchGitStatus: vi.fn(), fetchGitDiff: vi.fn(),
  isStagedStatusFile: (file: { index: string }) => file.index === 'M',
  isWorkingStatusFile: (file: { working_dir: string }) => file.working_dir === 'M',
}));
import { fetchGitDiff, fetchGitStatus } from '../api.ts';
import { loadWalkthroughPreview, WALKTHROUGH_MAX_FILES } from '../walkthrough-preview.ts';

const status = fetchGitStatus as ReturnType<typeof vi.fn>;
const diff = fetchGitDiff as ReturnType<typeof vi.fn>;
const patch = (path: string, body: string): string => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${body}\n`;

beforeEach(() => {
  status.mockReset(); diff.mockReset();
  status.mockResolvedValue({ isGitRepository: true, files: [
    { path: 'both.ts', index: 'M', working_dir: 'M' },
    { path: 'later.ts', index: ' ', working_dir: 'M' },
  ] });
  diff.mockImplementation(async (_directory: string, path: string, options: { staged: boolean }) =>
    ({ diff: patch(path, options.staged ? 'staged' : 'working') }));
});

describe('deterministic walkthrough preview', () => {
  it('orders actual staged and working hunks with distinct file/line anchors', async () => {
    const result = await loadWalkthroughPreview('/repo');
    expect(result.stops.map((stop) => `${stop.scope}:${stop.path}:${stop.newStart}`)).toEqual([
      'staged:both.ts:1', 'working:both.ts:1', 'working:later.ts:1',
    ]);
    expect(result.stops[0]?.hunk.rows.at(-1)?.text).toBe('staged');
    expect(result.stops[1]?.hunk.rows.at(-1)?.text).toBe('working');
  });

  it('changes the revision proof when diff text changes but status and line counts do not', async () => {
    const first = await loadWalkthroughPreview('/repo');
    diff.mockImplementation(async (_directory: string, path: string) => ({ diff: patch(path, 'changed') }));
    const second = await loadWalkthroughPreview('/repo');
    expect(first.signature).not.toBe(second.signature);
  });

  it('changes the revision proof when branch or status changes without patch text changing', async () => {
    const first = await loadWalkthroughPreview('/repo');
    status.mockResolvedValue({ isGitRepository: true, branch: 'other', files: [
      { path: 'both.ts', index: 'M', working_dir: 'M' }, { path: 'later.ts', index: ' ', working_dir: 'M' },
    ] });
    expect((await loadWalkthroughPreview('/repo')).signature).not.toBe(first.signature);
  });

  it('refuses oversized file sets rather than silently omitting stops', async () => {
    status.mockResolvedValue({ isGitRepository: true, files: Array.from({ length: WALKTHROUGH_MAX_FILES + 1 }, (_, i) =>
      ({ path: `${i}.ts`, index: ' ', working_dir: 'M' })) });
    await expect(loadWalkthroughPreview('/repo')).rejects.toThrow(/at most/);
    expect(diff).not.toHaveBeenCalled();
  });

  it('refuses a missing diff instead of presenting a misleading partial tour', async () => {
    diff.mockResolvedValue(null);
    await expect(loadWalkthroughPreview('/repo')).rejects.toThrow(/Could not load/);
  });
});
