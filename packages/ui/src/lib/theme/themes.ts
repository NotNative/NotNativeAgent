// SPDX-License-Identifier: Apache-2.0
/**
 * Built-in theme registry (doc 14 §E.2): 38 themes in registration order —
 * notnative-light|dark (brand), flexoki pair, then 14 pair families, then the
 * six singles. Every preset passes through withPrColors; ids resolve through
 * the legacy alias map (`app-light`/`app-dark` → flexoki).
 */
import { FLEXOKI_AND_CORE_SEEDS } from './presets/core.ts';
import { FIELDS_SEEDS } from './presets/fields.ts';
import { AURA_SEEDS } from './presets/aura.ts';
import { AYU_SEEDS } from './presets/ayu.ts';
import { CARBONFOX_SEEDS } from './presets/carbonfox.ts';
import { CATPPUCCIN_SEEDS } from './presets/catppuccin.ts';
import { GRUVBOX_SEEDS } from './presets/gruvbox.ts';
import { JETBRAINS_SEEDS } from './presets/jetbrains.ts';
import { KANAGAWA_SEEDS } from './presets/kanagawa.ts';
import { MONOKAI_SEEDS } from './presets/monokai.ts';
import { NIGHTOWL_SEEDS } from './presets/nightowl.ts';
import { NORD_SEEDS } from './presets/nord.ts';
import { ONEDARKPRO_SEEDS } from './presets/onedarkpro.ts';
import { SOLARIZED_SEEDS } from './presets/solarized.ts';
import { TOKYONIGHT_SEEDS } from './presets/tokyonight.ts';
import { SINGLE_SEEDS } from './presets/singles.ts';
import { buildTheme } from './derive.ts';
import { withPrColors } from './pr-colors.ts';
import type { Theme, ThemeVariant } from './types.ts';
import type { ThemeSeed } from './seed.ts';

const FAMILY_ORDER: ThemeSeed[][] = [
  FIELDS_SEEDS,
  AURA_SEEDS,
  AYU_SEEDS,
  CARBONFOX_SEEDS,
  CATPPUCCIN_SEEDS,
  GRUVBOX_SEEDS,
  JETBRAINS_SEEDS,
  KANAGAWA_SEEDS,
  MONOKAI_SEEDS,
  NIGHTOWL_SEEDS,
  NORD_SEEDS,
  ONEDARKPRO_SEEDS,
  SOLARIZED_SEEDS,
  TOKYONIGHT_SEEDS,
];

function seedsInRegistrationOrder(): ThemeSeed[] {
  return [...FLEXOKI_AND_CORE_SEEDS, ...FAMILY_ORDER.flat(), ...SINGLE_SEEDS];
}

export const BUILT_IN_THEMES: readonly Theme[] = seedsInRegistrationOrder().map((seed) =>
  withPrColors(buildTheme(seed)),
);

export const BUILT_IN_THEME_IDS: readonly string[] = BUILT_IN_THEMES.map((t) => t.metadata.id);

export const DEFAULT_LIGHT_THEME_ID = 'notnative-light';
export const DEFAULT_DARK_THEME_ID = 'notnative-dark';

const ALIAS_MAP: Record<string, string> = {
  'app-light': 'flexoki-light',
  'app-dark': 'flexoki-dark',
};

export function listBuiltInThemes(variant?: ThemeVariant): Theme[] {
  if (!variant) return [...BUILT_IN_THEMES];
  return BUILT_IN_THEMES.filter((theme) => theme.metadata.variant === variant);
}

export function getBuiltInTheme(id: string, variant?: ThemeVariant): Theme | null {
  const resolved = ALIAS_MAP[id] ?? id;
  const found = BUILT_IN_THEMES.find(
    (theme) => theme.metadata.id === resolved && (!variant || theme.metadata.variant === variant),
  );
  return found ?? null;
}

/** §E.2: matching-variant default, else the first theme of that variant. */
export function getDefaultBuiltInTheme(prefersDark: boolean): Theme {
  const variant: ThemeVariant = prefersDark ? 'dark' : 'light';
  const primary = getBuiltInTheme(prefersDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID);
  if (primary) return primary;
  return listBuiltInThemes(variant)[0] ?? BUILT_IN_THEMES[0]!;
}
