// SPDX-License-Identifier: Apache-2.0
/**
 * Theme type system (doc 14 §E.1 theme model + §E.6 custom-theme format).
 * The JSON interchange shape and the generator-consumed surface are the same
 * record: `colors.primary/surface/interactive/status/syntax` are required,
 * every other group is optional and becomes CSS variables only when present.
 */

export type ThemeVariant = 'light' | 'dark';

export interface ThemeMetadata {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version: string;
  variant: ThemeVariant;
  tags?: string[];
}

export interface ThemePrimaryColors {
  base: string;
  hover?: string;
  active?: string;
  foreground: string;
  muted?: string;
  emphasis?: string;
}

export interface ThemeSurfaceColors {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  elevated: string;
  elevatedForeground: string;
  overlay: string;
  subtle: string;
}

export interface ThemeInteractiveColors {
  border: string;
  borderHover: string;
  borderFocus: string;
  selection: string;
  selectionForeground: string;
  focus: string;
  focusRing: string;
  cursor: string;
  hover: string;
  active: string;
}

export interface ThemeStatusEntry {
  value: string;
  foreground: string;
  background: string;
  border: string;
}

export interface ThemeStatusColors {
  error: ThemeStatusEntry;
  warning: ThemeStatusEntry;
  success: ThemeStatusEntry;
  info: ThemeStatusEntry;
}

export interface ThemePrColors {
  open: string;
  draft: string;
  blocked: string;
  merged: string;
  closed: string;
}

export interface ThemeSyntaxBase {
  background: string;
  foreground: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  variable: string;
  type: string;
  operator: string;
}

export interface ThemeSyntaxHighlights {
  diffAdded: string;
  diffAddedBackground: string;
  diffRemoved: string;
  diffRemovedBackground: string;
  diffModified: string;
  diffModifiedBackground: string;
  lineNumber: string;
  lineNumberActive: string;
}

export interface ThemeSyntaxColors {
  base: ThemeSyntaxBase;
  highlights: ThemeSyntaxHighlights;
  tokens?: Record<string, string>;
  languages?: Record<string, Record<string, string>>;
}

export interface ThemeMarkdownColors {
  heading1: string;
  heading2: string;
  heading3: string;
  heading4: string;
  link: string;
  linkHover: string;
  inlineCode: string;
  inlineCodeBackground: string;
  blockquote: string;
  blockquoteBorder: string;
  listMarker: string;
  bold: string;
  italic: string;
  strikethrough: string;
  hr: string;
}

export interface ThemeChatColors {
  background: string;
  userMessage: string;
  userMessageBackground: string;
  assistantMessage: string;
  assistantMessageBackground: string;
  timestamp: string;
  divider: string;
  typing: string;
}

export interface ThemeToolsEditColors {
  added: string;
  addedBackground: string;
  removed: string;
  removedBackground: string;
  modified: string;
  modifiedBackground: string;
  lineNumber: string;
}

export interface ThemeToolsColors {
  background: string;
  border: string;
  headerHover: string;
  icon: string;
  title: string;
  description: string;
  edit: ThemeToolsEditColors;
}

export interface ThemeLoadingColors {
  spinner: string;
  spinnerTrack: string;
}

export interface ThemeChartsColors {
  series: string[];
}

export interface ThemeFontsConfig {
  sans?: string;
  mono?: string;
  heading?: string;
}

export interface ThemeTransitionsConfig {
  fast?: string;
  normal?: string;
  slow?: string;
}

export interface ThemeSpacingConfig {
  xs?: string;
  sm?: string;
  md?: string;
  lg?: string;
  xl?: string;
}

/** §E.6 sample block: forward-compatible input only — never emitted (C.3). */
export interface ThemeRadiusConfig {
  none?: string;
  sm?: string;
  md?: string;
  lg?: string;
  xl?: string;
  full?: string;
}

export interface ThemeConfig {
  fonts?: ThemeFontsConfig;
  transitions?: ThemeTransitionsConfig;
  spacing?: ThemeSpacingConfig;
  radius?: ThemeRadiusConfig;
}

export interface Theme {
  metadata: ThemeMetadata;
  colors: {
    primary: ThemePrimaryColors;
    surface: ThemeSurfaceColors;
    interactive: ThemeInteractiveColors;
    status: ThemeStatusColors;
    pr?: ThemePrColors;
    syntax: ThemeSyntaxColors;
    markdown?: ThemeMarkdownColors;
    chat?: ThemeChatColors;
    tools?: ThemeToolsColors;
    loading?: ThemeLoadingColors;
    charts?: ThemeChartsColors;
  };
  config?: ThemeConfig;
}
