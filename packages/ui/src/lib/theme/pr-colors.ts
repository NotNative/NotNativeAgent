// SPDX-License-Identifier: Apache-2.0
/**
 * withPrColors (doc 14 §E.1): fills `colors.pr` when absent — open=success,
 * draft=mutedForeground, blocked=warning, closed=error; merged prefers the
 * syntax tokens className/enum/variableGlobal, falls back to base.keyword,
 * then the authored platform defaults (#8957e5 dark / #8250df light). A
 * partial `pr` object is completed per key so no token is ever dropped.
 */
import type { Theme, ThemePrColors } from './types.ts';

export const MERGED_HEX_DARK = '#8957e5';
export const MERGED_HEX_LIGHT = '#8250df';

export function withPrColors(theme: Theme): Theme {
  const existing = theme.colors.pr;
  const { syntax, status, surface } = theme.colors;
  const pickup = (value: unknown, fallback: string): string =>
    typeof value === 'string' && value.length > 0 ? value : fallback;
  return {
    ...theme,
    colors: {
      ...theme.colors,
      pr: {
        open: pickup(existing?.open, status.success.value),
        draft: pickup(existing?.draft, surface.mutedForeground),
        blocked: pickup(existing?.blocked, status.warning.value),
        merged: pickup(
          existing?.merged,
          mergedFallback(theme, [syntax.tokens?.className, syntax.tokens?.enum, syntax.tokens?.variableGlobal]),
        ),
        closed: pickup(existing?.closed, status.error.value),
      },
    },
  };
}

function mergedFallback(theme: Theme, candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  const keyword = theme.colors.syntax.base.keyword;
  if (typeof keyword === 'string' && keyword.length > 0) return keyword;
  return theme.metadata.variant === 'dark' ? MERGED_HEX_DARK : MERGED_HEX_LIGHT;
}
