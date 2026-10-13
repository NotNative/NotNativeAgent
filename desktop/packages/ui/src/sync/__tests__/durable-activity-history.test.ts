// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessClient, setHarnessDirectory } from '../../lib/nnd/client.ts';
import * as transport from '../../lib/runtime-fetch.ts';
import { parseDurableActivityPage, readDurableActivityPage } from '../durable-activity-history.ts';

const digest = 'a'.repeat(64);
const record = { id: 'r1', sessionID: 's1', time: 10, kind: 'turn', status: 'completed', summary: 'Saved turn' };
const snapshot = { version: 1, sessionID: 's1', createdAt: 10, digest, durablePresent: true,
  retainedCount: 1, retentionLimit: 500, retainedLowerBound: 'r1', retainedUpperBound: 'r1', historyComplete: false };
afterEach(() => { setHarnessDirectory(''); vi.restoreAllMocks(); });

describe('durable Activity pages', () => {
  it('accepts only the selected incomplete retained window', async () => {
    const page = { status: 'page', snapshot, records: [record], nextCursor: null,
      liveBoundary: { status: 'paired', sessionID: 's1', cursor: 'evt_1' } };
    vi.spyOn(harnessClient, 'readActivityHistoryPage').mockResolvedValueOnce({ data: page });
    expect((await readDurableActivityPage('s1')).records[0]?.summary).toBe('Saved turn');
    expect(parseDurableActivityPage(page, 's2')).toBeNull();
    expect(parseDurableActivityPage({ ...page, snapshot: { ...snapshot, historyComplete: true } }, 's1')).toBeNull();
    expect(parseDurableActivityPage({ ...page, records: [{ ...record, sessionID: 's2' }] }, 's1')).toBeNull();
    expect(parseDurableActivityPage({ ...page, records: [record, record] }, 's1')).toBeNull();
  });

  it('accepts a changed snapshot only as an empty gap', () => {
    const gap = { status: 'gap', reason: 'snapshot_changed', snapshot, records: [], nextCursor: null };
    expect(parseDurableActivityPage(gap, 's1')?.status).toBe('gap');
    expect(parseDurableActivityPage({ ...gap, records: [record] }, 's1')).toBeNull();
    expect(parseDurableActivityPage({ ...gap, nextCursor: 'old' }, 's1')).toBeNull();
  });

  it('sends only native limit/cursor query keys even with an ambient directory', async () => {
    setHarnessDirectory('D:/work');
    const fetch = vi.spyOn(transport, 'runtimeFetch').mockResolvedValue(new Response(JSON.stringify({
      status: 'page', snapshot, records: [record], nextCursor: null,
    }), { status: 200 }));
    await readDurableActivityPage('s1', 'a/b');
    expect(fetch).toHaveBeenCalledWith('/api/v1/nnd/sessions/s1/activity-history?limit=50&cursor=a%2Fb', expect.any(Object));
  });
});
