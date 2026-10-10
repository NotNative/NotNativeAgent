// SPDX-License-Identifier: Apache-2.0
/** Durable context pins live in the NND-owned session-org store; the
 * generic session-metadata namespace remains the legacy read fallback. */
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useSessionOrgStore } from '../stores/useSessionOrgStore.ts';
import type { Message } from '../lib/nnd/types.ts';
import type { DirectoryStore } from '../sync/types.ts';
import type { StoreApi } from 'zustand/vanilla';

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

/** Org-record pins win; legacy metadata pins fill in until the session has
 * written the store. */
export function messagePinnedState(session: { metadata?: Record<string, unknown> } | undefined,
  orgRecord: { messagePins?: { id: string; createdAt: number; role: string }[] } | undefined): Set<string> {
  const source = orgRecord?.messagePins ?? parseSessionMessagePins(session?.metadata);
  return new Set(source.map((pin) => pin.id));
}

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

/** The pins commit to the NND-owned session-org store (`pins.setMessages`);
 * `metadata` is only the legacy fallback source for sessions created before
 * the store existed. The store write-through updates subscribers. */
export async function setSessionMessagePinned(input: {
  sessionID: string;
  directory: string;
  message: PinTargetMessage;
  pinned: boolean;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  return queuePinWrite(`${input.sessionID}\0${normalizeDirectory(input.directory)}`, async () => {
    if (typeof input.sessionID !== 'string' || input.sessionID === '') throw new Error('Invalid session for the context pin');
    if (typeof input.directory !== 'string' || input.directory === '') throw new Error('Invalid directory for the context pin');
    if (typeof input.message.id !== 'string' || input.message.id === '' || !(input.message.role === 'user' || input.message.role === 'assistant')
      || !Number.isFinite(messagePinTime(input.message))) {
      throw new Error('Invalid message for the context pin');
    }
    const store = useSessionOrgStore.getState();
    const key = normalizeDirectory(input.directory);
    if (store.loadedDirectories[key] !== true) await store.load(key);
    const record = store.recordsByDirectory[key]?.[input.sessionID];
    const currentPins = record?.messagePins
      ?? parseSessionMessagePins(input.metadata).map((pin) => ({ ...pin, role: pin.role as string }));
    const next = currentPins.filter((pin) => pin.id !== input.message.id);
    if (input.pinned) {
      next.push({ id: input.message.id, createdAt: messagePinTime(input.message), role: input.message.role });
    }
    await store.applyOp(input.directory, input.sessionID, 'pins.setMessages',
      { pins: next.slice(-SESSION_PIN_LIMIT) });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
