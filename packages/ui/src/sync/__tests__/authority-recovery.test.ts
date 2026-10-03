// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
vi.mock('../../lib/nnd/client.ts', () => import('./harness-client-mock.ts'));
vi.mock('../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => 'authority-recovery-runtime', onRuntimeEndpointChanged: () => () => undefined,
}));

import { configureHarness } from './harness-client-mock.ts';
import { createDirectoryStore } from '../child-store.ts';
import { createRecovery } from '../engine-recovery.ts';
import { useGlobalSessionsStore } from '../global-stores.ts';
import { useSessionViewStore } from '../view-store.ts';

function recovery(withCandidate = false) {
  const directory = 'D:/work';
  const store = createDirectoryStore();
  if (withCandidate) store.setState({ session: [{ id: 'session-1', directory }] as never,
    session_status: { 'session-1': { type: 'busy' } } as never });
  return createRecovery({
    disposed: () => false,
    manager: { children: new Map([[directory, store]]) } as never,
    loader: {} as never,
    routing: {} as never,
    afterMessageLoad: () => undefined,
    beginCatalog: () => () => undefined,
  });
}

it('requires complete directory and global catalog reads before restoring authority', async () => {
  useGlobalSessionsStore.getState().reset();
  useSessionViewStore.setState({ currentSessionId: null });
  configureHarness({ listSessions: () => [], listQuestions: () => [], listPermissions: () => [] });
  expect(await recovery().recoverAuthorityGap('explicit-gap')).toBe(true);
  configureHarness({ listSessions: (call) => call.opts?.archived ? { error: 'offline' } : [],
    listQuestions: () => [], listPermissions: () => [] });
  expect(await recovery().recoverAuthorityGap('explicit-gap')).toBe(false);
  expect(useGlobalSessionsStore.getState().status).toBe('error');
  useGlobalSessionsStore.getState().reset();
});

it('does not restore authority when a blocking-request catalog is unavailable', async () => {
  useGlobalSessionsStore.getState().reset();
  configureHarness({ listSessions: () => [], listQuestions: () => [], listPermissions: () => ({ error: 'offline' }) });
  expect(await recovery().recoverAuthorityGap('explicit-gap')).toBe(false);
  useGlobalSessionsStore.getState().reset();
});

it('does not restore authority when candidate status cannot be read', async () => {
  useGlobalSessionsStore.getState().reset();
  configureHarness({ listSessions: () => [], listQuestions: () => [], listPermissions: () => [],
    sessionStatus: () => ({ error: 'offline' }) });
  expect(await recovery(true).recoverAuthorityGap('explicit-gap')).toBe(false);
  useGlobalSessionsStore.getState().reset();
});
