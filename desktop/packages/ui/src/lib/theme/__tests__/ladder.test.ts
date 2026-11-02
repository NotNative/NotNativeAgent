// SPDX-License-Identifier: Apache-2.0
/**
 * Tone-ladder gates (docs/planning/desktop-ui-visual-system.md §4.3, §10.1).
 *
 * The ladder decides how every surface is lit from the theme's own
 * luminances. These tests pin both polarities, the equal-luminance fallback,
 * the completeness of the token set, and that a tone keeps readable contrast.
 */
import { describe, expect, it } from 'vitest';
import { buildLadder, buildTones, chooseLighting, toneReadable } from '../ladder.ts';
import { buildTheme } from '../derive.ts';
import { BUILT_IN_THEMES } from '../themes.ts';

const DARK = {
  canvas: '#1C1B1A',
  elevated: '#151313',
  foreground: '#cdccc3',
  primary: '#edb449',
};

const LIGHT = {
  canvas: '#f5f0e8',
  elevated: '#fdfbf7',
  foreground: '#403a30',
  primary: '#c07a1e',
};

const REQUIRED = [
  '--surface-canvas', '--surface-panel', '--surface-raised', '--surface-recessed',
  '--surface-elevated', '--surface-floating', '--surface-popover', '--surface-tooltip',
  '--edge-hairline', '--edge-ring', '--edge-strong',
  '--edge-hairline-color', '--edge-ring-color',
  '--tone-tile', '--tone-tile-hover', '--tone-tile-pressed',
  '--selection-fill', '--selection-foreground', '--hover-fill', '--pressed-fill',
  '--focus-field', '--elevation-1', '--elevation-2', '--elevation-3', '--elevation-4',
  '--field-shadow', '--raised-shadow', '--scrollbar-thumb', '--scrollbar-thumb-hover',
  '--glass-blur', '--glass-opacity', '--glass-saturation', '--glow-shine',
];

function ladderOf(theme: (typeof BUILT_IN_THEMES)[number]) {
  return buildLadder({
    canvas: theme.colors.surface.background,
    elevated: theme.colors.surface.elevated,
    foreground: theme.colors.surface.foreground,
    primary: theme.colors.primary.base,
  });
}

describe('ladder lighting', () => {
  it('reads an elevated surface darker than the canvas as pressed', () => {
    expect(chooseLighting(DARK)).toBe('pressed');
  });

  it('reads an elevated surface lighter than the canvas as lit', () => {
    expect(chooseLighting(LIGHT)).toBe('lit');
  });

  it('falls back to lit when both surfaces share a luminance', () => {
    expect(chooseLighting({ ...LIGHT, elevated: LIGHT.canvas })).toBe('lit');
  });

  it('gives each polarity its own field and raised shadow', () => {
    const pressed = buildLadder(DARK);
    const lit = buildLadder(LIGHT);
    expect(pressed.lighting).toBe('pressed');
    expect(lit.lighting).toBe('lit');
    expect(pressed.tokens['--field-shadow']).toContain('inset');
    expect(lit.tokens['--field-shadow']).not.toMatch(/inset 0 1px 2px/u);
    expect(pressed.tokens['--raised-shadow']).not.toContain('0 1px 2px 0 rgb');
    expect(lit.tokens['--raised-shadow']).toContain('0 1px 2px 0 rgb');
  });
});

describe('ladder tokens', () => {
  it('emits every token the primitive layer needs for both polarities', () => {
    for (const input of [DARK, LIGHT]) {
      const ladder = buildLadder(input);
      for (const token of REQUIRED) {
        expect(ladder.tokens[token], `${input.canvas} ${token}`).toBeTruthy();
      }
    }
  });

  it('keeps the accent out of the selection fill', () => {
    for (const input of [DARK, LIGHT]) {
      expect(buildLadder(input).tokens['--selection-fill']).not.toBe(input.primary);
    }
  });

  it('derives a complete ladder for every built-in theme', () => {
    expect(BUILT_IN_THEMES.length).toBeGreaterThan(0);
    for (const theme of BUILT_IN_THEMES) {
      const ladder = ladderOf(theme);
      expect(Object.keys(ladder.tokens).sort(), theme.metadata.id).toEqual([...REQUIRED].sort());
    }
  });

  it('keeps every status tone readable on its theme canvas', () => {
    for (const theme of BUILT_IN_THEMES) {
      const canvas = theme.colors.surface.background;
      for (const entry of Object.values(theme.colors.status)) {
        expect(toneReadable(entry.value, canvas), `${theme.metadata.id} ${entry.value}`).toBe(true);
      }
    }
  });

  it('builds a tone with a fill and a border in the same hue', () => {
    const tones = buildTones(buildLadder(DARK), 'error', '#e06454');
    expect(tones['--tone-error-fill']).toBeTruthy();
    expect(tones['--tone-error-border']).toBeTruthy();
    expect(tones['--tone-error-text']).toBe('#e06454');
  });

  it('leaves an authored status tone untouched when it already clears the floor', () => {
    const theme = buildTheme({
      id: 'contrast-ok', name: 'Contrast ok', variant: 'dark',
      background: '#151313', foreground: '#cdccc3', primary: '#edb449',
      status: { error: '#e06454', warning: '#d9a53f', success: '#58a663', info: '#5a9bd8' },
    });
    expect(theme.colors.status.error.value).toBe('#e06454');
    expect(theme.colors.status.warning.value).toBe('#d9a53f');
  });

  it('raises an unreadable status tone only as far as the floor', () => {
    const theme = buildTheme({
      id: 'contrast-low', name: 'Contrast low', variant: 'light',
      background: '#fbf1c7', foreground: '#3c3836', primary: '#b57614',
      status: { warning: '#b58900' },
    });
    const raised = theme.colors.status.warning.value;
    expect(raised.toLowerCase()).not.toBe('#b58900');
    expect(toneReadable(raised, '#fbf1c7')).toBe(true);
  });
});
