// SPDX-License-Identifier: Apache-2.0
/** Durable context pins ride the generic session-metadata PATCH channel. */
import { harnessClient, normalizeDirectory, type HarnessSession } from '../lib/nnd/client.ts';
import type { Message } from '../lib/nnd/types.ts';

export const SESSION_PIN_NAMESPACE = 'openchamber';
export const SESSION_PIN_MESSAGES_KEY = 'context_obligatory_messages';
export const SESSION_PIN_LIMIT = 64;
const PIN_ROLES = new Set(['user', 'assistant']);

export interface SessionMessagePin {
  id: string;
  createdAt: number;
  role: 'user' | 'assistant';
}

export interface PinTargetMessage {
  id: string;
  role: Message['role'];
  time: { created: number; completed?: number };
}

export function parseSessionMessagePins(metadata: unknown): SessionMessagePin[] {
  const bag = isRecord(metadata) && isRecord(metadata[SESSION_PIN_NAMESPACE])
    ? metadata[SESSION_PIN_NAMESPACE] : {};
  const values = bag[SESSION_PIN_MESSAGES_KEY];
  if (!Array.isArray(values)) return [];
  const byId = new Map<string, SessionMessagePin>();
  for (const value of values) {
    if (!isRecord(value)) continue;
    if (typeof value.id !== 'string' || value.id === '') continue;
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) continue;
    if (typeof value.role !== 'string' || !PIN_ROLES.has(value.role)) continue;
    byId.set(value.id, { id: value.id, createdAt: value.createdAt,
      role: value.role as SessionMessagePin['role'] });
    if (byId.size >= SESSION_PIN_LIMIT) break;
  }
  return [...byId.values()];
}

export function messagePinTime(message: PinTargetMessage): number {
  return message.role === 'user' ? message.time.created
    : message.time.completed ?? message.time.created;
}

export function mergeSessionMessagePin(
  metadata: Record<string, unknown>, message: PinTargetMessage, pinned: boolean,
): Record<string, unknown> {
  const namespace = isRecord(metadata[SESSION_PIN_NAMESPACE])
    ? { ...metadata[SESSION_PIN_NAMESPACE] as Record<string, unknown> } : {};
  const next = parseSessionMessagePins(metadata).filter((pin) => pin.id !== message.id);
  if (pinned) next.push({ id: message.id, createdAt: messagePinTime(message), role: message.role });
  namespace[SESSION_PIN_MESSAGES_KEY] = next.slice(-SESSION_PIN_LIMIT);
  return { ...metadata, [SESSION_PIN_NAMESPACE]: namespace };
}

export function sessionMessagePinIDs(session: { metadata?: Record<string, unknown> } | undefined): Set<string> {
  return new Set(parseSessionMessagePins(session?.metadata).map((pin) => pin.id));
}

export type SessionPinClient = typeof harnessClient;

const pinWriteQueues = new Map<string, Promise<unknown>>();

function queuePinWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = pinWriteQueues.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  pinWriteQueues.set(key, next);
  next.catch(() => undefined).finally(() => {
    if (pinWriteQueues.get(key) === next) pinWriteQueues.delete(key);
  });
  return next;
}

/** Session PATCH is authoritative: GET fresh, merge the pin, then commit. */
export async function setSessionMessagePinned(input: {
  sessionID: string;
  directory: string;
  message: PinTargetMessage;
  pinned: boolean;
  client?: typeof harnessClient;
}): Promise<HarnessSession | undefined> {
  return queuePinWrite(`${input.sessionID}\0${normalizeDirectory(input.directory)}`, async () => {
    const client = input.client ?? harnessClient;
    if (typeof input.sessionID !== 'string' || input.sessionID === '') throw new Error('Invalid session for the context pin');
    if (typeof input.directory !== 'string' || input.directory === '') throw new Error('Invalid directory for the context pin');
    if (typeof input.message.id !== 'string' || input.message.id === '' || !(input.message.role === 'user' || input.message.role === 'assistant')
      || !Number.isFinite(messagePinTime(input.message))) {
      throw new Error('Invalid message for the context pin');
    }
    const current = await client.getSession(input.sessionID, { directory: input.directory });
    if (!current.data) throw new Error(current.error ?? 'Could not read the session');
    if (current.data.id !== input.sessionID || normalizeDirectory(current.data.directory) !== normalizeDirectory(input.directory)) {
      throw new Error('Could not read the target session');
    }
    const metadata = mergeSessionMessagePin(current.data.metadata ?? {}, input.message, input.pinned);
    const committed = await client.updateSession(input.sessionID, { metadata }, { directory: input.directory });
    if (!committed.data) throw new Error(committed.error ?? 'Could not update the context pin');
    if (committed.data.id !== input.sessionID || normalizeDirectory(committed.data.directory) !== normalizeDirectory(input.directory)) {
      throw new Error('Could not update the context pin');
    }
    return committed.data;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
