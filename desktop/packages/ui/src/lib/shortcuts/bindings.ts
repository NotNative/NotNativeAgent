// SPDX-License-Identifier: Apache-2.0
/**
 * Chord grammar (doc 14 §I.2 bindings.ts): canonical tokens `mod|ctrl|alt|
 * shift` + lowercased plain keys; one or TWO space-separated chords (max
 * 2, ≤3 physical keys each); aliases normalize (command/cmd/meta → mod,
 * option → alt). Display uses macOS glyphs ⌘⌥⌃⇧ vs Ctrl/Alt names elsewhere;
 * `UNASSIGNED_SHORTCUT` is the cleared sentinel. Conflict rule: a single
 * chord conflicts with any sequence sharing its first chord; sibling
 * sequences are fine.
 */
import type { ShortcutDecl } from './config.ts';

export const UNASSIGNED_SHORTCUT = '__unassigned__';
export const SEQUENCE_TIMEOUT_MS = 3000;

export interface Chord {
  mods: Set<'mod' | 'ctrl' | 'alt' | 'shift'>;
  key: string;
  prefix?: boolean; // bare held-modifier prefix (digits) with no key part
}

export interface ShortcutCombo {
  chords: Chord[];
}

export class BindingFormatError extends Error {}

const KNOWN_MODS = new Set(['mod', 'ctrl', 'alt', 'shift']);
const MOD_ALIASES: Record<string, 'mod' | 'alt'> = {
  command: 'mod',
  cmd: 'mod',
  meta: 'mod',
  option: 'alt',
};

const countGate = <T>(items: T[], limit: number): void => {
  if (items.length > limit) throw new BindingFormatError(`more than ${limit} tokens`);
};

function normalizeToken(token: string): string {
  const lower = token.toLowerCase();
  return MOD_ALIASES[lower] ?? lower; // plain keys / single chars carry as-is (lowercased)
}

export function parseChord(chord: string): Chord {
  countGate(chord.split(/\+/u), 4); // 3 mods + 1 key
  const tokens = chord.split(/\+/u).map((token) => token.trim());
  for (const token of tokens) {
    if (token.length === 0) throw new BindingFormatError('empty modifier token in chord');
  }
  const normalized = tokens.map(normalizeToken);
  const mods = new Set<'mod' | 'ctrl' | 'alt' | 'shift'>();
  let key: string | null = null;
  for (const token of normalized) {
    if (KNOWN_MODS.has(token)) {
      mods.add(token as 'mod' | 'ctrl' | 'alt' | 'shift');
      continue;
    }
    if (key !== null) throw new BindingFormatError('multiple keys in chord');
    key = token;
  }
  if (key === null) {
    // Bare prefix: digit chords keep ≥1 of mod|ctrl (alt/shift may join);
    // `{alt}` or `{shift}` alone are formats, not prefixes.
    if (mods.size === 0 || !(mods.has('mod') || mods.has('ctrl'))) {
      throw new BindingFormatError('bare prefix requires mod or ctrl (alone or with extras)');
    }
    return { mods, key: '__prefix__', prefix: true };
  }
  return { mods, key };
}

export function parseCombo(binding: string): ShortcutCombo {
  const trimmed = binding.trim();
  if (trimmed.length === 0 || trimmed === UNASSIGNED_SHORTCUT) return { chords: [] };
  const chords = trimmed.split(/\s+/u).map(parseChord);
  countGate(chords, 2);
  return { chords };
}

export function comboToString(combo: ShortcutCombo): string {
  return combo.chords
    .map((chord) => chord.prefix
      ? [...chord.mods].sort().join('+')
      : [...chord.mods].sort().join('+') + (chord.mods.size > 0 ? '+' : '') + chord.key)
    .join(' ');
}

const MAC_GLYPHS: Record<string, string> = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' };
const NAMED_MODS: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };

/** Recorder/kbd display for named keys (doc 14 §I.3 <kbd> labels). */
const KEY_LABELS: Record<string, string> = {
  comma: ',',
  escape: 'Esc',
  space: 'Space',
  tab: 'Tab',
  enter: 'Enter',
  backspace: 'Backspace',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
};

function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? key.toUpperCase();
}

/**
 * Mac glyph order follows the platform convention (⌃⌥⇧⌘); named-mod order
 * follows the Windows convention (Ctrl, Alt, Shift).
 */
export function displayChord(chord: Chord, mac = false): string {
  const order = mac ? ['ctrl', 'alt', 'shift', 'mod'] : ['mod', 'ctrl', 'alt', 'shift'];
  const parts: string[] = [];
  for (const mod of order) {
    if (!chord.mods.has(mod as 'mod' | 'ctrl' | 'alt' | 'shift')) continue;
    if (!mac && mod === 'mod' && chord.mods.has('ctrl')) continue; // mod == Ctrl here
    parts.push(mac ? (MAC_GLYPHS[mod] ?? '') : (NAMED_MODS[mod] ?? ''));
  }
  if (chord.prefix) return parts.join('');
  parts.push(keyLabel(chord.key));
  return parts.join(mac ? '' : '+');
}

export function displayCombo(combo: ShortcutCombo, mac = false): string {
  return combo.chords.map((chord) => displayChord(chord, mac)).join(' ');
}

function sameChord(a: Chord, b: Chord): boolean {
  if (a.key !== b.key || a.mods.size !== b.mods.size) return false;
  for (const mod of a.mods) {
    if (!b.mods.has(mod)) return false;
  }
  return true;
}

/** §I.2 conflict rule. Single chord vs sequence: matches the FIRST chord. */
export function combosConflict(a: ShortcutCombo, b: ShortcutCombo): boolean {
  if (a.chords.length === 0 || b.chords.length === 0) return false;
  if (a.chords.length === 1 && b.chords.length === 1) return sameChord(a.chords[0]!, b.chords[0]!);
  if (a.chords.length === 2 && b.chords.length === 2) return sameChord(a.chords[0]!, b.chords[0]!) && sameChord(a.chords[1]!, b.chords[1]!);
  const single = a.chords.length === 1 ? a.chords[0]! : b.chords[0]!;
  const pair = a.chords.length === 2 ? a : b;
  return sameChord(single, pair.chords[0]!);
}

/** §I.3 browser-risk feedback candidates (warn-only). */
const BROWSER_RISKY = new Set(['t', 'w', 'n', 'l', 'q', 'd', 'p', 's', 'f', 'j']);

export function chordRisk(combo: ShortcutCombo): 'browser-reserved' | 'ok' {
  const first = combo.chords[0];
  if (!first || first.mods.has('shift')) return 'ok';
  if ((first.mods.has('mod') || first.mods.has('ctrl')) && BROWSER_RISKY.has(first.key)) {
    return 'browser-reserved';
  }
  return 'ok';
}

/** Recorder/effective-binding helper: an OVERRIDE for a NON-customizable or
 * undeclared action is authoritative-protected (§I.3) and ignored here. */
export function effectiveBinding(decl: ShortcutDecl, overrides: Record<string, string>): string {
  if (!decl.customizable) return decl.defaultBinding;
  const override = overrides[decl.id];
  if (typeof override !== 'string') return decl.defaultBinding;
  return override.length === 0 ? UNASSIGNED_SHORTCUT : override;
}
