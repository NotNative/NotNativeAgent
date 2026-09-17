// SPDX-License-Identifier: Apache-2.0
/**
 * Font choice catalogs (doc 14 §B.4): ids + labels + leading stacks. The
 * Webfont lazy-loading of the upstream Fontsource packages is delta E11 —
 * NND v1 serves the stacks only (system faces ship today).
 */
export interface FontOption {
  id: string;
  label: string;
  stack: string;
}

const SYSTEM_UI_STACK =
  '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

export const UI_FONT_OPTIONS: readonly FontOption[] = [
  { id: 'system', label: 'System', stack: SYSTEM_UI_STACK },
  { id: 'inter', label: 'Inter', stack: 'Inter, "SF Pro Text", -apple-system, sans-serif' },
  { id: 'noto-sans', label: 'Noto Sans', stack: '"Noto Sans", sans-serif' },
  { id: 'source-sans-3', label: 'Source Sans 3', stack: '"Source Sans 3", sans-serif' },
  { id: 'roboto', label: 'Roboto', stack: 'Roboto, sans-serif' },
  { id: 'dm-sans', label: 'DM Sans', stack: '"DM Sans", sans-serif' },
  { id: 'manrope', label: 'Manrope', stack: 'Manrope, sans-serif' },
  { id: 'geist-sans', label: 'Geist Sans', stack: '"Geist Sans", sans-serif' },
  { id: 'fixel', label: 'Fixel Text', stack: '"Fixel Text", sans-serif' },
  { id: 'atkinson-hyperlegible', label: 'Atkinson Hyperlegible', stack: '"Atkinson Hyperlegible", sans-serif' },
];

export const MONO_FONT_OPTIONS: readonly FontOption[] = [
  {
    id: 'system-mono',
    label: 'System mono',
    stack: 'ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace',
  },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', stack: '"JetBrains Mono", monospace' },
  { id: 'fira-code', label: 'Fira Code', stack: '"Fira Code", monospace' },
  { id: 'cascadia-code', label: 'Cascadia Code', stack: '"Cascadia Code", monospace' },
  { id: 'source-code-pro', label: 'Source Code Pro', stack: '"Source Code Pro", monospace' },
  { id: 'roboto-mono', label: 'Roboto Mono', stack: '"Roboto Mono", monospace' },
  { id: 'geist-mono', label: 'Geist Mono', stack: '"Geist Mono", monospace' },
  { id: 'commit-mono', label: 'Commit Mono', stack: '"Commit Mono", monospace' },
  { id: 'iosevka', label: 'Iosevka', stack: 'Iosevka, monospace' },
];
