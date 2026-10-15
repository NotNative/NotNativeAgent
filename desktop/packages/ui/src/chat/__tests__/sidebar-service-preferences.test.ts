// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimeFetch } from '../../lib/runtime-fetch.ts';
import { connectSidebarServicePreferences, queueSidebarPreference, resetSidebarServicePreferences } from '../sidebar-service-preferences.ts';
vi.mock('../../lib/runtime-fetch.ts', () => ({ runtimeFetch: vi.fn() }));
vi.mock('../../lib/runtime-switch.ts', () => ({ getRuntimeKey: () => 'selected-data' }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
beforeEach(() => { resetSidebarServicePreferences(); localStorage.clear(); });
afterEach(() => { resetSidebarServicePreferences(); vi.useRealTimers(); });
it('restores width, manual order and pins into a fresh browser origin', async () => {
  const pins = { [JSON.stringify(['D:/work', 'ses_one'])]: 12 };
  vi.mocked(runtimeFetch).mockResolvedValue(new Response(JSON.stringify({ 'sidebar.width': { revision: 3, value: '336' }, 'sidebar.workspace-order': { revision: 1, value: '["D:/work","D:/other"]' }, pins: { revision: 1, value: JSON.stringify(pins) } })));
  await connectSidebarServicePreferences();
  expect(localStorage.getItem('nnd.sidebar.v1:selected-data:width')).toBe('336');
  expect(JSON.parse(localStorage.getItem('nnd.sessions.pinned.v1')!)).toEqual({ [JSON.stringify(['selected-data', 'D:/work', 'ses_one'])]: 12 });
});
it('writes the latest choice with its saved revision', async () => {
  vi.useFakeTimers();
  vi.mocked(runtimeFetch).mockImplementation(async (_path, init) => new Response(JSON.stringify(init?.method === 'POST' ? { revision: 5, value: '360' } : { 'sidebar.width': { revision: 4, value: '336' } })));
  await connectSidebarServicePreferences(); queueSidebarPreference('sidebar.width', '348'); queueSidebarPreference('sidebar.width', '360');
  await vi.advanceTimersByTimeAsync(121);
  const calls = vi.mocked(runtimeFetch).mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(calls.at(-1)![1]!.body))).toEqual({ key: 'sidebar.width', value: '360', expected_revision: 4 });
});
