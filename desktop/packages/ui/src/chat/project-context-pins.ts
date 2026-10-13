// SPDX-License-Identifier: Apache-2.0
/** Bounded draft-box project-context pins (doc 15 §B.1/§B.6). */

export interface ProjectContextPinTargets {
  notes: string[];
  plans: string[];
}

export const PROJECT_CONTEXT_PIN_LIMIT = 50;

export function parseProjectContextPins(value: unknown): ProjectContextPinTargets {
  const bag = validBag(value);
  return {
    notes: boundedIDs(bag.notes),
    plans: boundedIDs(bag.plans),
  };
}

export function mergeProjectContextPin(
  targets: ProjectContextPinTargets, kind: 'note' | 'plan', id: string, pinned: boolean,
): ProjectContextPinTargets {
  const key = kind === 'note' ? 'notes' : 'plans';
  return { ...targets, [key]: replaceID(targets[key], id, pinned).slice(-PROJECT_CONTEXT_PIN_LIMIT) };
}

/** Carry only intended keys into a fresh metadata object; omit empty pin sets. */
export function metadataWithProjectContextPins(
  metadata: Record<string, unknown> | undefined, pins: ProjectContextPinTargets,
): Record<string, unknown> | null {
  const normalized = parseProjectContextPins({
    project_context_pins: { notes: pins.notes, plans: pins.plans } });
  if (normalized.notes.length === 0 && normalized.plans.length === 0) return null;
  const namespace = isRecord(metadata?.[PROJECT_PINS_NAMESPACE])
    ? { ...metadata?.[PROJECT_PINS_NAMESPACE] as Record<string, unknown> } : {};
  namespace[PROJECT_PINS_MESSAGES_KEY] = normalized;
  return { ...(metadata ?? {}), [PROJECT_PINS_NAMESPACE]: namespace };
}

const PROJECT_PINS_NAMESPACE = 'openchamber';
const PROJECT_PINS_MESSAGES_KEY = 'project_context_pins';

function validBag(value: unknown): { notes: unknown; plans: unknown } {
  if (!isRecord(value) || !isRecord(value.project_context_pins)) return { notes: [], plans: [] };
  return value.project_context_pins as { notes: unknown; plans: unknown };
}

function boundedIDs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > 400) continue;
    ids.add(item);
    if (ids.size >= PROJECT_CONTEXT_PIN_LIMIT) break;
  }
  return [...ids];
}

function replaceID(value: string[], id: string, pinned: boolean): string[] {
  const kept = value.filter((existing) => existing !== id);
  return pinned ? [...kept, id] : kept;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
