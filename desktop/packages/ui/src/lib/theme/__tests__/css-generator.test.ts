// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * CSSVariableGenerator (doc 14 §A.2 layer 2 + §E.4): single style element,
 * variant-scoped blocks (`.dark` vs `:root:not(.dark)`), `!important` alias
 * block, data-theme attribute, runtime clusters present, config vars emitted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getBuiltInTheme } from '../themes.ts';
import { CSSVariableGenerator, THEME_STYLE_ELEMENT_ID } from '../css-generator.ts';
import { buildTheme } from '../derive.ts';
import type { ThemeSeed } from '../seed.ts';

const dracula = getBuiltInTheme('dracula')!;
const nordLight = getBuiltInTheme('nord-light')!;

const probeSeed: ThemeSeed = {
  id: 'probe-dark',
  name: 'Probe',
  variant: 'dark',
  version: '0.1.0',
  background: '#0a0a0a',
  foreground: '#f0f0f0',
  primary: '#ff5f57',
  syntax: {
    background: '#0d0d0d',
    foreground: '#eeeeee',
    comment: '#666666',
    keyword: '#c678dd',
    string: '#98c379',
    number: '#d19a66',
    function: '#61afef',
    variable: '#e06c75',
    type: '#e5c07b',
    operator: '#56b6c2',
  },
  status: { error: '#ff0000', warning: '#ffaa00', success: '#00cc66', info: '#3399ff' },
};

describe('CSSVariableGenerator (doc 14 §A.2/§E.4)', () => {
  afterEach(() => {
    CSSVariableGenerator.unapply();
    document.documentElement.className = '';
    delete document.documentElement.dataset.theme;
  });

  it('injects ONE style element carrying the dark dual-scope block', () => {
    expect(CSSVariableGenerator.apply(dracula)).toBe(true);
    const css = CSSVariableGenerator.injectedCss();
    expect(document.querySelectorAll(`style#${THEME_STYLE_ELEMENT_ID}`).length).toBe(1);
    expect(css).toContain(':root {');
    expect(css).toContain('.dark {');
    expect(css).not.toContain(':root:not(.dark)');
  });

  it('light themes scope to :root:not(.dark)', () => {
    CSSVariableGenerator.apply(nordLight);
    const css = CSSVariableGenerator.injectedCss();
    expect(css).toContain(':root:not(.dark) {');
    expect(css).not.toContain('\n.dark {');
  });

  it('emits the alias block with !important and the seed clusters without', () => {
    CSSVariableGenerator.apply(dracula);
    const css = CSSVariableGenerator.injectedCss();
    expect(css).toContain('--background: #282a36 !important;');
    expect(css).toContain('--primary: #bd93f9 !important;');
    expect(css).toContain('--surface-background: #282a36;');
    expect(css).toContain('--status-error: #ff5555;');
    expect(css).toContain('--pr-open: #50fa7b;');
    expect(css).toContain('--chat-user-message-bg:');
    expect(css).toContain('--tools-edit-line-number:');
    expect(css).toContain('--loading-spinner: #bd93f9;');
    expect(css).toContain('--text-markdown: 0.875rem;');
  });

  it('maps camelCase syntax tokens to --syntax-<kebab> variables', () => {
    const probe = buildTheme({
      ...probeSeed,
      syntax: { ...probeSeed.syntax!, tokens: { className: '#aabbcc', stringRegex: '#ddeeff' } },
    });
    CSSVariableGenerator.apply(probe);
    const css = CSSVariableGenerator.injectedCss();
    expect(css).toContain('--syntax-class-name: #aabbcc;');
    expect(css).toContain('--syntax-string-regex: #ddeeff;');
  });

  it('emits theme config fonts and transitions verbatim', () => {
    const probe = buildTheme(probeSeed);
    CSSVariableGenerator.apply(probe);
    expect(CSSVariableGenerator.injectedCss()).not.toContain('--font-sans:');
    const themed = buildTheme({ ...probeSeed });
    themed.config = {
      fonts: { sans: 'Probe Sans, sans-serif', mono: 'Probe Mono, monospace' },
      transitions: { fast: '90ms ease', normal: '220ms ease', slow: '330ms ease' },
    };
    CSSVariableGenerator.apply(themed);
    const css = CSSVariableGenerator.injectedCss();
    expect(css).toContain('--font-sans: Probe Sans, sans-serif;');
    expect(css).toContain('--transition-fast: 90ms ease;');
    expect(css).toContain('--transition-slow: 330ms ease;');
  });

  it('keeps dark/light class pair and data-theme in lockstep', () => {
    CSSVariableGenerator.apply(dracula);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    CSSVariableGenerator.apply(nordLight);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('replaces the element by id on theme switch (no duplicates)', () => {
    CSSVariableGenerator.apply(dracula);
    const before = CSSVariableGenerator.injectedCss();
    CSSVariableGenerator.apply(nordLight);
    const after = CSSVariableGenerator.injectedCss();
    expect(document.querySelectorAll(`style#${THEME_STYLE_ELEMENT_ID}`).length).toBe(1);
    expect(after).not.toBe(before);
    expect(after).toContain('#ecf2f7');
  });

  it('unapply removes the element and attribute', () => {
    CSSVariableGenerator.apply(dracula);
    CSSVariableGenerator.unapply();
    expect(document.getElementById(THEME_STYLE_ELEMENT_ID)).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe('sidebar overlay cluster (§B.1)', () => {
  it('emits rgb tuples and variant-skewed overlay alphas', () => {
    CSSVariableGenerator.apply(dracula);
    let css = CSSVariableGenerator.injectedCss();
    expect(css).toContain('--sidebar-base: #282a36;');
    expect(css).toContain('--sidebar-base-rgb: 40, 42, 54;');
    expect(css).toContain('--sidebar-overlay-strong: rgba(15, 15, 20, 0.15);');
    CSSVariableGenerator.apply(nordLight);
    css = CSSVariableGenerator.injectedCss();
    expect(css).toContain('--sidebar-overlay-strong: rgba(30, 26, 22, 0.5);');
  });
});
