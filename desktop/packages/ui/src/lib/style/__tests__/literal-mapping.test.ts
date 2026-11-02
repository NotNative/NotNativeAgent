// SPDX-License-Identifier: Apache-2.0
/**
 * Literal-mapping gates (docs/planning/desktop-ui-visual-system.md §11).
 *
 * The mapping turns the dark-only literals screens grew up with into the
 * roles they meant. These tests pin each family so a rewrite cannot silently
 * drop the intent, and a sweep test proves no literal survives in components.
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classFor, remainingFontSizes, remainingLiterals, rewriteFontSizes, rewriteLiterals, rewriteRadii } from '../literal-mapping.ts';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The UI package root: lib/style/__tests__ → lib/style → lib → src → package.
 */
const uiRoot = resolve(here, '../../../..');

describe('literal mapping', () => {
  it('reads a dark page surface as the page', () => {
    expect(rewriteLiterals('className="bg-neutral-900 px-3"')).toBe('className="bg-background px-3"');
  });

  it('reads a dialog surface as a popover', () => {
    expect(rewriteLiterals('bg-neutral-950')).toBe('bg-popover');
  });

  it('reads a raised chip as a card', () => {
    expect(rewriteLiterals('bg-white/[0.03]')).toBe('bg-card/[0.03]');
    expect(rewriteLiterals('bg-white/10')).toBe('bg-card/10');
  });

  it('reads muted copy as the muted label and body copy as the foreground', () => {
    expect(rewriteLiterals('text-neutral-500')).toBe('text-muted-foreground');
    expect(rewriteLiterals('text-neutral-300')).toBe('text-muted-foreground');
    expect(rewriteLiterals('text-neutral-100')).toBe('text-foreground');
    expect(rewriteLiterals('text-white')).toBe('text-foreground');
  });

  it('reads an accent family as the primary action', () => {
    expect(rewriteLiterals('bg-sky-600')).toBe('bg-primary');
    expect(rewriteLiterals('text-sky-300')).toBe('text-primary');
    // An accent used as a structural line reads as the shared edge, not as a
    // focus ring: indigo-800 was a quiet guide beside reasoning text.
    expect(rewriteLiterals('border-indigo-800')).toBe('border-border');
    expect(rewriteLiterals('outline-sky-400')).toBe('outline-border');
  });

  it('reads tone families as their tone whatever the shade', () => {
    expect(rewriteLiterals('text-rose-400')).toBe('text-tone-error');
    expect(rewriteLiterals('bg-red-950')).toBe('bg-tone-error/18');
    expect(rewriteLiterals('border-red-900')).toBe('border-tone-error-border');
    expect(rewriteLiterals('text-emerald-300')).toBe('text-tone-success');
    expect(rewriteLiterals('bg-amber-500')).toBe('bg-tone-warning/18');
    expect(rewriteLiterals('text-amber-300')).toBe('text-tone-warning');
    expect(rewriteLiterals('text-indigo-300')).toBe('text-primary');
    expect(rewriteLiterals('bg-emerald-900')).toBe('bg-tone-success/18');
  });

  it('keeps an opacity suffix on the semantic class', () => {
    expect(rewriteLiterals('bg-neutral-900/40')).toBe('bg-background/40');
    expect(rewriteLiterals('border-white/15')).toBe('border-border/15');
  });

  it('leaves a semantic class untouched', () => {
    const source = 'className="bg-card text-muted-foreground border-border/60"';
    expect(rewriteLiterals(source)).toBe(source);
  });

  it('does not touch a token that merely contains a family name', () => {
    expect(rewriteLiterals('text-muted-foreground bg-neutralish')).toBe('text-muted-foreground bg-neutralish');
  });

  it('maps every role to a class that exists in the theme', () => {
    for (const role of ['surface', 'surface-raised', 'surface-dialog', 'text', 'text-muted', 'border', 'primary', 'live', 'success', 'warning', 'error'] as const) {
      for (const kind of ['text', 'bg', 'border'] as const) {
        expect(classFor(role, kind)).toMatch(/^(?:text|bg|border)-[a-z][\w-]*$/u);
      }
    }
  });
});

describe('type and geometry', () => {
  it('maps every pixel size to a type role', () => {
    expect(rewriteFontSizes('text-[10px]')).toBe('text-[length:var(--type-micro)]');
    expect(rewriteFontSizes('text-[11px]')).toBe('text-[length:var(--type-meta)]');
    expect(rewriteFontSizes('text-[13px]')).toBe('text-[length:var(--type-markdown)]');
  });

  it('leaves a role-sized class untouched', () => {
    const source = 'text-[length:var(--type-meta)]';
    expect(rewriteFontSizes(source)).toBe(source);
  });

  it('maps a bare pixel radius to the shared control geometry', () => {
    expect(rewriteRadii('rounded-[7px]')).toBe('rounded-[var(--radius-control)]');
  });
});

describe('sweep', () => {
  it('leaves no palette literal in a desktop component', () => {
    const files = globSync('src/**/*.tsx', { cwd: uiRoot });
    expect(files.length).toBeGreaterThan(200);
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(resolve(uiRoot, file), 'utf8');
      const found = [...remainingLiterals(source), ...remainingFontSizes(source)];
      if (found.length > 0) offenders.push(`${file}: ${[...new Set(found)].join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
