// SPDX-License-Identifier: Apache-2.0
/** H.2 session-assist metadata contract; safe parsing and merge writes only. */

export const ASSIST_METADATA_KEY = 'assist';
export const ASSIST_RECAP_CHAR_LIMIT = 320;
export const ASSIST_SUGGESTION_CHAR_LIMIT = 500;

export interface AssistPayload {
  recap: string;
  suggestion: string;
  forMessageID: string;
  generatedAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function parseIdentity(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.slice(0, 200).trim();
  return Number.isInteger(Number(trimmed)) ? '' : trimmed;
}

/** No backfill nor stale rendering: identity and at least one useful field. */
export function parseSessionAssist(metadata: unknown): AssistPayload | null {
  const shape = record(record(record(metadata)?.openchamber)?.assist);
  const forMessageID = parseIdentity(shape?.forMessageID);
  const recap = boundedText(shape?.recap, ASSIST_RECAP_CHAR_LIMIT).trim();
  const suggestion = boundedText(shape?.suggestion, ASSIST_SUGGESTION_CHAR_LIMIT).trim();
  const generatedAt = typeof shape?.generatedAt === 'number' && Number.isSafeInteger(shape.generatedAt)
    ? shape.generatedAt : 0;
  if (forMessageID === '' || generatedAt <= 0 || (recap === '' && suggestion === '')) return null;
  return { recap, suggestion, forMessageID, generatedAt };
}

/** Preserve every unrelated metadata key and use the documented openchamber key. */
export function mergeAssistIntoMetadata(
  metadata: Record<string, unknown> | undefined,
  next: AssistPayload,
): Record<string, unknown> {
  const metadataShape = record(metadata);
  const base = { ...(metadataShape ?? {}) };
  const namespace = record(base.openchamber) ?? {};
  base.openchamber = { ...namespace, assist: next };
  return base;
}
