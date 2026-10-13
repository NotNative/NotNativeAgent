// SPDX-License-Identifier: Apache-2.0
/** Bounded session metadata contract for project-context knowledge. */
import { createHash } from 'node:crypto';

export interface ProjectContextPins { notes: string[]; plans: string[] }

export const PIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,399}$/u;
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
export const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/u;
export const PROJECT_CONTEXT_PINS_KEY = 'project_context_pins';
export const KNOWLEDGE_SIGNATURE_KEY = 'knowledge_context_delivered';

export function normalizeRequestDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replaceAll('\\', '/').replace(/^([a-z]):/u,
    (_match, drive: string) => `${drive.toUpperCase()}:`).replace(/\/+$/u, '');
  return normalized === '' ? undefined : normalized;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function boundedIDs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !PIN_ID_PATTERN.test(item)) continue;
    ids.add(item);
    if (ids.size >= 50) break;
  }
  return [...ids];
}

export function parseProjectContextPins(metadata: unknown): ProjectContextPins {
  const root = record(metadata)?.openchamber;
  const pins = record(root)?.[PROJECT_CONTEXT_PINS_KEY];
  return { notes: boundedIDs(record(pins)?.notes), plans: boundedIDs(record(pins)?.plans) };
}

export function parseKnowledgeSignature(metadata: unknown): string {
  const root = record(metadata)?.openchamber;
  const value = record(root)?.[KNOWLEDGE_SIGNATURE_KEY];
  return typeof value === 'string' && SIGNATURE_PATTERN.test(value) ? value : '';
}

export function mergeProjectContextPins(current: unknown, pins: ProjectContextPins,
  signature: string): Record<string, unknown> {
  const base = { ...(current ?? {}) };
  root(base)[PROJECT_CONTEXT_PINS_KEY] = {
    notes: [...pins.notes],
    plans: [...pins.plans],
  };
  root(base)[KNOWLEDGE_SIGNATURE_KEY] = signature;
  return base;
}

export function clearKnowledgeSignature(current: unknown,
  pins: ProjectContextPins): Record<string, unknown> {
  return mergeProjectContextPins(current, pins, '');
}

function root(base: Record<string, unknown>): Record<string, unknown> {
  const before = record(base.openchamber) ?? {};
  base.openchamber = { ...before };
  return base.openchamber as Record<string, unknown>;
}

export function signatureOf(parts: string[]): string {
  if (parts.length === 0) return '';
  return createHash('sha256').update(parts.slice().sort().join('|')).digest('hex');
}

export function sessionID(value: unknown): string | undefined {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : undefined;
}

export function signature(value: unknown): string | undefined {
  return typeof value === 'string' && SIGNATURE_PATTERN.test(value) ? value : undefined;
}
