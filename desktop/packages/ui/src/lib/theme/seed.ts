// SPDX-License-Identifier: Apache-2.0
/**
 * Preset seed palettes (doc 14 §E.2/§E.7 + gap §M): each registered built-in
 * authors this compact palette; lib/theme/derive.ts expands it into the full
 * generator-consumed schema. Per-family accents live in presets/*.ts.
 */
import type { ThemeVariant } from './types.ts';

export interface ThemeSeedSyntax {
  background?: string;
  foreground?: string;
  comment?: string;
  keyword?: string;
  string?: string;
  number?: string;
  function?: string;
  variable?: string;
  type?: string;
  operator?: string;
  tokens?: Record<string, string>;
  languages?: Record<string, Record<string, string>>;
  highlights?: Partial<Record<string, string>>;
}

export interface ThemeSeedStatus {
  error?: string;
  warning?: string;
  success?: string;
  info?: string;
}

export interface ThemeSeed {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  variant: ThemeVariant;
  tags?: string[];
  background: string;
  foreground: string;
  primary: string;
  primaryForeground?: string;
  border?: string;
  mutedForeground?: string;
  status?: ThemeSeedStatus;
  syntax?: ThemeSeedSyntax;
  charts?: string[];
}
