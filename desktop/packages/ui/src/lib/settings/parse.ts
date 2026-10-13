// SPDX-License-Identifier: Apache-2.0
/**
 * parseSettingsDocument (doc 14 §F.3): the merged settings document parses
 * against the registry — unknown keys dropped, invalid values dropped AS IF
 * ABSENT (never replaced by defaults; §K invariant 1).
 */
import { SETTINGS_REGISTRY } from './registry.ts';

export interface SettingsParseOptions {
  /** Keys to never collect regardless of validity (e.g. surface echo). */
  skipKeys?: Set<string>;
}

export function parseSettingsDocument(
  doc: unknown,
  options: SettingsParseOptions = {},
): Record<string, unknown> {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const source = doc as Record<string, unknown>;
  const parsed: Record<string, unknown> = {};
  for (const field of SETTINGS_REGISTRY) {
    if (options.skipKeys?.has(field.key)) continue;
    if (!(field.key in source)) continue;
    const result = field.parse(source[field.key]);
    if (result === null) continue; // invalid == absent
    parsed[field.key] = result;
  }
  return parsed;
}

/** The `?surface=` echo field never reaches the settings surface. */
export const SURFACE_ECHO_KEY = 'surface';
