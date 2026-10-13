// SPDX-License-Identifier: Apache-2.0
import { beforeEach, expect, it, vi } from 'vitest';
const runtime = vi.hoisted(() => ({ key: 'authority-engine-test' }));
vi.mock('../../lib/runtime-switch.ts', () => ({
  getRuntimeKey: () => runtime.key,
  onRuntimeEndpointChanged: () => () => undefined,
  isTransientRuntimeKey: () => true,
}));
vi.mock('../../lib/nnd/client.ts', () => ({ harnessClient: { getConfig: vi.fn() } }));
import { harnessClient } from '../../lib/nnd/client.ts';
import { recoverGapAuthority } from '../engine-authority-recovery.ts';
import { authorityState } from '../authority-sync.ts';
import { activityGapAt } from '../activity-gap.ts';
import { useGlobalSyncStore } from '../global-stores.ts';

beforeEach(() => {
  runtime.key = 'authority-engine-test';
  useGlobalSyncStore.getState().reset();
  useGlobalSyncStore.getState().set({ config: { nnd: { engine: 'nna' } } });
  vi.mocked(harnessClient.getConfig).mockReset();
});

it('keeps controls closed through recovery failure and reopens only with fresh native config', async () => {
  let settle!: (value: boolean) => void;
  const recovery = { recoverAuthorityGap: vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; })) } as never;
  const signal = new AbortController().signal;
  const first = recoverGapAuthority(recovery, runtime.key, signal, true, () => true);
  expect(authorityState()).toBe('recovering');
  settle(false);
  await first;
  expect(authorityState()).toBe('failed');
  vi.mocked(harnessClient.getConfig).mockResolvedValue({ data: { nnd: { engine: 'nna' } } as never });
  const second = recoverGapAuthority(recovery, runtime.key, signal, false, () => true);
  settle(true);
  await second;
  expect(authorityState()).toBe('ready');
  expect(harnessClient.getConfig).toHaveBeenCalledExactlyOnceWith();
});

it('records an explicit gap even before native config has loaded or recovery succeeds', async () => {
  runtime.key = 'authority-engine-missing-config-gap';
  useGlobalSyncStore.getState().reset();
  const recovery = { recoverAuthorityGap: vi.fn(async () => false) } as never;
  expect(activityGapAt(runtime.key)).toBeNull();
  await recoverGapAuthority(recovery, runtime.key, new AbortController().signal, true, () => true);
  expect(activityGapAt(runtime.key)).toEqual(expect.any(Number));
  expect(authorityState(runtime.key)).toBe('failed');
});

it('keeps authority closed when an explicit gap recovers catalogs but native identity is absent', async () => {
  runtime.key = 'authority-engine-no-native-identity';
  useGlobalSyncStore.getState().reset();
  const recovery = { recoverAuthorityGap: vi.fn(async () => true) } as never;
  vi.mocked(harnessClient.getConfig).mockResolvedValue({ data: {} as never });
  await recoverGapAuthority(recovery, runtime.key, new AbortController().signal, true, () => true);
  expect(activityGapAt(runtime.key)).toEqual(expect.any(Number));
  expect(authorityState(runtime.key)).toBe('failed');
});

it('rejects malformed or changed native identity after a complete catalog recovery', async () => {
  const recovery = { recoverAuthorityGap: vi.fn(async () => true) } as never;
  vi.mocked(harnessClient.getConfig).mockResolvedValue({ data: {} as never });
  await recoverGapAuthority(recovery, runtime.key, new AbortController().signal, true, () => true);
  expect(authorityState()).toBe('failed');
});

it('does not publish a late config response into a switched runtime', async () => {
  let finish!: (value: { data: unknown }) => void;
  vi.mocked(harnessClient.getConfig).mockImplementation(() => new Promise((resolve) => { finish = resolve as typeof finish; }));
  const recovery = { recoverAuthorityGap: vi.fn(async () => true) } as never;
  const pending = recoverGapAuthority(recovery, runtime.key, new AbortController().signal, true, () => true);
  await vi.waitFor(() => expect(harnessClient.getConfig).toHaveBeenCalled());
  runtime.key = 'other';
  useGlobalSyncStore.getState().set({ config: { nnd: { engine: 'other' } } });
  finish({ data: { nnd: { engine: 'nna' } } });
  await pending;
  expect(useGlobalSyncStore.getState().config?.['nnd']).toEqual({ engine: 'other' });
});

it('does not let an older same-runtime recovery replace the newer configuration', async () => {
  const replies: Array<(value: { data: unknown }) => void> = [];
  vi.mocked(harnessClient.getConfig).mockImplementation(() => new Promise((resolve) => {
    replies.push(resolve as (value: { data: unknown }) => void);
  }));
  const recovery = { recoverAuthorityGap: vi.fn(async () => true) } as never;
  const signal = new AbortController().signal;
  const first = recoverGapAuthority(recovery, runtime.key, signal, true, () => true);
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  const second = recoverGapAuthority(recovery, runtime.key, signal, true, () => true);
  await vi.waitFor(() => expect(replies).toHaveLength(2));
  replies[1]!({ data: { nnd: { engine: 'nna' }, marker: 'newer' } });
  await second;
  expect(authorityState()).toBe('ready');
  expect(useGlobalSyncStore.getState().config?.['marker']).toBe('newer');
  replies[0]!({ data: { nnd: { engine: 'nna' }, marker: 'older' } });
  await first;
  expect(authorityState()).toBe('ready');
  expect(useGlobalSyncStore.getState().config?.['marker']).toBe('newer');
});
