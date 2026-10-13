// SPDX-License-Identifier: Apache-2.0
/** H.2 readonly assist contract. The server owns writes and clamps; readers fail closed. */

export const ASSIST_RECAP_CHAR_LIMIT = 320;
export const ASSIST_SUGGESTION_CHAR_LIMIT = 500;
export const ASSIST_TIMESTAMP_AGE_MS = 150 * 24 * 60 * 60 * 1000;

export interface SessionAssistView {
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
  return typeof value === 'string' && !/^(?:0|-?\d+)$/u.test(value)
    ? value.slice(0, limit) : '';
}

export function parseSessionAssistView(metadata: unknown): SessionAssistView | null {
  const shape = record(record(record(metadata)?.openchamber)?.assist);
  const forMessageID = boundedText(shape?.forMessageID, 200).trim();
  const recap = boundedText(shape?.recap, ASSIST_RECAP_CHAR_LIMIT).trim();
  const suggestion = boundedText(shape?.suggestion, ASSIST_SUGGESTION_CHAR_LIMIT).trim();
  const generatedAt = typeof shape?.generatedAt === 'number'
    && Number.isSafeInteger(shape.generatedAt) && shape.generatedAt > 0
    && Date.now() - shape.generatedAt <= ASSIST_TIMESTAMP_AGE_MS
    && shape.generatedAt - Date.now() <= ASSIST_TIMESTAMP_AGE_MS
    ? shape.generatedAt : 0;
  if (forMessageID === '' || generatedAt === 0 || (recap === '' && suggestion === '')) return null;
  return { recap, suggestion, forMessageID, generatedAt };
}
