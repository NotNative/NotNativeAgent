// SPDX-License-Identifier: Apache-2.0
/**
 * CSS variable block builders for the runtime theme generator (doc 14 §B.1
 * runtime-token table: primary/surface/interactive/status/pr/syntax/markdown/
 * chat/tools/loading/sidebar-overlay + theme config + typography + the
 * shadcn-alias block that gets `!important`). Pure maps: name → css value.
 */
import { darken, isHexColor, lighten, toRgbTuples, withAlpha } from './color.ts';
import type { Theme } from './types.ts';

export type CssVars = Record<string, string>;

/** Non-hex optional values never reach the stylesheet (§A.2 emits raw hex). */
function pickHex(value: string | undefined, fallback: string): string {
  return typeof value === 'string' && isHexColor(value) ? value : fallback;
}

const camelToKebab = (key: string): string =>
  key.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`);

/** Shadcn-alias block — emitted with `!important` by the generator. */
export function aliasVars(theme: Theme): CssVars {
  const { surface, primary, status, interactive, charts } = theme.colors;
  const vars: CssVars = {
    '--background': surface.background,
    '--foreground': surface.foreground,
    '--card': surface.elevated,
    '--card-foreground': surface.elevatedForeground,
    '--popover': surface.overlay,
    '--popover-foreground': surface.foreground,
    '--primary': primary.base,
    '--primary-foreground': primary.foreground,
    '--secondary': surface.subtle,
    '--secondary-foreground': surface.foreground,
    '--muted': surface.muted,
    '--muted-foreground': surface.mutedForeground,
    '--accent': surface.subtle,
    '--accent-foreground': surface.foreground,
    '--destructive': status.error.value,
    '--destructive-foreground': status.error.foreground,
    '--border': interactive.border,
    '--input': interactive.border,
    '--ring': interactive.focusRing,
    '--sidebar': surface.background,
    '--sidebar-foreground': surface.foreground,
    '--sidebar-primary': primary.base,
    '--sidebar-primary-foreground': primary.foreground,
    '--sidebar-accent': surface.subtle,
    '--sidebar-accent-foreground': surface.foreground,
    '--sidebar-border': interactive.border,
    '--sidebar-ring': interactive.focusRing,
  };
  charts?.series.forEach((hex, index) => {
    vars[`--chart-${index + 1}`] = hex;
  });
  return vars;
}

const statusVars = (theme: Theme): CssVars => {
  const vars: CssVars = {};
  for (const [kind, entry] of Object.entries(theme.colors.status)) {
    vars[`--status-${kind}`] = entry.value;
    vars[`--status-${kind}-foreground`] = entry.foreground;
    vars[`--status-${kind}-background`] = entry.background;
    vars[`--status-${kind}-border`] = entry.border;
  }
  return vars;
};

const prVars = (theme: Theme): CssVars => {
  if (!theme.colors.pr) return {};
  return {
    '--pr-open': theme.colors.pr.open,
    '--pr-draft': theme.colors.pr.draft,
    '--pr-blocked': theme.colors.pr.blocked,
    '--pr-merged': theme.colors.pr.merged,
    '--pr-closed': theme.colors.pr.closed,
  };
};

const interactiveVars = (theme: Theme): CssVars => {
  const i = theme.colors.interactive;
  return {
    '--interactive-border': i.border,
    '--interactive-border-hover': i.borderHover,
    '--interactive-border-focus': i.borderFocus,
    '--interactive-selection': i.selection,
    '--interactive-selection-foreground': i.selectionForeground,
    '--interactive-focus': i.focus,
    '--interactive-focus-ring': i.focusRing,
    '--interactive-cursor': i.cursor,
    '--interactive-hover': i.hover,
    '--interactive-active': i.active,
  };
};

const geometryVars = (theme: Theme): CssVars => {
  const { surface, primary, syntax } = theme.colors;
  const isDark = theme.metadata.variant === 'dark';
  return {
    '--surface-background': surface.background,
    '--surface-foreground': surface.foreground,
    '--surface-muted': surface.muted,
    '--surface-muted-foreground': surface.mutedForeground,
    '--surface-elevated': surface.elevated,
    '--surface-elevated-foreground': surface.elevatedForeground,
    '--surface-overlay': surface.overlay,
    '--surface-subtle': surface.subtle,
    '--primary-base': primary.base,
    '--primary-hover': pickHex(primary.hover, darken(primary.base, 0.1)),
    '--primary-active': pickHex(primary.active, darken(primary.base, 0.2)),
    '--primary-foreground': primary.foreground,
    '--primary-muted': pickHex(primary.muted, withAlpha(primary.base, 0.5)),
    '--primary-emphasis': pickHex(primary.emphasis, lighten(primary.base, 0.1)),
    '--syntax-background': syntax.base.background,
    '--syntax-foreground': syntax.base.foreground,
    '--syntax-comment': syntax.base.comment,
    '--syntax-keyword': syntax.base.keyword,
    '--syntax-string': syntax.base.string,
    '--syntax-number': syntax.base.number,
    '--syntax-function': syntax.base.function,
    '--syntax-variable': syntax.base.variable,
    '--syntax-type': syntax.base.type,
    '--syntax-operator': syntax.base.operator,
    ...sidebarOverlayVars(theme, isDark),
  };
};

const sidebarOverlayVars = (theme: Theme, isDark: boolean): CssVars => {
  const base = theme.colors.surface.background;
  const accent = theme.colors.surface.subtle;
  return {
    '--sidebar-base': base,
    '--sidebar-base-rgb': toRgbTuples(base),
    '--sidebar-accent-base': accent,
    '--sidebar-accent-base-rgb': toRgbTuples(accent),
    '--sidebar-border-rgb': toRgbTuples(theme.colors.interactive.border),
    '--sidebar-overlay-strong': isDark ? 'rgba(15, 15, 20, 0.15)' : 'rgba(30, 26, 22, 0.5)',
    '--sidebar-overlay-soft': isDark ? 'rgba(15, 15, 20, 0.1)' : 'rgba(30, 26, 22, 0.3)',
  };
};

const syntaxTokenVars = (theme: Theme): CssVars => {
  const tokens = theme.colors.syntax.tokens ?? {};
  const vars: CssVars = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value !== 'string' || !isHexColor(value)) continue;
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(key)) continue;
    vars[`--syntax-${camelToKebab(key)}`] = value;
  }
  return vars;
};

const markdownVars = (theme: Theme): CssVars => {
  const m = theme.colors.markdown;
  if (!m) return {};
  return {
    '--markdown-heading1': m.heading1,
    '--markdown-heading2': m.heading2,
    '--markdown-heading3': m.heading3,
    '--markdown-heading4': m.heading4,
    '--markdown-link': m.link,
    '--markdown-link-hover': m.linkHover,
    '--markdown-inline-code': m.inlineCode,
    '--markdown-inline-code-bg': m.inlineCodeBackground,
    '--markdown-blockquote': m.blockquote,
    '--markdown-blockquote-border': m.blockquoteBorder,
    '--markdown-list-marker': m.listMarker,
    '--markdown-bold': m.bold,
    '--markdown-italic': m.italic,
    '--markdown-strikethrough': m.strikethrough,
    '--markdown-hr': m.hr,
  };
};

const chatVars = (theme: Theme): CssVars => {
  const c = theme.colors.chat;
  if (!c) return {};
  return {
    '--chat-background': c.background,
    '--chat-user-message': c.userMessage,
    '--chat-user-message-bg': c.userMessageBackground,
    '--chat-assistant-message': c.assistantMessage,
    '--chat-assistant-message-bg': c.assistantMessageBackground,
    '--chat-timestamp': c.timestamp,
    '--chat-divider': c.divider,
    '--chat-typing': c.typing,
  };
};

const toolsVars = (theme: Theme): CssVars => {
  const t = theme.colors.tools;
  if (!t) return {};
  const e = t.edit;
  return {
    '--tools-background': t.background,
    '--tools-border': t.border,
    '--tools-header-hover': t.headerHover,
    '--tools-icon': t.icon,
    '--tools-title': t.title,
    '--tools-description': t.description,
    '--tools-edit-added': e.added,
    '--tools-edit-added-bg': e.addedBackground,
    '--tools-edit-removed': e.removed,
    '--tools-edit-removed-bg': e.removedBackground,
    '--tools-edit-modified': e.modified,
    '--tools-edit-modified-bg': e.modifiedBackground,
    '--tools-edit-line-number': e.lineNumber,
  };
};

const loadingVars = (theme: Theme): CssVars => {
  const l = theme.colors.loading;
  if (!l) return {};
  return { '--loading-spinner': l.spinner, '--loading-spinner-track': l.spinnerTrack };
};

const configVars = (theme: Theme): CssVars => {
  const config = theme.config;
  if (!config) return {};
  const vars: CssVars = {};
  if (config.fonts?.sans) vars['--font-sans'] = config.fonts.sans;
  if (config.fonts?.mono) vars['--font-mono'] = config.fonts.mono;
  if (config.fonts?.heading) vars['--font-heading'] = config.fonts.heading;
  if (config.transitions?.fast) vars['--transition-fast'] = config.transitions.fast;
  if (config.transitions?.normal) vars['--transition-normal'] = config.transitions.normal;
  if (config.transitions?.slow) vars['--transition-slow'] = config.transitions.slow;
  return vars;
};

/** §B.3 typography variables re-emitted per theme (seeded statically, too). */
export const TYPOGRAPHY_VARS: CssVars = {
  '--text-markdown': '0.875rem',
  '--text-code': '0.75rem',
  '--text-ui-header': '0.875rem',
  '--text-ui-label': '0.8125rem',
  '--text-meta': '0.8125rem',
  '--text-micro': '0.8125rem',
  '--text-settings-page-title': '1.0625rem',
};

/** All generated blocks in emission order (doc §B.1 groups; the alias block
 * is serialized separately with `!important` — never duplicated here). */
export function themeVariableBlocks(theme: Theme): CssVars {
  return {
    ...geometryVars(theme),
    ...interactiveVars(theme),
    ...statusVars(theme),
    ...prVars(theme),
    ...syntaxTokenVars(theme),
    ...markdownVars(theme),
    ...chatVars(theme),
    ...toolsVars(theme),
    ...loadingVars(theme),
    ...configVars(theme),
    ...TYPOGRAPHY_VARS,
  };
}
