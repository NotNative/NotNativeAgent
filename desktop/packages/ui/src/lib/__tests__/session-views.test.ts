// SPDX-License-Identifier: Apache-2.0
/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { startSessionViews } from '../session-views.ts';
import { useSessionViewStore } from '../../sync/view-store.ts';
import type { PushApi } from '../api/push-types.ts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); useSessionViewStore.getState().setCurrentSession(null); });

it('moves client leases on selection, heartbeats while focused, releases on blur and restores from BFCache', async () => {
  vi.useFakeTimers(); let focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  useSessionViewStore.getState().setCurrentSession('s1');
  const setSessionViewed = vi.fn().mockResolvedValue({});
  const stop = startSessionViews({ setSessionViewed } as unknown as PushApi, () => true, 'tab-one');
  expect(setSessionViewed).toHaveBeenLastCalledWith('s1', true, 'tab-one', 1);
  useSessionViewStore.getState().setCurrentSession('s2');
  expect(setSessionViewed.mock.calls.slice(-2)).toEqual([['s1', false, 'tab-one', 2], ['s2', true, 'tab-one', 3]]);
  vi.advanceTimersByTime(20_000); expect(setSessionViewed).toHaveBeenLastCalledWith('s2', true, 'tab-one', 4);
  focused = false; window.dispatchEvent(new Event('blur'));
  expect(setSessionViewed).toHaveBeenLastCalledWith('s2', false, 'tab-one', 5);
  focused = true; window.dispatchEvent(new Event('pageshow'));
  window.dispatchEvent(new Event('pagehide')); const count = setSessionViewed.mock.calls.length;
  vi.advanceTimersByTime(20_000); expect(setSessionViewed).toHaveBeenCalledTimes(count);
  window.dispatchEvent(new Event('pageshow')); expect(setSessionViewed).toHaveBeenLastCalledWith('s2', true, 'tab-one', 8);
  stop(); const final = setSessionViewed.mock.calls.length;
  vi.advanceTimersByTime(20_000); window.dispatchEvent(new Event('focus'));
  expect(setSessionViewed).toHaveBeenCalledTimes(final); expect(vi.getTimerCount()).toBe(0);
  await Promise.resolve();
});

it('does not send old lease cleanup into a newly selected instance', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  useSessionViewStore.getState().setCurrentSession('s1'); let current = true;
  const setSessionViewed = vi.fn().mockResolvedValue({});
  const stop = startSessionViews({ setSessionViewed } as unknown as PushApi, () => current, 'tab');
  current = false; stop(); expect(setSessionViewed).toHaveBeenCalledOnce();
});
