// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from './types.ts';
import { isNnaEngine } from './engine-identity.ts';

/** NNA wire sessions use the mandatory reviewer, without interactive decisions. */
export function nnaOwnsPermissionReview(config: HarnessConfig | null | undefined): boolean {
  return isNnaEngine(config);
}

export type PermissionReply = 'once' | 'always' | 'reject';

/**
 * W-32.no-auto-accept: remembered permission choices are PROHIBITED. Every
 * permission decision is an explicit operator decision for THIS occurrence
 * ("once") or an explicit rejection — the transport boundary refuses "always"
 * no matter which caller tries it, so no code path can silently auto-accept.
 * Why "choices", not "approvals" (CTL-TERM-008): the reviewer's decision is
 * the only approval; a user blocking preference is a remembered choice.
 */
export function assertPermissionReply(reply: PermissionReply): void {
  if (reply === 'always') throw new Error('Remembered permission choices are not supported');
}
