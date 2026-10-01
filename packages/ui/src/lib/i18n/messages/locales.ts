// SPDX-License-Identifier: Apache-2.0
/**
 * Non-English catalogs (doc 14 §H.2, delta E2): P5-4 ships en complete and
 * the 11 other locales as partial catalogs — the resolve chain falls back
 * per key to en (lib/i18n/context), and the closed `I18nKey` from en.ts
 * makes impossible keys a type error. Per-locale parity is authoring work;
 * the per-locale file split (<locale>.settings.ts) lands with the settings
 * volumes that need it.
 */
import type { PartialDictionary } from './en.ts';

import { de, fr, zhCN, zhTW } from './locale-catalogs-a.ts';
import { uk, es } from './locale-catalogs-c.ts';
import { ptBR, ko, pl, ja } from './locale-catalogs-b.ts';
import { tr } from './locale-catalogs-c.ts';
import en, { type Dictionary } from './en.ts';

const CATALOGS: Record<string, PartialDictionary> = {
  de, fr, 'zh-CN': zhCN, 'zh-TW': zhTW, uk, es, 'pt-BR': ptBR, ko, pl, ja, tr,
};

/** Full dictionaries: en complete, others merged over en per §H.2 resolve. */
export function dictionaryFor(locale: string): Dictionary {
  if (locale === 'en') return en;
  return { ...en, ...(CATALOGS[locale] ?? {}) };
}

export const PARTIAL_CATALOGS = CATALOGS;
