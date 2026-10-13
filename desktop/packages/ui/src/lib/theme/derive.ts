// SPDX-License-Identifier: Apache-2.0
/**
 * Seed → full-schema Theme derivation (doc 14 §E.7 port-tool concept applied
 * to built-ins): each preset authors a compact seed palette; this module
 * expands it into EVERY generator-consumed field with the documented default
 * derivations (hover=darken10, active=darken20, muted=50% alpha, emphasis=
 * lighten10; surface muted/elevated always 8-digit hex ending `90`). No
 * half-mapped tokens: the emitted Theme always passes isValidTheme.
 */
import { darken, lighten, mixColors, readableForeground, withAlpha } from './color.ts';
import type { ThemeSeed } from './seed.ts';
import type {
  Theme,
  ThemeInteractiveColors,
  ThemePrimaryColors,
  ThemeStatusColors,
  ThemeSurfaceColors,
  ThemeSyntaxBase,
  ThemeVariant,
} from './types.ts';

export const ALPHA_90 = 144 / 255; // 0x90 — the §E.6 surface alpha contract

const DEFAULT_STATUS = {
  light: { error: '#b3261e', warning: '#9a6a00', success: '#1e7d40', info: '#2160b0' },
  dark: { error: '#e06454', warning: '#d9a53f', success: '#58a663', info: '#5a9bd8' },
} as const satisfies Record<ThemeVariant, Record<'error' | 'warning' | 'success' | 'info', string>>;

const DEFAULT_CHARTS = {
  light: ['#4d7fb3', '#5f9e54', '#b8863b', '#c96a52', '#8f7f4e'],
  dark: ['#5aa9d9', '#81af6c', '#c2974d', '#d8886d', '#d29470'],
} as const satisfies Record<ThemeVariant, string[]>;

export function buildTheme(seed: ThemeSeed): Theme {
  const isLight = seed.variant === 'light';
  const toward = isLight ? '#000000' : '#ffffff';
  const bg = seed.background;
  const fg = seed.foreground;
  const surface = buildSurface(seed, toward);
  const status = buildStatus(seed, bg, fg, isLight);
  const primary = buildPrimary(seed);
  const interactive = buildInteractive(seed, primary, bg, fg, isLight);
  const syntaxBase = buildSyntaxBase(seed, bg, fg, primary);
  const a = seed.syntax ?? {};
  const syntax = {
    base: syntaxBase,
    highlights: {
      diffAdded: status.success.value,
      diffAddedBackground: withAlpha(status.success.value, 0.16),
      diffRemoved: status.error.value,
      diffRemovedBackground: withAlpha(status.error.value, 0.16),
      diffModified: status.warning.value,
      diffModifiedBackground: withAlpha(status.warning.value, 0.16),
      lineNumber: mixColors(fg, bg, 0.55),
      lineNumberActive: mixColors(fg, bg, 0.18),
      ...(a.highlights ?? {}),
    },
    ...(a.tokens ? { tokens: a.tokens } : {}),
    ...(a.languages ? { languages: a.languages } : {}),
  };
  const shared: SharedPalette = {
    bg,
    fg,
    mutedForeground: surface.mutedForeground,
    border: interactive.border,
    hover: mixColors(bg, fg, isLight ? 0.05 : 0.07),
    primary,
    isLight,
  };
  return {
    metadata: {
      id: seed.id,
      name: seed.name,
      description: seed.description,
      author: seed.author,
      version: seed.version ?? '1.0.0',
      variant: seed.variant,
      tags: seed.tags ?? [],
    },
    colors: {
      primary,
      surface,
      interactive,
      status,
      syntax,
      markdown: buildMarkdown(shared, syntaxBase),
      chat: buildChat(shared, surface),
      tools: buildTools(shared, surface, status),
      loading: { spinner: primary.base, spinnerTrack: withAlpha(primary.base, 0.18) },
      charts: chartsFor(seed),
    },
  };
}

function chartsFor(seed: ThemeSeed): { series: string[] } {
  const fallback = DEFAULT_CHARTS[seed.variant];
  const series = [...(seed.charts ?? []), ...fallback].slice(0, 5);
  return { series };
}

function buildSurface(seed: ThemeSeed, toward: string): ThemeSurfaceColors {
  const bg = seed.background;
  const isLight = seed.variant === 'light';
  return {
    background: bg,
    foreground: seed.foreground,
    muted: withAlpha(mixColors(bg, toward, isLight ? 0.035 : 0.06), ALPHA_90),
    mutedForeground: seed.mutedForeground ?? mixColors(seed.foreground, bg, 0.42),
    elevated: withAlpha(mixColors(bg, toward, isLight ? 0.045 : 0.10), ALPHA_90),
    elevatedForeground: seed.foreground,
    overlay: mixColors(bg, '#ffffff', isLight ? 0.55 : 0.09),
    subtle: mixColors(bg, toward, isLight ? 0.06 : 0.03),
  };
}

