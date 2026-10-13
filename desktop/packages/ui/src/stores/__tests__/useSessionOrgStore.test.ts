// SPDX-License-Identifier: Apache-2.0
/** Session-organization store: load hydration, write-through op application,
 * and forget. runtime-fetch is mocked at the lib boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionOrgStore, orgRecordOf, __resetSessionOrgStoreForTests } from '../useSessionOrgStore.ts';

const store: Record<string, Record<string, Record<string, unknown>>> = {};
let failPost = false;
let failLoad = false;

vi.mock('../../lib/runtime-fetch.ts', () => ({
  runtimeFetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes('/api/session-org')) throw new Error(`unexpected fetch ${url}`);
    if ((init?.method ?? 'GET') !== 'POST') {
      if (failLoad) return Response.json({ error: 'read failed' }, { status: 500 });
      const directory = decodeURIComponent(/directory=([^&]*)/u.exec(url)?.[1] ?? '');
      return Response.json({ version: 1, records: store[directory] ?? {} });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      directory: string; sessionID: string; op: string };
    if (failPost) return Response.json({ error: 'denied' }, { status: 409 });
    const record = store[body.directory]?.[body.sessionID] ?? {};
    if (body.op === 'btw.setChild') record.btwChildOf = body.childSessionID;
    (store[body.directory] ??= {})[body.sessionID] = record;
    return Response.json({ success: true, record });
  }),
}));

beforeEach(() => {
  __resetSessionOrgStoreForTests();
  for (const key of Object.keys(store)) delete store[key];
  failPost = false;
  failLoad = false;
});

describe('useSessionOrgStore', () => {
  it('loads a directory once and serves records synchronously', async () => {
    store['D:/work'] = { ses_1: { btwChildOf: 'ses_2' } };
    await useSessionOrgStore.getState().load('D:/work/');
    expect(orgRecordOf('D:/work', 'ses_1')).toEqual({ btwChildOf: 'ses_2' });
    expect(useSessionOrgStore.getState().loadedDirectories['D:/work']).toBe(true);
  });

  it('applies ops with write-through and normalizes the directory key', async () => {
    const record = await useSessionOrgStore.getState().applyOp('D:/work/', 'ses_parent', 'btw.setChild',
      { childSessionID: 'ses_child' });
    expect(record).toEqual({ btwChildOf: 'ses_child' });
    expect(orgRecordOf('D:/work', 'ses_parent')?.btwChildOf).toBe('ses_child');
    expect(useSessionOrgStore.getState().loadedDirectories['D:/work']).toBe(true);
  });

  it('surfaces write failures without corrupting local state', async () => {
    await useSessionOrgStore.getState().applyOp('D:/work', 'ses_1', 'btw.setChild', { childSessionID: 'ses_2' });
    failPost = true;
    await expect(useSessionOrgStore.getState().applyOp('D:/work', 'ses_1', 'btw.setChild',
      { childSessionID: 'ses_3' })).rejects.toThrow('denied');
    expect(orgRecordOf('D:/work', 'ses_1')?.btwChildOf).toBe('ses_2');
    expect(useSessionOrgStore.getState().lastError).toBeNull();
  });

  it('keeps the directory unloaded after a failed load and retries on demand', async () => {
    failLoad = true;
    await useSessionOrgStore.getState().load('D:/work');
    expect(useSessionOrgStore.getState().lastError).toContain('read failed');
    expect(useSessionOrgStore.getState().loadedDirectories['D:/work']).toBeUndefined();
    failLoad = false;
    const record = await useSessionOrgStore.getState().applyOp('D:/work', 'ses_1', 'btw.setChild',
      { childSessionID: 'ses_2' });
    expect(record).toEqual({ btwChildOf: 'ses_2' });
  });

  it('forgets a directory so the next load refetches', async () => {
    store['D:/work'] = { ses_1: { btwChildOf: 'ses_2' } };
    useSessionOrgStore.setState({ recordsByDirectory: { 'D:/work': { ses_9: {} } },
      loadedDirectories: { 'D:/work': true } });
    useSessionOrgStore.getState().forget('D:/work/');
    expect(useSessionOrgStore.getState().recordsByDirectory['D:/work']).toBeUndefined();
    await useSessionOrgStore.getState().load('D:/work');
    expect(orgRecordOf('D:/work', 'ses_1')).toEqual({ btwChildOf: 'ses_2' });
  });
});
