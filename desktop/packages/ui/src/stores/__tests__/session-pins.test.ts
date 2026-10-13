// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { beforeEach, expect, it } from 'vitest';
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import { pinnedSessionIds, useSessionPinnedStore } from '../useSessionPinnedStore.ts';

initializeRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:61776', runtimeKey: 'local' });

beforeEach(() => {
  localStorage.clear();
  useSessionPinnedStore.setState({ pins: {} });
});

it('persists a pin and isolates it by runtime and normalized directory', () => {
  useSessionPinnedStore.getState().toggle('d:\\work\\', 'ses_one');
  const pins = useSessionPinnedStore.getState().pins;
  expect([...pinnedSessionIds(pins, 'D:/work')]).toEqual(['ses_one']);
  expect(pinnedSessionIds(pins, 'D:/other').size).toBe(0);
  expect(pinnedSessionIds(pins, 'D:/work', 'host:other').size).toBe(0);
  useSessionPinnedStore.setState({ pins: {} });
  useSessionPinnedStore.getState().reload();
  expect([...pinnedSessionIds(useSessionPinnedStore.getState().pins, 'D:/work')]).toEqual(['ses_one']);
});

it('unpins and clears a deleted session without touching another workspace pin', () => {
  useSessionPinnedStore.getState().toggle('D:/work', 'ses_one');
  useSessionPinnedStore.getState().toggle('D:/other', 'ses_one');
  useSessionPinnedStore.getState().clear('D:/work', 'ses_one');
  expect(pinnedSessionIds(useSessionPinnedStore.getState().pins, 'D:/work').size).toBe(0);
  expect([...pinnedSessionIds(useSessionPinnedStore.getState().pins, 'D:/other')]).toEqual(['ses_one']);
  useSessionPinnedStore.getState().toggle('D:/other', 'ses_one');
  expect(useSessionPinnedStore.getState().pins).toEqual({});
});

it('keeps valid pins when persisted data includes one malformed key', () => {
  useSessionPinnedStore.getState().toggle('D:/work', 'ses_one');
  const pins = useSessionPinnedStore.getState().pins;
  localStorage.setItem('nnd.sessions.pinned.v1', JSON.stringify({ ...pins, broken: 3 }));
  useSessionPinnedStore.getState().reload();
  expect([...pinnedSessionIds(useSessionPinnedStore.getState().pins, 'D:/work')]).toEqual(['ses_one']);
});

it('clears against the runtime captured when an async delete began', () => {
  useSessionPinnedStore.setState({ pins: {
    [JSON.stringify(['host:old', 'D:/work', 'ses_one'])]: 1,
    [JSON.stringify(['local', 'D:/work', 'ses_one'])]: 2,
  } });
  useSessionPinnedStore.getState().clear('D:/work', 'ses_one', 'host:old');
  expect(pinnedSessionIds(useSessionPinnedStore.getState().pins, 'D:/work', 'host:old').size).toBe(0);
  expect([...pinnedSessionIds(useSessionPinnedStore.getState().pins, 'D:/work')]).toEqual(['ses_one']);
});
