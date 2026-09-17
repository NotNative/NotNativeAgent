// SPDX-License-Identifier: Apache-2.0
/**
 * CSSVariableGenerator (doc 14 §A.2 layer 2 + §E.4 step 1): converts the
 * active Theme into ONE style element (`nnd-theme-variables`) appended to
 * `<head>`, replacing any previous one by id. Dark themes emit
 * `:root{...}\n.dark{...}` (same vars); light themes emit
 * `:root{...}\n:root:not(.dark){...}`. The shadcn-alias block is emitted
 * with `!important` (§A.2) and `data-theme` follows the variant.
 */
import { aliasVars, themeVariableBlocks } from './css-blocks.ts';
import type { CssVars } from './css-blocks.ts';
import type { Theme } from './types.ts';

export const THEME_STYLE_ELEMENT_ID = 'nnd-theme-variables';

function declarations(vars: CssVars, important: boolean): string {
  const suffix = important ? ' !important' : '';
  return Object.entries(vars)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([name, value]) => `${name}: ${value.trim()}${suffix};`)
    .join('\n    ');
}

function serialize(theme: Theme): string {
  const alias = declarations(aliasVars(theme), true);
  const runtime = declarations(themeVariableBlocks(theme), false);
  const scopes = theme.metadata.variant === 'dark'
    ? [':root', '.dark']
    : [':root', ':root:not(.dark)'];
  return scopes
    .map((scope) => `${scope} {\n    ${alias}\n    ${runtime}\n  }`)
    .join('\n');
}

function styleElement(id: string): HTMLStyleElement | null {
  return document.getElementById(id) as HTMLStyleElement | null;
}

function upsertStyleElement(id: string, cssText: string): HTMLStyleElement {
  let element = styleElement(id);
  if (!element) {
    element = document.createElement('style');
    element.id = id;
    document.head.appendChild(element);
  }
  element.textContent = cssText;
  return element;
}

function applyVariantAttributes(variant: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.classList.toggle('dark', variant === 'dark');
  root.classList.toggle('light', variant === 'light');
  root.dataset.theme = variant;
  root.dataset.nndVariant = variant;
  root.style.colorScheme = variant;
}

export const CSSVariableGenerator = {
  /** Swap the single theme style element; returns true when written. */
  apply(theme: Theme): boolean {
    if (typeof document === 'undefined') return false;
    upsertStyleElement(THEME_STYLE_ELEMENT_ID, serialize(theme));
    applyVariantAttributes(theme.metadata.variant);
    return true;
  },

  /** Remove injection (tests, endpoint switch with no theme yet). */
  unapply(): void {
    styleElement(THEME_STYLE_ELEMENT_ID)?.remove();
    const root = document.documentElement;
    delete root.dataset.theme;
  },

  /** Test/dev inspection handle: the current style text or empty string. */
  injectedCss(): string {
    return styleElement(THEME_STYLE_ELEMENT_ID)?.textContent ?? '';
  },
};