function buildPrimary(seed: ThemeSeed): ThemePrimaryColors {
  const base = seed.primary;
  return {
    base,
    hover: darken(base, 0.10),
    active: darken(base, 0.20),
    foreground: seed.primaryForeground ?? readableForeground(base, ['#ffffff', '#000000']),
    muted: withAlpha(base, 0.5),
    emphasis: lighten(base, 0.10),
  };
}

function buildStatus(
  seed: ThemeSeed,
  bg: string,
  fg: string,
  isLight: boolean,
): ThemeStatusColors {
  const declared = seed.status ?? {};
  const entry = (value: string): ThemeStatusColors['error'] => ({
    value,
    foreground: readableForeground(bg, [value, isLight ? darken(value, 0.25) : lighten(value, 0.2), fg]),
    background: withAlpha(value, 0.12),
    border: withAlpha(value, 0.38),
  });
  const defaults = DEFAULT_STATUS[seed.variant];
  return {
    error: entry(declared.error ?? defaults.error),
    warning: entry(declared.warning ?? defaults.warning),
    success: entry(declared.success ?? defaults.success),
    info: entry(declared.info ?? defaults.info),
  };
}

function buildInteractive(
  seed: ThemeSeed,
  primary: ThemePrimaryColors,
  bg: string,
  fg: string,
  isLight: boolean,
): ThemeInteractiveColors {
  const border = seed.border ?? mixColors(bg, fg, isLight ? 0.14 : 0.16);
  return {
    border,
    borderHover: isLight ? darken(border, 0.12) : lighten(border, 0.12),
    borderFocus: primary.base,
    selection: withAlpha(primary.base, isLight ? 0.22 : 0.32),
    selectionForeground: fg,
    focus: primary.base,
    focusRing: withAlpha(primary.base, isLight ? 0.45 : 0.5),
    cursor: fg,
    hover: mixColors(bg, fg, isLight ? 0.05 : 0.07),
    active: mixColors(bg, fg, isLight ? 0.09 : 0.11),
  };
}

function buildSyntaxBase(
  seed: ThemeSeed,
  bg: string,
  fg: string,
  primary: ThemePrimaryColors,
): ThemeSyntaxBase {
  const a = seed.syntax ?? {};
  const synBg = a.background ?? bg;
  const synFg = a.foreground ?? fg;
  const mixInto = (t: number, from: string): string => mixColors(synFg, from, t);
  return {
    background: synBg,
    foreground: synFg,
    comment: a.comment ?? mixInto(0.40, synBg),
    keyword: a.keyword ?? primary.base,
    string: a.string ?? mixInto(0.55, primary.base),
    number: a.number ?? mixInto(0.35, primary.base),
    function: a.function ?? mixInto(0.20, primary.base),
    variable: a.variable ?? synFg,
    type: a.type ?? mixInto(0.75, primary.base),
    operator: a.operator ?? mixColors(synFg, synBg, 0.12),
  };
}

interface SharedPalette {
  bg: string;
  fg: string;
  mutedForeground: string;
  border: string;
  hover: string;
  primary: ThemePrimaryColors;
  isLight: boolean;
}

function buildMarkdown(s: SharedPalette, base: ThemeSyntaxBase): Theme['colors']['markdown'] {
  const inlineCodeBackground = mixColors(s.bg, s.fg, 0.07);
  return {
    heading1: s.fg,
    heading2: s.fg,
    heading3: s.fg,
    heading4: s.fg,
    link: s.primary.base,
    linkHover: s.primary.hover ?? s.primary.base,
    inlineCode: base.type,
    inlineCodeBackground,
    blockquote: s.mutedForeground,
    blockquoteBorder: s.border,
    listMarker: s.primary.base,
    bold: s.fg,
    italic: s.fg,
    strikethrough: s.mutedForeground,
    hr: s.border,
  };
}

function buildChat(s: SharedPalette, surface: ThemeSurfaceColors): Theme['colors']['chat'] {
  return {
    background: s.bg,
    userMessage: s.fg,
    userMessageBackground: withAlpha(s.primary.base, s.isLight ? 0.14 : 0.2),
    assistantMessage: s.fg,
    assistantMessageBackground: surface.elevated,
    timestamp: s.mutedForeground,
    divider: s.border,
    typing: s.mutedForeground,
  };
}

function buildTools(
  s: SharedPalette,
  surface: ThemeSurfaceColors,
  status: ThemeStatusColors,
): Theme['colors']['tools'] {
  return {
    background: surface.elevated,
    border: s.border,
    headerHover: s.hover,
    icon: s.mutedForeground,
    title: s.fg,
    description: s.mutedForeground,
    edit: {
      added: status.success.value,
      addedBackground: withAlpha(status.success.value, 0.12),
      removed: status.error.value,
      removedBackground: withAlpha(status.error.value, 0.12),
      modified: status.warning.value,
      modifiedBackground: withAlpha(status.warning.value, 0.12),
      lineNumber: mixColors(s.fg, s.bg, 0.5),
    },
  };
}
