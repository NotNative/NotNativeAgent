// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { ActivityRecord } from '../../../sync/activity-log.ts';
import type { GitStatus } from '../../../lib/git/api.ts';
import { sessionChangedFiles } from '../session-change-evidence.ts';

const directory = '/repo/packages/ui';
const status: GitStatus = {
  isGitRepository: true, workspacePrefix: 'packages/ui/', branch: 'main', trackingAhead: 0, trackingBehind: 0,
  files: [
    { path: 'packages/ui/src/both.ts', index: 'M', working_dir: 'M' },
    { path: 'packages/ui/src/working.ts', index: ' ', working_dir: 'M' },
    { path: 'packages/ui/src/other.ts', index: ' ', working_dir: 'M' },
  ],
};

function evidence(id: string, path: string, overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  return { id, sessionID: 'selected', time: 1, kind: 'tool', status: 'completed', summary: 'Edited file',
    toolEvidence: { reviewPath: path, reviewDirectory: directory }, ...overrides };
}

describe('sessionChangedFiles', () => {
  it('deduplicates current staged and working paths touched in the selected session', () => {
    expect(sessionChangedFiles([evidence('a', 'src/both.ts'), evidence('b', 'src/both.ts'),
      evidence('c', 'src/working.ts')], 'selected', directory, status)).toEqual([
      { path: 'packages/ui/src/both.ts', staged: true, working: true },
      { path: 'packages/ui/src/working.ts', staged: false, working: true },
    ]);
  });

  it('excludes other sessions, workspaces, failed tools, and paths no longer changed', () => {
    expect(sessionChangedFiles([
      evidence('a', 'src/other.ts', { sessionID: 'another' }),
      evidence('b', 'src/other.ts', { toolEvidence: { reviewPath: 'src/other.ts', reviewDirectory: '/elsewhere' } }),
      evidence('c', 'src/other.ts', { status: 'failed' }),
      evidence('d', 'src/gone.ts'),
    ], 'selected', directory, status)).toEqual([]);
  });

  it('refuses malformed repository prefixes instead of matching an unrelated path', () => {
    expect(sessionChangedFiles([evidence('a', 'src/both.ts')], 'selected', directory,
      { ...status, workspacePrefix: '../' })).toEqual([]);
  });
});
