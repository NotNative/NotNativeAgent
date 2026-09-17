// SPDX-License-Identifier: Apache-2.0
/**
 * Inline comment drafts (doc 06 10.1): key = JSON[runtimeKey,
 * normalizedDirectory, sessionKey]; limits 50 sessions / 20 drafts per
 * session / 1 MiB serialized envelope with byte-indexed LRU eviction
 * (touchedAt ordered; a lone oversize session sheds its oldest drafts so the
 * envelope bound TRULY holds); hydration validates per entry and TRIMS to
 * fit instead of wiping (zod = PA dependency; shape-validated here until the
 * dependency is registered); consume/restore power the composer-send path
 * (restore preserves id/createdAt — pin-an-id rides addDraft); storage local,
 * persists across reloads, runtime-scoped.
 */
import { create } from 'zustand';
import { getRuntimeKey } from '../runtime-switch.ts';

export type DraftSource = 'diff' | 'plan' | 'file' | 'preview-annotation' | 'terminal' | 'pr-comment' | 'pr-check' | 'chat-quote' | 'file-quote';

export interface CommentDraft {
  id: string;
  sessionKey: string;
  source: DraftSource;
  fileLabel: string;
  startLine: number;
  endLine: number;
  side?: 'original' | 'modified';
  code: string;
  language: string;
  text: string;
  createdAt: string;
}

export type DraftInput = Omit<CommentDraft, 'id' | 'createdAt' | 'sessionKey'>;

const MAX_SESSIONS = 50;
const MAX_DRAFTS_PER_SESSION = 20;
const MAX_ENVELOPE_BYTES = 1_048_576;
const STORAGE_KEY = 'notnative.inlineComments.v3';
const encoder = new TextEncoder();
const SOURCES = new Set<DraftSource>([
  'diff', 'plan', 'file', 'preview-annotation', 'terminal', 'pr-comment', 'pr-check', 'chat-quote', 'file-quote',
]);

export interface SessionSlot { drafts: CommentDraft[]; touchedAt: number }

/** The slot a surface reads (contract identical to the store actions). */
export function draftKeyFor(directory: string, sessionKey: string): string {
  return draftKey(getRuntimeKey(), directory, sessionKey);
}

export function normalizedDirectory(directory: string): string {
  return directory.replaceAll('\\', '/');
}

function draftKey(runtimeKey: string, directory: string, sessionKey: string): string {
  return JSON.stringify([runtimeKey, normalizedDirectory(directory), sessionKey]);
}

function makeId(): string {
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function isDraft(value: unknown): value is CommentDraft {
  if (typeof value !== 'object' || value === null) return false;
  const draft = value as Record<string, unknown>;
  return typeof draft.id === 'string'
    && typeof draft.sessionKey === 'string'
    && typeof draft.fileLabel === 'string'
    && typeof draft.code === 'string'
    && typeof draft.language === 'string'
    && typeof draft.text === 'string'
    && typeof draft.createdAt === 'string'
    && typeof draft.startLine === 'number'
    && typeof draft.endLine === 'number'
    && typeof draft.source === 'string' && SOURCES.has(draft.source as DraftSource)
    && (draft.side === undefined || draft.side === 'original' || draft.side === 'modified');
}

function isSlot(value: unknown): value is SessionSlot {
  if (typeof value !== 'object' || value === null) return false;
  const slot = value as Record<string, unknown>;
  if (typeof slot.touchedAt !== 'number' || !Array.isArray(slot.drafts)) return false;
  return slot.drafts.every(isDraft);
}

function validateEnvelope(parsed: unknown): [string, SessionSlot][] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter((entry): entry is [string, SessionSlot] => isSlot(entry[1]));
}

/** Byte-indexed LRU (touchedAt ordered): cap sessions at 50, shed oldest
 * sessions while over 1 MiB, and trim a LONE oversize session oldest-first —
 * the envelope bound provably holds (empty envelope cannot exceed it). */
export function compactEnvelope(entries: [string, SessionSlot][]): Record<string, SessionSlot> {
  let ordered = [...entries].sort((a, b) => b[1].touchedAt - a[1].touchedAt).slice(0, MAX_SESSIONS);
  let size = byteLength(Object.fromEntries(ordered));
  while (size > MAX_ENVELOPE_BYTES && ordered.length > 0) {
    if (ordered.length > 1) ordered = ordered.slice(0, -1);
    else {
      const [key, slot] = ordered[0]!;
      const drafts = slot.drafts.slice(1); // oldest first
      ordered = drafts.length === 0 ? [] : [[key, { ...slot, drafts }]];
    }
    size = byteLength(Object.fromEntries(ordered));
  }
  return Object.fromEntries(ordered);
}

