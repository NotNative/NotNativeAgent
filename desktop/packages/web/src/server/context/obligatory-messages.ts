// SPDX-License-Identifier: Apache-2.0
/** Obligatory-context metadata helpers (doc 15 §G.1/§G.2). */

export interface ObligatoryMessage {
  id: string;
  createdAt: number;
  role: 'user' | 'assistant';
}

export const OBLIGATORY_NAMESPACE = 'openchamber';
export const OBLIGATORY_MESSAGES_KEY = 'context_obligatory_messages';
export const OBLIGATORY_CURSOR_KEY = 'context_obligatory_last_compaction_message_id';
export const OBLIGATORY_KNOWLEDGE_KEY = 'knowledge_context_delivered';
export const OBLIGATORY_MESSAGE_LIMIT = 64;

const ROLES = new Set(['user', 'assistant']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseObligatoryMessages(metadata: unknown): ObligatoryMessage[] {
  const root = isRecord(metadata) ? metadata : {};
  const namespace = isRecord(root[OBLIGATORY_NAMESPACE]) ? root[OBLIGATORY_NAMESPACE] : {};
  const raw = namespace[OBLIGATORY_MESSAGES_KEY];
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, ObligatoryMessage>();
  for (const value of raw) {
    if (!isRecord(value)) continue;
    if (typeof value.id !== 'string' || value.id === '') continue;
    const createdAt = value.createdAt;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;
    if (typeof value.role !== 'string' || !ROLES.has(value.role)) continue;
    byId.set(value.id, {
      id: value.id,
      createdAt,
      role: value.role as ObligatoryMessage['role'],
    });
    if (byId.size >= OBLIGATORY_MESSAGE_LIMIT) break;
  }
  return [...byId.values()];
}

function namespaced(metadata: Record<string, unknown>): Record<string, unknown> {
  return { ...(isRecord(metadata[OBLIGATORY_NAMESPACE]) ? metadata[OBLIGATORY_NAMESPACE] : {}) };
}

export function mergeObligatoryMessages(
  metadata: Record<string, unknown>, message: ObligatoryMessage, pinned: boolean,
): Record<string, unknown> {
  const namespace = namespaced(metadata);
  const existing = parseObligatoryMessages({ [OBLIGATORY_NAMESPACE]: namespace });
  const next = (pinned
    ? [...existing.filter((item) => item.id !== message.id), message]
    : existing.filter((item) => item.id !== message.id))
    .slice(-OBLIGATORY_MESSAGE_LIMIT);
  namespace[OBLIGATORY_MESSAGES_KEY] = next;
  const output: Record<string, unknown> = { ...metadata, [OBLIGATORY_NAMESPACE]: namespace };
  if (next.length === 0) delete (output[OBLIGATORY_NAMESPACE] as Record<string, unknown>)[OBLIGATORY_MESSAGES_KEY];
  return output;
}

export function readObligatoryCursor(metadata: unknown): string | null {
  const namespace = isRecord(metadata)
    && isRecord(metadata[OBLIGATORY_NAMESPACE]) ? metadata[OBLIGATORY_NAMESPACE] : {};
  const value = namespace[OBLIGATORY_CURSOR_KEY];
  return typeof value === 'string' && value !== '' ? value : null;
}

export function mergeObligatoryCursor(
  metadata: Record<string, unknown>, messageId: string, knowledgeSignature: string | null,
): Record<string, unknown> {
  const namespace = namespaced(metadata);
  namespace[OBLIGATORY_CURSOR_KEY] = messageId;
  if (knowledgeSignature === null) delete namespace[OBLIGATORY_KNOWLEDGE_KEY];
  else namespace[OBLIGATORY_KNOWLEDGE_KEY] = knowledgeSignature;
  return { ...metadata, [OBLIGATORY_NAMESPACE]: namespace };
}
