// SPDX-License-Identifier: Apache-2.0
/** NNA-authored Activity filters: never infer tool ownership from timestamps. */
import { latestTurnRequestID, type ActivityRecord } from '../sync/activity-log.ts';

export type ActivityFilter = 'all' | 'turn' | 'tool' | 'notice' | 'state' | 'subagent' | 'attention' | 'failed' | 'files' | 'last-turn';

export const ACTIVITY_FILTERS: readonly { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'last-turn', label: 'Last turn' },
  { id: 'files', label: 'Files' }, { id: 'turn', label: 'Turns' }, { id: 'state', label: 'States' }, { id: 'tool', label: 'Tools' }, { id: 'subagent', label: 'Subagents' },
  { id: 'notice', label: 'Notices' }, { id: 'attention', label: 'Needs input' }, { id: 'failed', label: 'Failures' },
];

export function filterActivityRecords(activity: readonly ActivityRecord[], sessionID: string | null,
  filter: ActivityFilter): ActivityRecord[] {
  if (!sessionID) return [];
  const records = activity.filter((record) => record.sessionID === sessionID);
  if (filter === 'all') return records;
  if (filter === 'last-turn') {
    const turnRequestID = latestTurnRequestID(records, sessionID);
    if (!turnRequestID) return [];
    return records.filter((record) => (record.kind === 'turn' || record.kind === 'state' || record.kind === 'subagent') && record.evidenceMessageID === turnRequestID
      || record.kind === 'tool' && record.toolEvidence?.turnRequestID === turnRequestID);
  }
  if (filter === 'files') return records.filter((record) => record.kind === 'tool'
    && record.status === 'completed' && !!record.toolEvidence?.reviewPath);
  if (filter === 'failed' || filter === 'attention') return records.filter((record) => record.status === filter);
  return records.filter((record) => record.kind === filter);
}