function hydrateEnvelope(): Record<string, SessionSlot> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    return compactEnvelope(validateEnvelope(JSON.parse(raw)));
  } catch {
    return {};
  }
}

function saveEnvelope(entries: [string, SessionSlot][]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(compactEnvelope(entries)));
  } catch { /* private mode: drafts stay session-only */ }
}

interface DraftsState {
  store: Record<string, SessionSlot>;
  addDraft: (directory: string, sessionKey: string, draft: DraftInput, options?: { pinnedId?: string; createdAt?: string }) => string | null;
  updateDraft: (directory: string, sessionKey: string, id: string, text: string) => void;
  removeDraft: (directory: string, sessionKey: string, id: string) => void;
  clearSessionDrafts: (directory: string, sessionKey: string) => void;
  getDraftCount: (directory: string, sessionKey: string) => number;
}

type StoreApplier = (next: (state: DraftsState) => Partial<DraftsState>) => void;

function persistSlot(set: StoreApplier, key: string, merged: SessionSlot): void {
  set((state) => {
    const store = { ...state.store, [key]: merged };
    saveEnvelope(Object.entries(store));
    return { store };
  });
}

export const useInlineCommentDrafts = create<DraftsState>((set, getState) => ({
  store: hydrateEnvelope(),
  addDraft: (directory, sessionKey, draft, options) => {
    const runtimeKey = getRuntimeKey();
    const key = draftKey(runtimeKey, directory, sessionKey);
    const session = getState().store[key] ?? { drafts: [], touchedAt: 0 };
    const record: CommentDraft = {
      ...draft,
      sessionKey,
      id: options?.pinnedId ?? makeId(),
      createdAt: options?.createdAt ?? new Date().toISOString(),
    };
    const merged = { ...session, drafts: [...session.drafts, record].slice(-MAX_DRAFTS_PER_SESSION), touchedAt: Date.now() };
    persistSlot(set, key, merged);
    return record.id;
  },
  updateDraft: (directory, sessionKey, id, text) => {
    const key = draftKey(getRuntimeKey(), directory, sessionKey);
    const session = getState().store[key];
    if (session === undefined) return;
    const merged = { ...session, drafts: session.drafts.map((draft) => (draft.id === id ? { ...draft, text } : draft)), touchedAt: Date.now() };
    persistSlot(set, key, merged);
  },
  removeDraft: (directory, sessionKey, id) => {
    const key = draftKey(getRuntimeKey(), directory, sessionKey);
    const session = getState().store[key];
    if (session === undefined) return;
    const merged = { ...session, drafts: session.drafts.filter((draft) => draft.id !== id), touchedAt: Date.now() };
    persistSlot(set, key, merged);
  },
  clearSessionDrafts: (directory, sessionKey) => {
    const key = draftKey(getRuntimeKey(), directory, sessionKey);
    set((state) => {
      const store = { ...state.store };
      delete store[key];
      saveEnvelope(Object.entries(store));
      return { store };
    });
  },
  getDraftCount: (directory, sessionKey) => getState().store[draftKey(getRuntimeKey(), directory, sessionKey)]?.drafts.length ?? 0,
}));

/** 10.1 consume: read drafts for the session directory + LIVE session key
 * (from the sync stores), clear the slot, return the list for the send. */
export function consumeDrafts(directory: string, sessionKey: string): CommentDraft[] {
  const key = draftKey(getRuntimeKey(), directory, sessionKey);
  const drafts = useInlineCommentDrafts.getState().store[key]?.drafts ?? [];
  if (drafts.length > 0) useInlineCommentDrafts.getState().clearSessionDrafts(directory, sessionKey);
  return drafts;
}

/** 10.1 restore: put drafts back (send-failure rollback) — id/createdAt
 * preserved so the pinned-id contract survives a failed send. */
export function restoreDrafts(directory: string, sessionKey: string, drafts: CommentDraft[]): void {
  for (const draft of drafts) {
    const { id, createdAt, sessionKey: _drop, ...rest } = draft;
    void id; void createdAt; void _drop;
    useInlineCommentDrafts.getState().addDraft(directory, sessionKey, rest, { pinnedId: id, createdAt });
  }
}

export function __resetDraftsForTests(): void {
  useInlineCommentDrafts.setState({ store: {} });
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* nothing */ }
}

/** Simulates an app reload: re-hydrates the store from persisted storage. */
export function __reloadDraftsForTests(): void {
  useInlineCommentDrafts.setState({ store: hydrateEnvelope() });
}
