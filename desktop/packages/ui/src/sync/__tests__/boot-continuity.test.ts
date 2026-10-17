// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import { restoreNativeContinuity, finishNativeContinuity, nativeContinuityPending } from '../../lib/native-continuity.ts';
import { notifySessionRouteNavigation, sessionNavigationRevision } from '../../lib/session-route.ts';
import { harnessClient } from '../../lib/nnd/client.ts';
import { nativeContinuityDirectory } from '../boot-continuity.ts';
import { useSessionViewStore } from '../view-store.ts';
initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:12345', runtimeKey: 'native:here' });
const observed = (directory = '/workspace', archived?: number) => ({ data: { id: 's1', directory, time: { created: 1, updated: 1, archived } }, error: null }) as never;
beforeEach(() => {
  localStorage.clear(); finishNativeContinuity('native:here');
  useSessionViewStore.setState({ activeDirectory: '/attached', currentSessionId: null, currentDraftId: null });
  vi.spyOn(harnessClient, 'getSession').mockResolvedValue(observed());
});
afterEach(() => { finishNativeContinuity('native:here'); vi.restoreAllMocks(); });
function handoff() {
  restoreNativeContinuity({ runtime: 'native:here', drafts: '{}', lastSession: JSON.stringify({ version: 1,
    runtimes: { 'native:here': { sessionId: 's1', directory: '/workspace', updatedAt: 1 } } }) }, 'native:here');
}
it('bootstraps the handed-off workspace only after its native session owner confirms it', async () => {
  handoff();
  expect(await nativeContinuityDirectory('/fallback', sessionNavigationRevision())).toBe('/workspace');
  expect(harnessClient.getSession).toHaveBeenCalledWith('s1', { directory: '' });
  expect(useSessionViewStore.getState().activeDirectory).toBe('/workspace');
  expect(useSessionViewStore.getState().currentSessionId).toBeNull(); // authoritative child list still owns opening
  expect(nativeContinuityPending('native:here')).toBe(true);
});
it.each(['missing', 'different-directory', 'archived', 'new-navigation', 'selected-session', 'selected-draft', 'failed-lookup'])('preserves current navigation when the resume pointer is %s', async reason => {
  handoff(); const revision = sessionNavigationRevision();
  if (reason === 'missing') vi.mocked(harnessClient.getSession).mockResolvedValueOnce({ data: undefined, error: 'not-found' });
  if (reason === 'different-directory') vi.mocked(harnessClient.getSession).mockResolvedValueOnce(observed('/other'));
  if (reason === 'archived') vi.mocked(harnessClient.getSession).mockResolvedValueOnce(observed('/workspace', 2));
  if (reason === 'new-navigation') notifySessionRouteNavigation();
  if (reason === 'selected-session') useSessionViewStore.setState({ currentSessionId: 's2' });
  if (reason === 'selected-draft') useSessionViewStore.setState({ currentDraftId: 'draft_00000000-0000-4000-8000-000000000000' });
  if (reason === 'failed-lookup') vi.mocked(harnessClient.getSession).mockRejectedValueOnce(new Error('offline'));
  expect(await nativeContinuityDirectory('/fallback', revision)).toBe('/attached');
  expect(useSessionViewStore.getState().activeDirectory).toBe('/attached');
  expect(nativeContinuityPending('native:here')).toBe(false);
});
it('waits for the native read and preserves a selection made while it was pending', async () => {
  handoff(); let finish: (value: never) => void = () => {};
  vi.mocked(harnessClient.getSession).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = nativeContinuityDirectory('/fallback', sessionNavigationRevision());
  useSessionViewStore.setState({ activeDirectory: '/chosen' }); notifySessionRouteNavigation(); finish(observed());
  expect(await pending).toBe('/chosen');
});
