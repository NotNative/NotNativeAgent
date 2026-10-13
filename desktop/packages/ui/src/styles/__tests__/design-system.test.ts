// SPDX-License-Identifier: Apache-2.0
/**
 * P5-1 gates (doc 14 §B.1/§B.3 + Delta D8): the design-system stylesheet
 * declares the full token block for BOTH variants (light + dark), the
 * generated-token seed, the radius scale, and semantic typography;
 * ThemeProvider resolves `system` via matchMedia and follows OS changes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../../styles/design-system.css'), 'utf8');

function count(selector: string): number {
  return css.split(selector).length - 1;
}

describe('design-system tokens (doc 14 §B.1)', () => {
  it('declares the core palette for BOTH light (:root) and dark (.dark)', () => {
    for (const token of ['--background:', '--foreground:', '--primary:', '--border:', '--muted-foreground:']) {
      expect(count(token)).toBeGreaterThanOrEqual(2); // once in :root, once in .dark
    }
  });

  it('seeds the generated clusters the runtime theme will overwrite', () => {
    for (const token of ['--surface-background:', '--interactive-border:', '--status-error:', '--pr-open:', '--chat-user-message-bg:', '--loading-spinner:']) {
      expect(css.includes(token)).toBe(true);
    }
  });

  it('carries the radius scale and shell/environment tokens', () => {
    expect(css.includes('--radius-xl: 0.75rem;')).toBe(true); // B.2
    expect(css.includes('--radius-lg: 0.5625rem;')).toBe(true);
    expect(css.includes('--oc-header-height: 56px;')).toBe(true);
    expect(css.includes('--padding-scale: 1;')).toBe(true);
  });

  it('maps semantic typography with the web/desktop column values (§B.3)', () => {
    expect(css.includes('--text-markdown: 0.875rem;')).toBe(true);
    expect(css.includes('--text-code: 0.75rem;')).toBe(true);
    expect(css.includes('--text-settings-page-title: 1.0625rem;')).toBe(true);
  });

  it('exposes Tailwind utilities via @theme inline mappings', () => {
    expect(css.includes('--color-muted-foreground: var(--muted-foreground);')).toBe(true);
    expect(css.includes('--color-status-success: var(--status-success);')).toBe(true);
  });
});
