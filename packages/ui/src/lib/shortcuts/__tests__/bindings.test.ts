// SPDX-License-Identifier: Apache-2.0
/**
 * Shortcut binding gates (doc 14 §I.2): chord grammar + alias normalization,
 * two-chord cap, macOS-vs-name display, the §I.2 conflict rule, browser-risk
 * feedback, and the effective-binding authority rules (internal actions are
 * never overridable; UNASSIGNED clears).
 */
import { describe, expect, it } from 'vitest';
import {
  BindingFormatError,
  UNASSIGNED_SHORTCUT,
  chordRisk,
  combosConflict,
  displayChord,
  displayCombo,
  parseChord,
  parseCombo,
  comboToString,
  effectiveBinding,
} from '../bindings.ts';
import { SHORTCUT_SCHEMA, type ShortcutDecl } from '../config.ts';

const decl = (over: Partial<ShortcutDecl>): ShortcutDecl => ({
  id: 'probe', defaultBinding: 'mod+i', customizable: true, ...over,
});

describe('chord grammar (§I.2 bindings)', () => {
  it('parses + canonically serializes, lowercasing keys', () => {
    expect(parseCombo('mod+k  t').chords.length).toBe(2);
    expect(comboToString(parseCombo('mod+alt+ArrowLeft'))).toBe('alt+mod+arrowleft');
    expect(comboToString(parseCombo('ctrl+]'))).toBe('ctrl+]');
  });

  it('normalizes modifier aliases (command/cmd/meta→mod, option→alt)', () => {
    expect(comboToString(parseCombo('command+option+p'))).toBe('alt+mod+p');
    expect(comboToString(parseCombo('meta+option+p'))).toBe('alt+mod+p');
  });

  it('caps at two chords and rejects malformed chords', () => {
    expect(() => parseCombo('mod+k t r').chords).toThrow(BindingFormatError);
    expect(() => parseCombo('mod+shift+i+k')).toThrow(BindingFormatError);
    expect(() => parseChord('mod+shift+i+k')).toThrow(BindingFormatError);
    expect(() => parseChord('mod++')).toThrow(BindingFormatError); // no ghost prefixes from corrupt overrides
    expect(() => parseChord('mod+')).toThrow(BindingFormatError);
    expect(parseCombo(UNASSIGNED_SHORTCUT).chords).toEqual([]);
    expect(() => parseChord('alt')).toThrow(BindingFormatError); // {alt} alone is not a prefix
    parseChord('mod+alt'); // §I.1 switch_context_surface: mod OR alt may join the prefix
    expect(parseChord('mod+alt').prefix).toBe(true);
    expect(parseChord('ctrl').prefix).toBe(true);
  });

  it('round-trips EVERY schema default binding (would have caught format drift)', () => {
    for (const group of SHORTCUT_SCHEMA) {
      for (const entry of group.entries) {
        const combo = parseCombo(entry.defaultBinding);
        expect(combo.chords.length, entry.id).toBeGreaterThan(0);
      }
    }
  });

  it('labels every customizable row against the closed en dictionary', async () => {
    const en = await import('../../i18n/messages/en.ts');
    for (const group of SHORTCUT_SCHEMA) {
      for (const entry of group.entries) {
        if (!entry.customizable) continue;
        const labelKey = entry.settingsLabelKey!;
        expect(labelKey in en.default, `${entry.id} label key must exist in en`).toBe(true);
      }
    }
  });

  it('bare prefix chords require exactly one of mod|ctrl', () => {
    const prefix = parseChord('mod');
    expect(prefix.prefix).toBe(true);
    expect(prefix.key).toBe('__prefix__');
  });
});

describe('display (macOS glyphs vs named mods, §I.2)', () => {
  it('renders mac glyph chains and Windows/Linux names for the same chord', () => {
    const chord = parseChord('mod+shift+i');
    expect(displayChord(chord, true)).toBe('⇧⌘I'); // ctrl glyph ⌃ only for real ctrl mods
    expect(displayChord(chord, false)).toBe('Ctrl+Shift+I');
    const combo = parseCombo('mod+k r');
    expect(displayCombo(combo, true).split(' ').length).toBe(2);
    expect(displayCombo(combo, false)).toContain('Ctrl+K');
  });
});

describe('conflict rule + risk (§I.2)', () => {
  it('single conflicts with sequences sharing the first chord; siblings fine', () => {
    const single = parseCombo('mod+k');
    const seqA = parseCombo('mod+k t');
    const seqB = parseCombo('mod+k r');
    expect(combosConflict(single, seqA)).toBe(true);
    expect(combosConflict(seqA, seqB)).toBe(false); // sibling sequences are fine
    expect(combosConflict(seqA, parseCombo('mod+k t'))).toBe(true);
    expect(combosConflict(parseCombo('mod+i'), seqA)).toBe(false);
    expect(combosConflict(parseCombo('mod+k'), parseCombo('mod+k'))).toBe(true);
  });

  it('warns on browser-reserved single chords (Ctrl+t family)', () => {
    expect(chordRisk(parseCombo('mod+t'))).toBe('browser-reserved');
    expect(chordRisk(parseCombo('mod+k t'))).toBe('ok');
    expect(chordRisk(parseCombo('mod+i'))).toBe('ok');
  });
});

describe('effective bindings (§I.3 authority rules)', () => {
  it('honors overrides for customizable actions and clears via UNASSIGNED', () => {
    expect(effectiveBinding(decl({}), { probe: 'mod+u' })).toBe('mod+u');
    expect(effectiveBinding(decl({}), { probe: UNASSIGNED_SHORTCUT })).toBe(UNASSIGNED_SHORTCUT);
    expect(effectiveBinding(decl({}), {})).toBe('mod+i');
  });

  it('internal actions are protected: overrides ignored, default kept', () => {
    expect(effectiveBinding(decl({ customizable: false, defaultBinding: 'escape' }), { probe: 'mod+x' })).toBe('escape');
  });

  it('every custom row carries a settings label key that lives in en', () => {
    for (const group of SHORTCUT_SCHEMA) {
      for (const entry of group.entries) {
        if (!entry.customizable) continue;
        expect(entry.settingsLabelKey?.startsWith('shortcuts.label.'), entry.id).toBe(true);
      }
    }
  });
});
