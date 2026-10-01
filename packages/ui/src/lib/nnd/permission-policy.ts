// SPDX-License-Identifier: Apache-2.0
import type { HarnessConfig } from './types.ts';

/** NNA wire sessions use the mandatory reviewer, without interactive decisions. */
export function nnaOwnsPermissionReview(config: HarnessConfig | null | undefined): boolean {
  return (config?.nnd as { engine?: unknown } | undefined)?.engine === 'nna';
}
