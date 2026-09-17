// SPDX-License-Identifier: Apache-2.0
/**
 * Custom theme loading (doc 14 §E.6): server-side JSON files are delivered by
 * GET /api/config/themes; each entry is shape-gated with isValidTheme and
 * silently skipped otherwise (server already filters on read; the client
 * re-checks so a stale instance cannot poison the renderer).
 */
import { runtimeFetch } from '../runtime-fetch.ts';
import { isValidTheme } from './validation.ts';
import { withPrColors } from './pr-colors.ts';
import type { Theme } from './types.ts';

export function sanitizeCustomThemes(body: unknown): Theme[] {
  const payload = body as { themes?: unknown } | null;
  const entries = Array.isArray(payload?.themes) ? (payload.themes as unknown[]) : [];
  return entries.filter(isValidTheme).map((theme) => withPrColors(theme as Theme));
}

export async function fetchCustomThemes(): Promise<Theme[]> {
  try {
    const response = await runtimeFetch('/api/config/themes');
    if (!response.ok) return [];
    return sanitizeCustomThemes(await response.json());
  } catch {
    return [];
  }
}
