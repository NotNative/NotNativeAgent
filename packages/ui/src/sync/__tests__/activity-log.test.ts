// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { MAX_ACTIVITY_RECORDS, MAX_ACTIVITY_SUMMARY_LENGTH, activityRecordFromEvent, mergeActivityRecord } from '../activity-log.ts';

describe('operator activity evidence', () => {
  it('accepts only explicit, complete nnd.activity records', () => {
    expect(activityRecordFromEvent({ type: 'message.part.updated', properties: {} })).toBeNull();
    expect(activityRecordFromEvent({ type: 'nnd.activity', properties: { id: 'a1', sessionID: 's1', kind: 'tool', status: 'started', summary: 'Running a tool', time: 10 } }))
      .toEqual({ id: 'a1', sessionID: 's1', kind: 'tool', status: 'started', summary: 'Running a tool', time: 10 });
    expect(activityRecordFromEvent({ type: 'nnd.activity', properties: { id: 'a1', sessionID: 's1', kind: 'tool', status: 'started', summary: 'Running a tool' } })).toBeNull();
    expect(activityRecordFromEvent({ type: 'nnd.activity', properties: { id: 'a1', sessionID: 's1', kind: 'tool', status: 'started', summary: 'Running a tool', time: Number.MAX_VALUE } })).toBeNull();
    expect(activityRecordFromEvent({ type: 'nnd.activity', properties: { id: 'a1', sessionID: 's1', kind: 'tool', status: 'started', summary: 'x'.repeat(MAX_ACTIVITY_SUMMARY_LENGTH + 1), time: 10 } })).toBeNull();
    const maxId = `${'s'.repeat(128)}:turn:${'r'.repeat(128)}`;
    expect(activityRecordFromEvent({ type: 'nnd.activity', properties: { id: maxId, sessionID: 's'.repeat(128), kind: 'turn', status: 'started', summary: 'Turn started', time: 10, evidenceMessageID: 'r'.repeat(128) } })?.id).toBe(maxId);
    expect(activityRecordFromEvent({ type: 'nnd.activity', properties: { id: 'x'.repeat(265), sessionID: 's1', kind: 'turn', status: 'started', summary: 'Turn started', time: 10 } })).toBeNull();
  });

  it('does not publish a false update for an exact replay', () => {
    const record = activityRecordFromEvent({ type: 'nnd.activity', properties: { id: 'a1', sessionID: 's1', kind: 'turn', status: 'started', summary: 'Turn started', time: 10 } })!;
    expect(mergeActivityRecord([record], record)).toBeTruthy();
    const records = [record];
    expect(mergeActivityRecord(records, { ...record })).toBe(records);
  });

  it('accepts only bounded turn-to-message evidence references and tracks corrections', () => {
    const properties = { id: 's1:turn:prompt_a', sessionID: 's1', kind: 'turn', status: 'started', summary: 'Turn started', time: 10, evidenceMessageID: 'prompt_a' };
    const linked = activityRecordFromEvent({ type: 'nnd.activity', properties });
    expect(linked?.evidenceMessageID).toBe('prompt_a');
    expect(activityRecordFromEvent({ type: 'nnd.activity', properties: { ...properties, kind: 'tool' } })).toBeNull();
    expect(activityRecordFromEvent({ type: 'nnd.activity', properties: { ...properties, evidenceMessageID: 'bad\nanchor' } })).toBeNull();
    expect(activityRecordFromEvent({ type: 'nnd.activity', properties: { ...properties, evidenceMessageID: 'x'.repeat(257) } })).toBeNull();
    expect(mergeActivityRecord([linked!], { ...linked!, evidenceMessageID: undefined })).not.toBe(linked);
  });

  it('replaces a record when NNA corrects or redacts the same evidence id', () => {
    const started = activityRecordFromEvent({ type: 'nnd.activity', properties: { id: 'a1', sessionID: 's1', kind: 'turn', status: 'started', summary: 'Turn started', time: 10 } })!;
    const redacted = { ...started, status: 'redacted' as const, summary: 'Redacted by NNA', time: 12 };
    expect(mergeActivityRecord([started], redacted)).toEqual([redacted]);
  });

  it('keeps the newest bounded evidence rows', () => {
    const records = Array.from({ length: MAX_ACTIVITY_RECORDS }, (_, i) => ({ id: String(i), sessionID: 's1', time: i, kind: 'notice' as const, status: 'completed' as const, summary: String(i) }));
    const next = mergeActivityRecord(records, { id: 'new', sessionID: 's1', time: 999, kind: 'notice', status: 'completed', summary: 'new' });
    expect(next).toHaveLength(MAX_ACTIVITY_RECORDS);
    expect(next[0]!.id).toBe('1');
    expect(next.at(-1)!.id).toBe('new');
  });
});
