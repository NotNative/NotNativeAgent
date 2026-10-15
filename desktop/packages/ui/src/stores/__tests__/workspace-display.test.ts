// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { beforeEach, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { useWorkspaceDisplayStore } from '../useWorkspaceDisplayStore.ts';
vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); useWorkspaceDisplayStore.setState({ rows: {}, error: null }); });
const response = (workspaces: object) => new Response(JSON.stringify({ version: 1, workspaces }));

it('does not replace a saved name with a stale load response', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(runtimeFetch).mockImplementation(async (_path, init) => init
    ? response({ ws_a: { label: 'New name', hidden: false } })
    : new Promise<Response>(resolve => { finish = resolve; }));
  const reading = useWorkspaceDisplayStore.getState().load();
  await useWorkspaceDisplayStore.getState().save('ws_a', { label: 'New name', hidden: false });
  finish(response({ ws_a: { label: 'Old name', hidden: false } })); await reading;
  expect(useWorkspaceDisplayStore.getState().rows.ws_a?.label).toBe('New name');
});

it('preserves both workspace edits when the first response is delayed', async () => {
  let finish!: (response: Response) => void;
  const a = { label: 'Alpha', hidden: false }, b = { label: 'Beta', hidden: true };
  vi.mocked(runtimeFetch).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(response({ ws_a: a, ws_b: b }));
  const first = useWorkspaceDisplayStore.getState().save('ws_a', a);
  const second = useWorkspaceDisplayStore.getState().save('ws_b', b);
  await vi.waitFor(() => expect(runtimeFetch).toHaveBeenCalledTimes(1));
  finish(response({ ws_a: a })); await Promise.all([first, second]);
  expect(useWorkspaceDisplayStore.getState().rows).toEqual({ ws_a: a, ws_b: b });
});
