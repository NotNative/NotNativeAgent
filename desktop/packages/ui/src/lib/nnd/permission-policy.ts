// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from './types.ts';

/** NNA wire sessions use the mandatory reviewer, without interactive decisions. */
export function nnaOwnsPermissionReview(config: HarnessConfig | null | undefined): boolean {
  return (config?.nnd as { engine?: unknown } | undefined)?.engine === 'nna';
}

export type PermissionReply = 'once' | 'always' | 'reject';

/**
 * W-32.no-auto-accept: remembered approvals are PROHIBITED. Every permission
 * decision is an explicit operator decision for THIS occurrence ("once") or
 * an explicit rejection — the transport boundary refuses "always" no matter
 * which caller tries it, so no code path can silently auto-accept.
 */
export function assertPermissionReply(reply: PermissionReply): void {
  if (reply === 'always') throw new Error('Remembered permission approvals are not supported');
}
