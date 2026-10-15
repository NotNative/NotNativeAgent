// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../useWorkspaceStore.ts';
import { readNativeWorkspaceAdmissions, type WorkspaceAdmissions } from '../../lib/nnd/workspace-admission.ts';
vi.mock('../../lib/nnd/workspace-admission.ts', () => ({ readNativeWorkspaceAdmissions: vi.fn() }));
const inventory = { attached: { root: 'D:/work', id: 'ws_a' }, admitted: [], unavailable: [] } as unknown as WorkspaceAdmissions;
beforeEach(() => { useWorkspaceStore.getState().reset(); vi.resetAllMocks(); });

it('shares an in-flight read and ignores it after a newer admission', async () => {
  let resolve!: (value: WorkspaceAdmissions) => void;
  vi.mocked(readNativeWorkspaceAdmissions).mockReturnValue(new Promise(done => { resolve = done; }));
  const first = useWorkspaceStore.getState().load();
  const second = useWorkspaceStore.getState().load();
  expect(first).toBe(second);
  const added = { ...inventory, admitted: [{ root: 'D:/other', id: 'ws_b', operation_id: 'add' }] };
  useWorkspaceStore.getState().adopt(added);
  resolve(inventory); await first;
  expect(useWorkspaceStore.getState().inventory).toBe(added);
  expect(readNativeWorkspaceAdmissions).toHaveBeenCalledTimes(1);
});

it('preserves the last snapshot on refresh failure and permits retry', async () => {
  useWorkspaceStore.getState().adopt(inventory);
  vi.mocked(readNativeWorkspaceAdmissions).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(inventory);
  await useWorkspaceStore.getState().load(true);
  expect(useWorkspaceStore.getState()).toMatchObject({ inventory, phase: 'error', error: 'offline' });
  await useWorkspaceStore.getState().load(true);
  expect(useWorkspaceStore.getState().phase).toBe('ready');
});

it('discards a read completed after the connection resets', async () => {
  let resolve!: (value: WorkspaceAdmissions) => void;
  vi.mocked(readNativeWorkspaceAdmissions).mockReturnValue(new Promise(done => { resolve = done; }));
  const loading = useWorkspaceStore.getState().load();
  useWorkspaceStore.getState().reset();
  resolve(inventory); await loading;
  expect(useWorkspaceStore.getState().inventory).toBeNull();
});
