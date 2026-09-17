// SPDX-License-Identifier: Apache-2.0
/**
 * Shortcut dispatcher (doc 14 §I.2 dispatcher.ts): resolves effective
 * bindings at dispatch; holds the sequence prefix for 3000 ms (blur clears).
 * While a prefix is armed only the exact second key dispatches and stays
 * eligible during IME composition; mismatch clears the prefix. Escape is
 * consumed ONLY to cancel an armed prefix. Editable-target policy: plain
 * chords and bare prefixes without Cmd/Ctrl yield to text entry; both
 * digit prefixes work from editables when Cmd/Ctrl is held; everything
 * yields during IME composition except the armed second key.
 */
import { UNASSIGNED_SHORTCUT, SEQUENCE_TIMEOUT_MS, type Chord, type ShortcutCombo } from './bindings.ts';
import { SHORTCUT_SCHEMA } from './config.ts';
import { effectiveShortcutCombo } from './schema.ts';
import { activeShortcutHandler, isShortcutRegistrySuspended } from './registry.ts';

export interface DispatcherOptions {
  overrides?: Record<string, string>;
  mac?: boolean;
}

interface ArmedPrefix {
  candidates: { actionId: string; second: Chord }[];
  expiresAt: number;
}

let armed: ArmedPrefix | null = null;
let options: DispatcherOptions = {};

export function configureShortcutDispatcher(next: DispatcherOptions): void {
  options = next;
}

function isModifierKey(key: string): boolean {
  return ['control', 'alt', 'shift', 'meta'].includes(key);
}

/** §I.2: Windows AltGr reports ctrl+alt — text entry must keep it. */
function isAltGraphCombo(event: KeyboardEvent): boolean {
  return event.ctrlKey && event.altKey && typeof event.getModifierState === 'function'
    && event.getModifierState('AltGraph');
}

/**
 * §I.2 armed-prefix phase: expiry → null; Escape consumable ONLY while
 * armed; exact second chord dispatches; mismatch clears without passthrough.
 * Returns true when the event was consumed here.
 */
function resolveArmedPrefix(event: KeyboardEvent, mac: boolean): boolean {
  if (armed === null) return false;
  if (Date.now() > armed.expiresAt) {
    armed = null; // window expired
    return false;
  }
  if (isModifierKey(event.key)) return false; // modifier-only never progresses the prefix
  const composing = event.isComposing || event.keyCode === 229;
  if (event.key === 'Escape' && !composing) {
    armed = null; // Escape cancels a prefix only while one is armed
    event.preventDefault();
    return true;
  }
  // The exact second key stays eligible DURING IME composition (§I.2).
  const second = eventChord(event, mac);
  if (second !== null) {
    const match = armed.candidates.find((candidate) => equalsChord(second, candidate.second, mac));
    if (match) {
      event.preventDefault();
      armed = null;
      dispatch(match.actionId);
      return true;
    }
  }
  armed = null; // mismatch clears the prefix and restores composition
  return true;
}

function eventChord(event: KeyboardEvent, mac: boolean): Chord | null {
  const key = normalizeEventKey(event);
  if (key === null) return null;
  const mods = new Set<'mod' | 'ctrl' | 'alt' | 'shift'>();
  // Windows/Linux: mod IS Ctrl — the event never carries both.
  if (mac ? event.metaKey : event.ctrlKey) mods.add('mod');
  if (mac && event.ctrlKey) mods.add('ctrl');
  if (event.altKey) mods.add('alt');
  if (event.shiftKey) mods.add('shift');
  return { mods, key };
}

