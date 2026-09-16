// SPDX-License-Identifier: Apache-2.0
/**
 * Input history (doc 05 §H.4): global + (runtime, directory, session) buckets,
 * ArrowUp/Down recall with overlays that never rewrite stored history.
 */
import { getRuntimeKey } from '../lib/runtime-switch.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import type { DraftAttachment } from './drafts.ts';

const HISTORY_KEY = 'nnd.input-history.v1';
const DEFAULT_LIMIT = 40;

export interface HistoryEntry {
  text: string;
  attachments: DraftAttachment[];
  at: number;
}

interface HistoryEnvelope {
  version: 1;
  global: HistoryEntry[];
  scoped: Record<string, HistoryEntry[]>;
}

let cache: HistoryEnvelope | null = null;

function load(): HistoryEnvelope {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '') as HistoryEnvelope;
    cache = parsed?.version === 1 ? parsed : { version: 1, global: [], scoped: {} };
  } catch {
    cache = { version: 1, global: [], scoped: {} };
  }
  return cache;
}

export function scopedKey(directory: string, sessionID: string | null): string {
  return `${getRuntimeKey()}\n${normalizeDirectory(directory)}\n${sessionID ?? 'draft'}`;
}

export function recordSend(input: { directory: string; sessionID: string | null; text: string; attachments: DraftAttachment[]; scope: 'session' | 'global'; attachmentTarget: 'global' | 'scoped'; limit?: number }): void {
  const envelope = load();
  const entry: HistoryEntry = { text: input.text, attachments: input.attachments, at: Date.now() };
  if (input.scope === 'global') {
    envelope.global = pushBounded(envelope.global, input.attachments.length > 0 ? entry : { ...entry, attachments: [] }, input.limit);
  } else {
    const key = scopedKey(input.directory, input.sessionID);
    envelope.scoped[key] = pushBounded(envelope.scoped[key] ?? [], entry, input.limit);
  }
  persist();
}

function pushBounded(list: HistoryEntry[], entry: HistoryEntry, limit = DEFAULT_LIMIT): HistoryEntry[] {
  const deduped = list.filter((existing) => existing.text !== entry.text);
  return [...deduped, entry].slice(-limit);
}

/** Recall for the CURRENT bucket covering the visible transcript merge rule. */
export function recallList(input: { directory: string; sessionID: string | null; scope: 'session' | 'global'; visibleUserPrompts?: string[] }): HistoryEntry[] {
  const envelope = load();
  if (input.scope === 'global') return [...envelope.global].reverse();
  const stored = [...(envelope.scoped[scopedKey(input.directory, input.sessionID)] ?? [])];
  const merged = mergeVisible(stored, input.visibleUserPrompts ?? []);
  return merged.reverse();

  function mergeVisible(storedEntries: HistoryEntry[], visible: string[]): HistoryEntry[] {
    const storedTexts = new Set(storedEntries.map((entry) => entry.text));
    const out = [...storedEntries];
    for (const text of visible) {
      if (storedTexts.has(text)) continue;
      out.push({ text, attachments: [], at: 0 });
      storedTexts.add(text);
    }
    return out; // oldest first per §H.4
  }
}

/** Recall walks a NEWEST-FIRST list: ArrowUp (older) moves deeper, ArrowDown
 * (newer) climbs back; past either end it returns to the live draft (§H.4). */
export function recallDirectionResult(list: HistoryEntry[], position: number, direction: 'older' | 'newer'): { entry: HistoryEntry | null; next: number; atStart: boolean } {
  if (list.length === 0) return { entry: null, next: -1, atStart: false };
  if (direction === 'newer') {
    if (position <= 0) return { entry: null, next: -1, atStart: true }; // back to the live draft
    const next = position - 1;
    return { entry: list[next]!, next, atStart: false };
  }
  // older: fresh recall starts at the NEWEST entry
  const next = position < 0 ? 0 : Math.min(list.length - 1, position + 1);
  const entry = list[next]!;
  return { entry, next, atStart: next === list.length - 1 };
}

export function persist(): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(load()));
  } catch {
    /* best-effort */
  }
}

export function resetForRuntimeSwitch(): void {
  cache = null;
}
