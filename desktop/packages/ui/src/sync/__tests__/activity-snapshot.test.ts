// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessClient } from '../../lib/nnd/client.ts';
import { createDirectoryStore } from '../child-store.ts';
import { mergeActivitySnapshot, refreshActivitySnapshot } from '../activity-snapshot.ts';
import type { ActivityRecord } from '../activity-log.ts';

const row = (id: string, time: number, status: ActivityRecord['status'] = 'started'): ActivityRecord =>
  ({ id, sessionID: 's1', time, kind: 'turn', status, summary: `${id}: ${status}` });

afterEach(() => vi.restoreAllMocks());

describe('NNA Activity snapshot merge', () => {
  it('prepends missed source evidence while retaining a newer live correction', () => {
    const live = row('turn', 12, 'completed');
    const merged = mergeActivitySnapshot([live], 's1', [row('older', 2), row('turn', 10)]);
    expect(merged).toEqual([row('older', 2), live]);
    expect(mergeActivitySnapshot(merged, 's1', [row('older', 2), row('turn', 10)])).toBe(merged);
  });

  it('lets the saved terminal state beat a same-millisecond live start', () => {
    expect(mergeActivitySnapshot([row('turn', 10)], 's1', [row('turn', 10, 'completed')]))
      .toEqual([row('turn', 10, 'completed')]);
  });

  it('preserves a newer classified tool-evidence correction and reuses an exact replay', () => {
    const live: ActivityRecord = { id: 'tool-a', sessionID: 's1', time: 12, kind: 'tool', status: 'completed',
      summary: 'shell_run: succeeded', toolEvidence: { target: 'D:/work/check.js', elapsedMs: 25 } };
    const saved: ActivityRecord = { ...live, time: 10, toolEvidence: { target: 'D:/work/check.js', elapsedMs: 12 } };
    const merged = mergeActivitySnapshot([live], 's1', [saved]);
    expect(merged).toEqual([live]);
    expect(mergeActivitySnapshot(merged, 's1', [saved])).toBe(merged);
  });

  it('keeps current evidence on failure, malformed data, or a stale request', async () => {
    const store = createDirectoryStore({ activity: [row('live', 10)] });
    const request = vi.spyOn(harnessClient, 'listActivity');
    request.mockResolvedValueOnce({ data: [{ ...row('bad', 5), sessionID: 'another' }] } as never);
    expect(await refreshActivitySnapshot(store, '/work', 's1')).toBe(false);
    expect(store.getState().activity).toEqual([row('live', 10)]);
    request.mockResolvedValueOnce({ data: [row('saved', 5)] } as never);
    expect(await refreshActivitySnapshot(store, '/work', 's1', () => false)).toBe(false);
    expect(store.getState().activity).toEqual([row('live', 10)]);
    request.mockResolvedValueOnce({ data: [row('saved', 5)] } as never);
    expect(await refreshActivitySnapshot(store, '/work', 's1')).toBe(true);
    expect(store.getState().activity).toEqual([row('saved', 5), row('live', 10)]);
  });
});
