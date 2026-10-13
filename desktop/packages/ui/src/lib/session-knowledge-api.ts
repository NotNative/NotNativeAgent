// SPDX-License-Identifier: Apache-2.0
/** Typed HTTP boundary for server-owned session knowledge (doc 15 §B.7). */
import { runtimeFetch } from './runtime-fetch.ts';

export interface SessionKnowledgePins { notes: string[]; plans: string[] }
export interface SessionKnowledgePending {
  text: string; signature: string; unavailable?: boolean; reason?: string;
}
export interface SessionKnowledgeSummary {
  notes: { id: string; body: string }[];
  plans: { id: string; title: string }[];
  memory: { global: number; project: number };
}

export class SessionKnowledgeRequestError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Session knowledge request failed (${status}): ${detail}`);
  }
}

const PIN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SIGNATURE = /^[a-f0-9]{64}$/u;

function guarded(directory: string, sessionId?: string): { directory: string; sessionID?: string } {
  if (directory === '') throw new Error('Workspace directory is required');
  if (sessionId !== undefined && !SESSION_ID.test(sessionId)) throw new Error('Invalid session ID');
  return { directory, ...(sessionId === undefined ? {} : { sessionID: sessionId }) };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await runtimeFetch(path, init);
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || body === null) {
    throw new SessionKnowledgeRequestError(response.status,
      typeof body?.error === 'string' ? body.error : 'unavailable');
  }
  return body;
}

function withSession(directory: string, sessionId?: string): string {
  const value = queryset(directory, sessionId);
  return `/api/session-knowledge?${value}`;
}

function queryset(directory: string, sessionId?: string): string {
  const target = guarded(directory, sessionId);
  const parts = [`directory=${encodeURIComponent(target.directory)}`];
  if (target.sessionID !== undefined) parts.push(`sessionId=${encodeURIComponent(target.sessionID)}`);
  return parts.join('&');
}

function validPins(value: unknown): SessionKnowledgePins {
  const pins = (value as Partial<SessionKnowledgePins> | null) ?? null;
  if (!pins || !Array.isArray(pins.notes) || !Array.isArray(pins.plans)) {
    throw new Error('Invalid session knowledge pin response');
  }
  return {
    notes: pins.notes.filter((id, index, array) => typeof id === 'string' && PIN_ID.test(id)
      && array.indexOf(id) === index).slice(0, 50),
    plans: pins.plans.filter((id, index, array) => typeof id === 'string' && PIN_ID.test(id)
      && array.indexOf(id) === index).slice(0, 50),
  };
}

export async function getSessionKnowledge(directory: string, sessionId?: string): Promise<SessionKnowledgePending> {
  const value = await request(withSession(directory, sessionId)) as Partial<SessionKnowledgePending> | null;
  if (!value || typeof value.text !== 'string' || typeof value.signature !== 'string'
    || (value.signature !== '' && !SIGNATURE.test(value.signature))) {
    throw new Error('Invalid session knowledge response');
  }
  return {
    text: value.text,
    signature: value.signature,
    ...(value.unavailable === true ? { unavailable: true as const } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}

export async function getSessionKnowledgeSummary(directory: string, sessionId?: string): Promise<SessionKnowledgeSummary> {
  const value = await request(`/api/session-knowledge/summary?${queryset(directory, sessionId)}`) as Partial<SessionKnowledgeSummary> | null;
  if (!value || !Array.isArray(value.notes) || !Array.isArray(value.plans)
    || typeof value.memory?.global !== 'number' || typeof value.memory?.project !== 'number') {
    throw new Error('Invalid session knowledge summary response');
  }
  return {
    notes: value.notes.flatMap((entry) => typeof (entry as { id?: unknown })?.id === 'string'
      && typeof (entry as { body?: unknown })?.body === 'string'
      ? [{ id: entry.id as string, body: entry.body as string }] : []),
    plans: value.plans.flatMap((entry) => typeof (entry as { id?: unknown })?.id === 'string'
      && typeof (entry as { title?: unknown })?.title === 'string'
      ? [{ id: entry.id as string, title: entry.title as string }] : []),
    memory: { global: value.memory.global, project: value.memory.project },
  };
}

export async function pinSessionKnowledge(input: {
  sessionId: string; directory: string; kind: 'note' | 'plan'; id: string; pinned: boolean;
}): Promise<SessionKnowledgePins> {
  if (!SESSION_ID.test(input.sessionId) || input.directory === '' || !PIN_ID.test(input.id)) {
    throw new Error('Invalid session knowledge pin request');
  }
  const value = await request('/api/session-knowledge/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return validPins((value as { pins?: unknown }).pins);
}

export async function recordSessionKnowledgeDelivered(input: {
  sessionId: string; directory: string; signature: string;
}): Promise<{ recorded: boolean; reason?: string }> {
  if (!SESSION_ID.test(input.sessionId) || input.directory === '' || !SIGNATURE.test(input.signature)) {
    throw new Error('Invalid session knowledge delivery request');
  }
  const value = await request('/api/session-knowledge/delivered', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }) as { recorded?: unknown; reason?: unknown };
  if (typeof value?.recorded !== 'boolean') throw new Error('Invalid session knowledge delivery response');
  return {
    recorded: value.recorded,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}
