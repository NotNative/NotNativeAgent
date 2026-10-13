// SPDX-License-Identifier: Apache-2.0
/** Volatile, runtime-scoped authority freshness after an explicit native replay gap. */
import { getRuntimeKey, onRuntimeEndpointChanged } from '../lib/runtime-switch.ts';

export type AuthorityState = 'ready' | 'recovering' | 'failed';
const states = new Map<string, AuthorityState>();
const listeners = new Set<() => void>();
let revision = 0;

export function authorityState(runtime = getRuntimeKey()): AuthorityState {
  return states.get(runtime) ?? 'ready';
}

export function beginAuthorityRecovery(runtime = getRuntimeKey()): number {
  const token = ++revision;
  states.set(runtime, 'recovering');
  publish();
  return token;
}

export function isCurrentAuthorityRecovery(runtime: string, token: number): boolean {
  return token === revision && getRuntimeKey() === runtime && states.get(runtime) === 'recovering';
}

export function finishAuthorityRecovery(runtime: string, token: number, healthy: boolean): void {
  if (!isCurrentAuthorityRecovery(runtime, token)) return;
  states.set(runtime, healthy ? 'ready' : 'failed');
  publish();
}

export function assertFreshAuthority(): void {
  if (authorityState() !== 'ready') throw new Error('Native authority is resynchronizing; retry after recovery');
}

export function subscribeAuthority(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(): void { for (const listener of listeners) listener(); }
onRuntimeEndpointChanged(publish);
