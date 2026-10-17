// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useInitialConversation } from '../use-initial-conversation.ts';
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore.ts';
import { useGlobalSessionsStore } from '../../sync/global-stores.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';
import { useConversationDraftStore } from '../../stores/useConversationDraftStore.ts';
import { addNativeWorkspace, type WorkspaceAdmissions } from '../../lib/nnd/workspace-admission.ts';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { restoreNativeContinuity, takeNativeResumeSelection, finishNativeContinuity } from '../../lib/native-continuity.ts';
vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
vi.mock('../../lib/nnd/workspace-admission.ts', () => ({ addNativeWorkspace: vi.fn(), readNativeWorkspaceAdmissions: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });
let root: Root | null = null;
const inventory: WorkspaceAdmissions = { installation_id: 'install', data_id: 'data', revision: 'absent', selection_enabled: true,
  attached: { root: '/primary', id: `ws_${'a'.repeat(24)}` }, admitted: [], unavailable: [] };
beforeEach(() => {
  finishNativeContinuity('local'); window.history.replaceState(null, '', '/');
  vi.resetAllMocks(); localStorage.clear(); useConversationDraftStore.getState().load();
  useWorkspaceStore.getState().adopt(inventory);
  useGlobalSessionsStore.setState({ status: 'ready', active: [], archived: [], hasLoaded: true });
  useSessionViewStore.setState({ activeDirectory: '/primary', currentSessionId: null, currentDraftId: null });
  vi.mocked(runtimeFetch).mockImplementation(async path => Response.json(String(path).includes('workspace-default')
    ? { directory: '/data/workspaces/default' } : { version: 1, workspaces: {} }));
  vi.mocked(addNativeWorkspace).mockResolvedValue({ directory: '/data/workspaces/default', added: true,
    inventory: { ...inventory, admitted: [{ root: '/data/workspaces/default', id: `ws_${'b'.repeat(24)}`, operation_id: 'default' }] } });
});
afterEach(() => { act(() => root?.unmount()); root = null; finishNativeContinuity('local'); });
function mount(open = vi.fn()) {
  const node = document.createElement('div'); root = createRoot(node);
  function Probe() { const error = useInitialConversation(true, 'local', open); return <p>{error}</p>; }
  act(() => root!.render(<Probe />)); return open;
}

it('prepares and admits a real default folder only on first use', async () => {
  const open = mount();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(addNativeWorkspace).toHaveBeenCalledWith('/data/workspaces/default');
  expect(open).toHaveBeenCalledWith('/data/workspaces/default');
});

it('keeps existing workspace history on its original root', async () => {
  useGlobalSessionsStore.setState({ active: [{ id: 'ses_existing' } as never] });
  const open = mount();
  await act(async () => { await Promise.resolve(); });
  expect(open).toHaveBeenCalledWith('/primary');
  expect(runtimeFetch).not.toHaveBeenCalled();
});

it('does not override a session selected while default setup was in progress', async () => {
  let finish!: (value: Response) => void;
  vi.mocked(runtimeFetch).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  const open = mount();
  await act(async () => { useSessionViewStore.setState({ currentSessionId: 'ses_other' }); finish(Response.json({ directory: '/data/workspaces/default' })); await Promise.resolve(); });
  expect(open).not.toHaveBeenCalled();
});
it('does not create a default draft while native continuity is being resolved', async () => {
  restoreNativeContinuity({ runtime: 'local', drafts: '{}', lastSession: JSON.stringify({ version: 1, runtimes: {
    local: { sessionId: 'ses_resumed', directory: '/primary', updatedAt: 1 },
  } }) }, 'local');
  const open = mount(); takeNativeResumeSelection('local');
  await act(async () => { await Promise.resolve(); });
  expect(open).not.toHaveBeenCalled(); expect(runtimeFetch).not.toHaveBeenCalled();
  await act(async () => { useSessionViewStore.setState({ currentSessionId: 'ses_resumed' }); finishNativeContinuity('local'); });
  expect(open).not.toHaveBeenCalled();
});

it('does not select a saved draft while an explicit conversation link is resolving', async () => {
  window.history.replaceState(null, '', '/?session=ses_cold');
  useGlobalSessionsStore.setState({ active: [{ id: 'ses_other' } as never] });
  const open = mount();
  await act(async () => { await Promise.resolve(); });
  expect(open).not.toHaveBeenCalled(); expect(runtimeFetch).not.toHaveBeenCalled();
  await act(async () => useSessionViewStore.setState({ currentSessionId: 'ses_cold' }));
  expect(open).not.toHaveBeenCalled();
});
