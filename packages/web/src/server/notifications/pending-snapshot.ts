// SPDX-License-Identifier: Apache-2.0
import { notificationSessionId } from './session-projection.ts';

export interface PendingRequests { permissions: Record<string, unknown>[]; forms: Record<string, unknown>[] }
export async function pendingSnapshot(response: Response): Promise<Map<string, PendingRequests> | null> {
  if (response.status === 404) return null; // Older NNA versions retain explicit live-event coverage.
  if (!response.ok) throw new Error('NNA pending request snapshot is unavailable');
  const value = await response.json();
  if (!record(value) || value.coverage !== 'complete' || !record(value.sessions) || Object.keys(value.sessions).length > 5000
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 2_097_152) throw new Error('NNA pending request snapshot is invalid');
  const sessions = new Map<string, PendingRequests>();
  for (const [id, row] of Object.entries(value.sessions)) {
    if (!notificationSessionId(id) || !record(row) || !record(row.capabilities)) throw new Error('NNA pending request identity is invalid');
    for (const kind of ['permissions', 'forms'] as const) {
      const items = row[kind]; const capability = row.capabilities[kind];
      if (typeof capability !== 'string' || !['unsupported', 'observe-only'].includes(capability) || !Array.isArray(items) || items.length > 128
        || capability === 'unsupported' && items.length > 0 || items.some((item) => !record(item) || !notificationSessionId(item.id))
        || new Set(items.map((item) => item.id)).size !== items.length) throw new Error('NNA pending request rows are invalid');
      if (items.some((item) => !validRequest(item, kind))) throw new Error('NNA pending request payload is invalid');
    }
    sessions.set(id, { permissions: row.permissions as Record<string, unknown>[], forms: row.forms as Record<string, unknown>[] });
  }
  return sessions;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

function validRequest(item: Record<string, unknown>, kind: 'permissions' | 'forms'): boolean {
  if (!notificationSessionId(item.toolRequestID)) return false;
  if (kind === 'permissions') return text(item.permission, 256) && Number.isSafeInteger(item.expiresAt);
  return Array.isArray(item.questions) && item.questions.length > 0 && item.questions.length <= 8 && item.questions.every((question) =>
    record(question) && text(question.question, 4096) && typeof question.header === 'string' && question.header.length <= 256
    && typeof question.multiple === 'boolean' && typeof question.custom === 'boolean'
    && Array.isArray(question.options) && question.options.length > 0 && question.options.length <= 16 && question.options.every((option) =>
      record(option) && text(option.label, 256) && typeof option.description === 'string' && option.description.length <= 4096));
}
function text(value: unknown, limit: number): boolean { return typeof value === 'string' && value.trim().length > 0 && value.length <= limit; }
