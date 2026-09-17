// SPDX-License-Identifier: Apache-2.0
/**
 * isValidTheme (doc 14 §E.6): the interop gate for custom themes — server
 * read filter and UI adoption both run it. Checks the exact documented
 * subset (NOT the full generator surface, which derives missing fields):
 * metadata identity, primary base/foreground, the surface/interactive
 * validation lists, all 16 status fields, the 10 syntax.base fields, and
 * the three inline highlights. Variant must be exactly light or dark.
 */
import { isHexColor } from './color.ts';
import type { Theme, ThemeVariant } from './types.ts';

const REQUIRED_SURFACE = [
  'background',
  'foreground',
  'muted',
  'mutedForeground',
  'elevated',
  'elevatedForeground',
  'subtle',
] as const;
const REQUIRED_INTERACTIVE = ['border', 'selection', 'selectionForeground', 'focusRing', 'hover'] as const;
const REQUIRED_SYNTAX_BASE = [
  'background',
  'foreground',
  'comment',
  'keyword',
  'string',
  'number',
  'function',
  'variable',
  'type',
  'operator',
] as const;
const REQUIRED_HIGHLIGHTS = ['diffAdded', 'diffRemoved', 'lineNumber'] as const;
const STATUS_KINDS = ['error', 'warning', 'success', 'info'] as const;

export function isThemeVariant(value: unknown): value is ThemeVariant {
  return value === 'light' || value === 'dark';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Every listed key must be a hex color string. */
function allHex(source: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
  if (!source) return false;
  return keys.every((key) => isHexColor(source[key]));
}

/**
 * The §E.6 gate. Accepts unknown shapes softly: anything non-conforming is
 * `false` (server treats it as skip-with-warning, UI keeps the current theme).
 */
export function isValidTheme(candidate: unknown): candidate is Theme {
  const record = asRecord(candidate);
  const metadata = asRecord(record?.metadata);
  const colors = asRecord(record?.colors);
  if (!metadata || !colors) return false;
  if (typeof metadata.id !== 'string' || metadata.id.length === 0) return false;
  if (typeof metadata.name !== 'string' || metadata.name.length === 0) return false;
  if (!isThemeVariant(metadata.variant)) return false;
  if (!allHex(asRecord(colors.primary), ['base', 'foreground'])) return false;
  if (!allHex(asRecord(colors.surface), REQUIRED_SURFACE)) return false;
  if (!allHex(asRecord(colors.interactive), REQUIRED_INTERACTIVE)) return false;
  const syntax = asRecord(colors.syntax);
  const base = asRecord(syntax?.base);
  const highlights = asRecord(syntax?.highlights);
  if (!allHex(base, REQUIRED_SYNTAX_BASE)) return false;
  if (!allHex(highlights, REQUIRED_HIGHLIGHTS)) return false;
  const status = colors.status as Record<string, unknown> | undefined;
  return STATUS_KINDS.every((kind) =>
    allHex(status?.[kind] as Record<string, unknown>, ['value', 'foreground', 'background', 'border']),
  );
}

/** Renderer diagnostics: the first missing required field, or null when valid. */
export function firstInvalidField(candidate: unknown): string | null {
  if (isValidTheme(candidate)) return null;
  const raw: unknown = candidate;
  const theme = (raw ?? {}) as Record<string, unknown>;
  const meta = (theme.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.id !== 'string' || !meta.id) return 'metadata.id';
  if (typeof meta.name !== 'string' || !meta.name) return 'metadata.name';
  if (!isThemeVariant(meta.variant)) return 'metadata.variant';
  return 'colors (status/syntax/surface/interactive subset per doc 14 §E.6)';
}
