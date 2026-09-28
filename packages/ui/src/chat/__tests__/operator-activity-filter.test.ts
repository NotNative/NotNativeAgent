// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { ActivityRecord } from '../../sync/activity-log.ts';
import { filterActivityRecords } from '../operator-activity-filter.ts';

const activity: ActivityRecord[] = [
  { id: 'old-turn', sessionID: 's1', time: 1, kind: 'turn', status: 'completed', summary: 'Old', evidenceMessageID: 'old' },
  { id: 'old-file', sessionID: 's1', time: 2, kind: 'tool', status: 'completed', summary: 'Old file',
    toolEvidence: { reviewPath: 'old.ts', reviewDirectory: '/work', turnRequestID: 'old' } },
  { id: 'new-turn', sessionID: 's1', time: 3, kind: 'turn', status: 'started', summary: 'New', evidenceMessageID: 'new' },
  { id: 'new-file', sessionID: 's1', time: 4, kind: 'tool', status: 'completed', summary: 'New file',
    toolEvidence: { reviewPath: 'new.ts', reviewDirectory: '/work', turnRequestID: 'new' } },
  { id: 'legacy-file', sessionID: 's1', time: 5, kind: 'tool', status: 'completed', summary: 'Legacy file',
    toolEvidence: { reviewPath: 'legacy.ts', reviewDirectory: '/work' } },
  { id: 'failed-tool', sessionID: 's1', time: 6, kind: 'tool', status: 'failed', summary: 'Failed file',
    toolEvidence: { turnRequestID: 'new' } },
  { id: 'other', sessionID: 's2', time: 7, kind: 'turn', status: 'completed', summary: 'Different session', evidenceMessageID: 'other' },
];

describe('filterActivityRecords', () => {
  it('uses authored turn correlation and includes turn milestones with their tools', () => {
    expect(filterActivityRecords(activity, 's1', 'last-turn').map((record) => record.id))
      .toEqual(['new-turn', 'new-file', 'failed-tool']);
    expect(filterActivityRecords(activity.filter((record) => record.kind !== 'turn'), 's1', 'last-turn')).toEqual([]);
    expect(filterActivityRecords([...activity, { id: 'legacy-turn', sessionID: 's1', time: 8,
      kind: 'turn', status: 'started', summary: 'Legacy turn' }], 's1', 'last-turn')).toEqual([]);
  });

  it('shows completed authored file events without implying every tool was a file change', () => {
    expect(filterActivityRecords(activity, 's1', 'files').map((record) => record.id))
      .toEqual(['old-file', 'new-file', 'legacy-file']);
    expect(filterActivityRecords(activity, null, 'all')).toEqual([]);
    expect(filterActivityRecords(activity, 's1', 'failed').map((record) => record.id)).toEqual(['failed-tool']);
  });
});
