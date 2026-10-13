// SPDX-License-Identifier: Apache-2.0
/**
 * Shortcut schema types + lookups (doc 14 §I.2 schema.ts): derives the
 * ShortcutActionId union, category ordering, per-id declarations, and the
 * effective-binding resolver (override → default; internal bindings are
 * authoritative and cannot be overridden/unassigned).
 */
import { SHORTCUT_SCHEMA, type ShortcutCategory, type ShortcutDecl } from './config.ts';
import { UNASSIGNED_SHORTCUT, parseCombo, type ShortcutCombo } from './bindings.ts';

/** Action ids are runtime-validated (schema lookup) — the recorder and hooks
 * reject undeclared ids (§I.2), so a string alias keeps the public surface
 * simple while preserving authority rules. */
export type ShortcutActionId = string;

const LOOKUP: Record<string, ShortcutDecl> = {};
const CATEGORY_OF: Record<string, ShortcutCategory> = {};
for (const group of SHORTCUT_SCHEMA) {
  for (const entry of group.entries) {
    LOOKUP[entry.id] = entry;
    CATEGORY_OF[entry.id] = group.category;
  }
}

export const SHORTCUT_CATEGORIES: readonly ShortcutCategory[] = SHORTCUT_SCHEMA.map((group) => group.category);

export function shortcutDecl(actionId: string): ShortcutDecl | null {
  return LOOKUP[actionId] ?? null;
}

export function shortcutCategory(actionId: string): ShortcutCategory | null {
  return CATEGORY_OF[actionId] ?? null;
}

/** Effective combo for dispatch (override → default; UNASSIGNED → none). */
export function effectiveShortcutCombo(actionId: string, overrides: Record<string, string> = {}): ShortcutCombo {
  const decl = LOOKUP[actionId];
  if (!decl || !decl.customizable) return combosFor(decl);
  const override = overrides[actionId];
  const binding = override === UNASSIGNED_SHORTCUT || override === '' ? null : (override ?? decl.defaultBinding);
  return binding ? parseCombo(binding) : { chords: [] };
}

/** Default combos incl. internal actions (dispatch falls back to these). */
export function combosFor(decl: ShortcutDecl | undefined | null): ShortcutCombo {
  if (!decl) return { chords: [] };
  return parseCombo(decl.defaultBinding);
}

export function defaultShortcutBinding(actionId: string): string | null {
  return LOOKUP[actionId]?.defaultBinding ?? null;
}

export function customizableActionIds(): string[] {
  return Object.values(LOOKUP).filter((decl) => decl.customizable).map((decl) => decl.id);
}

/** Recorder authority check: persisted overrides may never rebind internals. */
export function overrideIsPermitted(actionId: string): boolean {
  return LOOKUP[actionId]?.customizable === true;
}
