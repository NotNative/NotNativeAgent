// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { harnessClient } from '../../lib/nnd/client.ts';
import type { Session } from '../../lib/nnd/types.ts';
import { useGlobalSessionsStore } from '../global-stores.ts';

const session = (id: string, archived = 0): Session => ({ id, directory: 'D:/work', title: id, time: { created: 1, updated: 2, archived } }) as Session;

beforeEach(() => useGlobalSessionsStore.getState().reset());
afterEach(() => { vi.restoreAllMocks(); useGlobalSessionsStore.getState().reset(); });

it('loads the inclusive archive and preserves live upserts/deletes made during the read', async () => {
  let resolve!: (result: { data: Session[] }) => void;
  const pending = new Promise<{ data: Session[] }>((done) => { resolve = done; });
  vi.spyOn(harnessClient, 'listSessions').mockReturnValue(pending as ReturnType<typeof harnessClient.listSessions>);
  useGlobalSessionsStore.getState().upsertSession(session('deleted'));
  const loading = useGlobalSessionsStore.getState().loadSessions();
  expect(useGlobalSessionsStore.getState().status).toBe('loading');
  useGlobalSessionsStore.getState().removeSession('deleted');
  useGlobalSessionsStore.getState().upsertSession(session('live', 9));
  resolve({ data: [session('deleted'), session('remote', 5), session('live')] as Session[] });
  await loading;
  const state = useGlobalSessionsStore.getState();
  expect(state.status).toBe('ready');
  expect(state.active.map((item) => item.id)).toEqual([]);
  expect(state.archived.map((item) => item.id).sort()).toEqual(['live', 'remote']);
});

it('keeps the last list on failure and can retry without erasing it', async () => {
  const list = vi.spyOn(harnessClient, 'listSessions')
    .mockResolvedValueOnce({ data: [session('old', 4)] } as Awaited<ReturnType<typeof harnessClient.listSessions>>)
    .mockResolvedValueOnce({ error: 'offline' } as Awaited<ReturnType<typeof harnessClient.listSessions>>)
    .mockResolvedValueOnce({ data: [session('new', 6)] } as Awaited<ReturnType<typeof harnessClient.listSessions>>);
  await useGlobalSessionsStore.getState().loadSessions();
  await useGlobalSessionsStore.getState().loadSessions();
  expect(useGlobalSessionsStore.getState().status).toBe('error');
  expect(useGlobalSessionsStore.getState().archived.map((item) => item.id)).toEqual(['old']);
  await useGlobalSessionsStore.getState().loadSessions();
  expect(useGlobalSessionsStore.getState().archived.map((item) => item.id)).toEqual(['new']);
  expect(list).toHaveBeenCalledTimes(3);
});
