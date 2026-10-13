// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ key: 'native-a', listener: () => {} }));
vi.mock('../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => runtime.key,
  onRuntimeEndpointChanged: (listener: () => void) => { runtime.listener = listener; return () => {}; },
}));
import { assertFreshAuthority, authorityState, beginAuthorityRecovery, finishAuthorityRecovery, subscribeAuthority } from '../authority-sync.ts';

it('keeps failed native authority closed until a later successful recovery', () => {
  runtime.key = 'native-a';
  const observations: string[] = [];
  const unsubscribe = subscribeAuthority(() => observations.push(authorityState()));
  const first = beginAuthorityRecovery();
  expect(() => assertFreshAuthority()).toThrow(/resynchronizing/);
  finishAuthorityRecovery('native-a', first, false);
  expect(authorityState()).toBe('failed');
  expect(() => assertFreshAuthority()).toThrow(/resynchronizing/);
  const second = beginAuthorityRecovery();
  finishAuthorityRecovery('native-a', first, true); // stale completion cannot reopen
  expect(authorityState()).toBe('recovering');
  finishAuthorityRecovery('native-a', second, true);
  expect(() => assertFreshAuthority()).not.toThrow();
  expect(observations).toEqual(['recovering', 'failed', 'recovering', 'ready']);
  unsubscribe();
});

it('scopes pending recovery to its runtime', () => {
  runtime.key = 'native-a';
  const token = beginAuthorityRecovery();
  runtime.key = 'native-b'; runtime.listener();
  expect(authorityState()).toBe('ready');
  finishAuthorityRecovery('native-a', token, true);
  expect(authorityState('native-a')).toBe('recovering');
});
