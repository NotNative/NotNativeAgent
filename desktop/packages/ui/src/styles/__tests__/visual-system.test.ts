// SPDX-License-Identifier: Apache-2.0
/**
 * Visual-system layer gates (docs/planning/desktop-ui-visual-system.md §4,
 * §10.1).
 *
 * The stylesheet holds structure only: the ladder comes from the runtime theme
 * generator. These gates pin that the static fallback carries every token the
 * primitives read, that the layer order puts call-site utilities last, that
 * reduced motion collapses the motion vocabulary, and that no primitive rule
 * writes a palette colour of its own.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_STYLE_ELEMENT_ID } from '../../lib/theme/css-generator.ts';
import { buildTheme } from '../../lib/theme/derive.ts';
import { themeVariableBlocks } from '../../lib/theme/css-blocks.ts';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../../styles/visual-system.css'), 'utf8');
const webEntry = readFileSync(resolve(here, '../../../../web/src/index.css'), 'utf8');

const LADDER_TOKENS = [
  '--surface-canvas', '--surface-panel', '--surface-raised', '--surface-recessed',
  '--surface-elevated', '--surface-floating', '--surface-popover', '--surface-tooltip',
  '--edge-hairline', '--edge-ring', '--edge-strong',
  '--edge-hairline-color', '--edge-ring-color',
  '--tone-tile', '--tone-tile-hover', '--tone-tile-pressed',
  '--selection-fill', '--selection-foreground', '--hover-fill', '--pressed-fill',
  '--focus-field', '--elevation-1', '--elevation-2', '--elevation-3', '--elevation-4',
  '--field-shadow', '--raised-shadow', '--glow-shine',
];

const PRIMITIVES = [
  'ui-raised', 'ui-raised-primary', 'ui-raised-destructive', 'ui-field', 'ui-tile',
  'ui-badge', 'ui-dot', 'ui-bar', 'ui-box', 'ui-callout', 'ui-disclosure',
  'ui-floating', 'ui-floating-glass', 'ui-scroll',
];

describe('visual-system stylesheet', () => {
  it('is loaded by the web entry after the design system', () => {
    const design = webEntry.indexOf('design-system.css');
    const visual = webEntry.indexOf('visual-system.css');
    expect(design).toBeGreaterThan(-1);
    expect(visual).toBeGreaterThan(design);
  });

  it('declares the fallback ladder for every token the primitives read', () => {
    for (const token of LADDER_TOKENS) {
      expect(css.includes(`${token}:`), token).toBe(true);
    }
  });

  it('puts call-site utilities above the primitives so a variant can opt out', () => {
    const order = ['@layer tokens', '@layer primitives', '@layer recipes'];
    const positions = order.map((layer) => css.indexOf(layer));
    for (const position of positions) expect(position).toBeGreaterThan(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('defines every primitive the component layer names', () => {
    for (const name of PRIMITIVES) {
      expect(css.includes(`.${name}`), name).toBe(true);
    }
  });

  it('keeps the accent out of the tile chosen state', () => {
    expect(css).toMatch(/\.ui-tile\[aria-pressed='true'\][\s\S]*?background-color: var\(--selection-fill\)/u);
  });

  it('zeroes the whole motion vocabulary under reduced motion', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const token of ['--motion-popup-duration', '--motion-layout-duration', '--motion-disclosure-duration', '--motion-shine-duration']) {
      expect(block.includes(`${token}: 0ms`), token).toBe(true);
    }
  });

  it('names no Tailwind palette colour in a primitive rule', () => {
    const primitives = css.slice(css.indexOf('@layer primitives'));
    const palette = /(?:background|color|border|box-shadow)-color?:\s*(?:rose|amber|indigo|red|neutral|sky|emerald|violet|slate|gray)-\d/u;
    expect(palette.test(primitives)).toBe(false);
  });

  it('emits the ladder tokens from the runtime theme generator', () => {
    const theme = buildTheme({
      id: 'gate', name: 'Gate', variant: 'dark',
      background: '#1C1B1A', foreground: '#cdccc3', primary: '#edb449',
    });
    const vars = themeVariableBlocks(theme);
    for (const token of LADDER_TOKENS) {
      expect(vars[token], token).toBeTruthy();
    }
    expect(vars['--tone-info']).toBeTruthy();
    expect(vars['--tone-error-text']).toBeTruthy();
  });

  it('keeps the generator id stable for prepaint and the provider', () => {
    expect(THEME_STYLE_ELEMENT_ID).toBe('nnd-theme-variables');
  });
});