function normalizeEventKey(event: KeyboardEvent): string | null {
  const key = event.key;
  if (key === 'Escape') return 'escape';
  if (key === ' ') return 'space';
  if (key === ',') return 'comma';
  if (key === 'Tab' || key === 'Enter' || key === 'Backspace') return key.toLowerCase();
  if (/^Arrow(?=Left$|Right$|Up$|Down$)/iu.test(key)) return key.toLowerCase();
  if (isModifierKey(key)) return null;
  if (key.length === 1 && /[\w\[\];'"\\\/\.\-=`+_=]/u.test(key)) return key.toLowerCase();
  if (/^F\d{1,2}$/u.test(key)) return key.toLowerCase();
  return null; // IME/Process/Dead/Unidentified are never shortcut keys
}

function isChordMatch(event: KeyboardEvent, chord: Chord, mac: boolean): boolean {
  const actual = eventChord(event, mac);
  if (!actual) return false;
  // Non-mac: literal `ctrl` chords alias to the mod key (same physical key).
  const chordMods = chord.mods;
  const wants = mac
    ? chordMods
    : new Set([...chordMods].map((mod) => (mod === 'ctrl' ? 'mod' : mod)));
  if (chord.prefix) {
    if (!/^[1-9]$/u.test(actual.key)) return false;
  } else if (actual.key !== chord.key) return false;
  if (actual.mods.size !== wants.size) return false;
  for (const mod of wants) {
    if (!actual.mods.has(mod)) return false;
  }
  return true;
}

function equalsChord(a: Chord, b: Chord, mac: boolean): boolean {
  if (a.key !== b.key) return false;
  const widen = (mods: Set<string>, mac: boolean): Set<string> =>
    mac ? mods : new Set([...mods].map((mod) => (mod === 'ctrl' ? 'mod' : mod)));
  const wa = widen(a.mods as Set<string>, mac);
  const wb = widen(b.mods as Set<string>, mac);
  if (wa.size !== wb.size) return false;
  for (const mod of wa) {
    if (!wb.has(mod)) return false;
  }
  return true;
}

function targetIsEditable(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
}

function hasCmdCtrl(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

/** §I.2 editable policy: plain chords (no Cmd/Ctrl) AND AltGraph combos
 * yield to text entry — on Windows AltGr reports ctrl+alt, so the AltGraph
 * check must ride along even though hasCmdCtrl would pass it. */
function yieldsToTextEntry(event: KeyboardEvent): boolean {
  return targetIsEditable(event) && (!hasCmdCtrl(event) || isAltGraphCombo(event));
}

function dispatch(actionId: string, detail?: unknown): void {
  if (isShortcutRegistrySuspended()) return;
  if (actionId === UNASSIGNED_SHORTCUT) return;
  const handler = activeShortcutHandler(actionId);
  if (!handler) return;
  handler(detail);
  armed = null;
}

/** The window keydown listener installed by useShortcutRouter. */
export function handleShortcutKeydown(event: KeyboardEvent): void {
  const mac = options.mac ?? false;
  const overrides = options.overrides ?? {};
  const modifierOnly = isModifierKey(event.key);

  if (armed !== null && resolveArmedPrefix(event, mac)) return;
  if (modifierOnly) return;
  if (event.isComposing || event.keyCode === 229) return; // IME: no arming, no chords

  const eventChordForMatch = eventChord(event, mac);
  if (eventChordForMatch === null) return;

  // §I.1 leader layout: the shared first chord arms the WHOLE mod+k family;
  // only the exact second key dispatches the owning sibling action. Arming
  // respects the SAME editable policy as singles (§I.2: plain chords without
  // Cmd/Ctrl yield to text entry).
  if (armed === null && !yieldsToTextEntry(event)) {
    const candidates = twoChordCandidates(eventChordForMatch, mac, overrides)
      .filter((candidate) => activeShortcutHandler(candidate.actionId) !== null);
    if (candidates.length > 0) {
      armed = { candidates, expiresAt: Date.now() + SEQUENCE_TIMEOUT_MS };
      event.preventDefault();
      return;
    }
  }

  for (const group of SHORTCUT_SCHEMA) {
    for (const decl of group.entries.filter((entry) => entry.prefixStyle !== true)) {
      const combo = effectiveShortcutCombo(decl.id, overrides);
      if (combo.chords.length !== 1) continue; // two-chords arm (above) or get cleared
      if (armed !== null) continue; // while a prefix is armed, only the second key counts
      const first = combo.chords[0]!;
      if (yieldsToTextEntry(event)) continue; // plain chords yield to text entry
      if (isChordMatch(event, first, mac)) {
        event.preventDefault();
        dispatch(decl.id);
        return;
      }
    }
  }
}

/** All sibling sequences whose FIRST chord matches the event chord. */
function twoChordCandidates(chord: Chord, mac: boolean, overrides: Record<string, string>): { actionId: string; second: Chord }[] {
  const candidates: { actionId: string; second: Chord }[] = [];
  for (const group of SHORTCUT_SCHEMA) {
    for (const decl of group.entries.filter((entry) => entry.prefixStyle !== true)) {
      const combo = effectiveShortcutCombo(decl.id, overrides);
      if (combo.chords.length !== 2) continue;
      const first = combo.chords[0]!;
      if (!equalsChord(chord, first, mac)) continue;
      candidates.push({ actionId: decl.id, second: combo.chords[1]! });
    }
  }
  return candidates;
}

/** Digit-prefix router: matched BEFORE normal chords (§I.2 desktop rule). */
export function handleDigitPrefixKeydown(event: KeyboardEvent): void {
  const mac = options.mac ?? false;
  const overrides = options.overrides ?? {};
  const digit = /^[1-9]$/u.test(event.key) ? Number(event.key) : null;
  if (digit === null || isModifierKey(event.key)) return;
  if (targetIsEditable(event) && isAltGraphCombo(event)) return; // AltGr+digit is text
  for (const group of SHORTCUT_SCHEMA) {
    for (const decl of group.entries.filter((entry) => entry.prefixStyle === true)) {
      const combo = effectiveShortcutCombo(decl.id, overrides);
      const first = combo.chords[0];
      if (!first || !first.prefix) continue;
      if (isChordMatch(event, first, mac)) {
        event.preventDefault();
        dispatch(decl.id, digit);
        return;
      }
    }
  }
}

export function cancelArmedShortcut(): void {
  armed = null;
}

/** Capture-phase hook (§I.2): resolves a pending armed prefix ONLY; direct
 * calls skip the full router, and inner stopPropagation cannot kill the
 * sequence. */
export function resolveArmedPrefixForCapture(event: KeyboardEvent): boolean {
  const mac = options.mac ?? false;
  return resolveArmedPrefix(event, mac);
}

export function armedShortcutActionId(): string | null {
  return armed?.candidates[0]?.actionId ?? null;
}

/** §I.3 recorder contract: full-schema conflict scan WITH overrides —
 * exact matches win over prefix matches regardless of schema order
 * (`exact` replaceable iff the opponent is customizable; the loser gets
 * UNASSIGNED; prefix conflicts block). */
export function recorderConflict(
  actionId: string,
  combo: ShortcutCombo | null,
  overrides: Record<string, string> = {},
): { kind: 'exact' | 'prefix' | 'none'; replaceable: boolean; otherActionId: string | null } {
  if (!combo || combo.chords.length === 0) return { kind: 'none', replaceable: false, otherActionId: null };
  let prefix: { kind: 'exact' | 'prefix' | 'none'; replaceable: boolean; otherActionId: string | null } | null = null;
  for (const group of SHORTCUT_SCHEMA) {
    for (const decl of group.entries) {
      if (decl.id === actionId) continue;
      const opponent = effectiveShortcutCombo(decl.id, overrides);
      if (opponent.chords.length === 0) continue;
      const bothExact = opponent.chords.length === combo.chords.length
        && equalsChord(opponent.chords[0]!, combo.chords[0]!, false)
        && (opponent.chords.length === 1 || equalsChord(opponent.chords[1]!, combo.chords[1]!, false));
      if (bothExact) {
        return { kind: 'exact', replaceable: decl.customizable === true, otherActionId: decl.id };
      }
      if (prefix === null && equalsChord(opponent.chords[0]!, combo.chords[0]!, false)) {
        prefix = { kind: 'prefix', replaceable: false, otherActionId: decl.id };
      }
    }
  }
  return prefix ?? { kind: 'none', replaceable: false, otherActionId: null };
}
