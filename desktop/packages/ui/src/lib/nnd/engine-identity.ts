// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from './types.ts';

/**
 * Why: engine identity used to be probed as ad-hoc `nnd.engine === 'nna'`
 * string literals repeated across modules; this file is the single typed
 * owner. The /config wire contract (doc 02) reports exactly these engine
 * values: 'nna' for the NNA harness and 'mock' for the bundled mock harness
 * (web/src/server/harness/mock/fixtures.ts). 'legacy' is a UI presentation
 * label for the mock surface, never a value the wire can return, so its
 * predicate stays fail-closed for any real payload.
 */
export type EngineIdentity = 'nna' | 'mock' | 'legacy';

/** The retired OpenCode-era harness value; the /config wire never returns it. */
export type LegacyEngineIdentity = 'legacy';

function engineValueOf(config: HarnessConfig | null | undefined): unknown {
  const nnd = config?.nnd;
  return !!nnd && typeof nnd === 'object' && !Array.isArray(nnd)
    ? (nnd as Record<string, unknown>).engine
    : undefined;
}

/** Returns the known identity of the /config payload, or null when absent, malformed, or unrecognized (fail-closed). */
export function engineIdentityOf(config: HarnessConfig | null | undefined): EngineIdentity | null {
  const engine = engineValueOf(config);
  return engine === 'nna' || engine === 'mock' || engine === 'legacy' ? engine : null;
}

/** True only for the NNA engine; any unknown or missing identity fails closed. */
export function isNnaEngine(config: HarnessConfig | null | undefined): boolean {
  return engineValueOf(config) === 'nna';
}

/** True only for the explicitly retired 'legacy' value, which real NNA /config payloads never carry. */
export function isLegacyEngine(config: HarnessConfig | null | undefined): boolean {
  return engineValueOf(config) === 'legacy';
}
