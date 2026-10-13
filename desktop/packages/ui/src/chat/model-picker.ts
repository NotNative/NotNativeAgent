// SPDX-License-Identifier: Apache-2.0
/**
 * Model/agent picker gate logic + curve tests (doc 05 §B.2/Harness Port 1):
 * the picker is rendered inline in the composer; this module holds the pure
 * pieces (layer building is in model-catalog.ts) and the draft starter insert
 * rule (§H.5). Behavior-only tests live in __tests__.
 */
export function isModelRowCurrent(current: { providerID: string; modelID: string; variant?: string } | null, entry: { providerID: string; modelID: string } | null): boolean {
  if (!current || !entry) return false;
  return current.providerID === entry.providerID && current.modelID === entry.modelID;
}

/** Effort label (§B.2): muted "Default" when unset; else the variant name. */
export function effortLabel(variant: string | null): string {
  return variant ?? 'Default';
}
