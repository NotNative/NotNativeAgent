// SPDX-License-Identifier: Apache-2.0
/**
 * Tunnel controller contract (doc 08 §4.2/§4.3): exactly one live controller
 * per instance. `createTunnelController` wraps a child process with the
 * uniform `{mode, process, getPublicUrl, isAlive, stop}` surface — stop is
 * idempotent, SIGINT per provider contract, and liveness is tracked from
 * the child's own exit/error events so `status` can lazily re-sync.
 */
import type { TunnelChildLike } from './tunnel-spawn.ts';
import type { TunnelProvider, TunnelMode } from './tunnel-capabilities.ts';

export interface TunnelControllerLike {
  provider: TunnelProvider;
  mode: TunnelMode;
  /** Backend for route `providerMetadata` (managed-local config echo). */
  effectiveConfigPath: () => string | null;
  /** Backend for route `providerMetadata` + the status URL re-sync. */
  resolvedHostname: () => string | null;
  getPublicUrl: () => string;
  isAlive: () => boolean;
  stop: () => void;
  child: () => TunnelChildLike;
}

export interface CreateTunnelControllerInput {
  provider: TunnelProvider;
  mode: TunnelMode;
  child: TunnelChildLike;
  publicUrl: string;
  resolvedHostname?: string | null;
  effectiveConfigPath?: string | null;
  /** §4.3 stop contract: SIGINT (cloudflared also deletes its temp HOME). */
  onKillSignal?: string;
  onCleanup?: (() => void) | undefined;
  /** Start as a dead controller (tests stub exits). */
  exited?: boolean;
}

export function createTunnelController(input: CreateTunnelControllerInput): TunnelControllerLike {
  let alive = input.exited === true ? false : true;
  let stopped = false;
  let stoppedViaStop = false;
  const exitListeners: ((reason: string) => void)[] = [];
  const child = input.child;

  child.on('exit', (code, signal) => {
    if (alive) alive = false;
    if (stoppedViaStop) return;
    exitListeners.forEach((listener) => listener(`child exited (code ${String(code)}, signal ${String(signal)})`));
  });
  child.on('error', () => {
    if (alive) alive = false;
  });

  const controller: TunnelControllerLike = {
    provider: input.provider,
    mode: input.mode,
    child: () => child,
    effectiveConfigPath: () => input.effectiveConfigPath ?? null,
    resolvedHostname: () => input.resolvedHostname ?? null,
    getPublicUrl: () => input.publicUrl,
    isAlive: () => alive,
    stop: () => {
      if (stopped) return;
      stopped = true;
      stoppedViaStop = true;
      alive = false;
      if (!child.killed) child.kill((input.onKillSignal ?? 'SIGINT') as Parameters<TunnelChildLike['kill']>[0]);
      try {
        input.onCleanup?.();
      } catch {
        // cleanup is cosmetic; a stop must complete even if the temp dir
        // removal races a still-open child handle (review P2)
      }
    },
  };
  return controller;
}
