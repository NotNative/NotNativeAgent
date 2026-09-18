// SPDX-License-Identifier: Apache-2.0
/**
 * Relay host service contracts (typed seam shared with routes/tests): the
 * managed host is the narrow surface the lifecycle drives (§3.12), so
 * tests can inject a fake host worker without sockets.
 */
import type { RelayHostStatus } from './host-broker.ts';

export interface ManagedHost {
  start(input: { relayUrl: string; platform?: string; appVersion?: string }): Promise<void>;
  stop(): void;
  getStatus(): RelayHostStatus;
}

export interface RelayHostServiceTiming {
  /** §3.12 claim watcher cadence (default 30 s). */
  claimWatcherMs: number;
  /** §3.12 demand poll cadence (default 60 s). */
  demandPollMs: number;
  /** §3.12 CLAIM_TAKEOVER_GRACE_MS (default 120 s): a standby instance
   * takes a freed claim only after the grace; a fresh boot reclaims
   * instantly via tryClaim (no wait). */
  claimTakeoverGraceMs: number;
}
