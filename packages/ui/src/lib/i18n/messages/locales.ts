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

import { de, fr, zhCN } from './locale-catalogs-a.ts';
import { zhTW } from './locale-catalogs-d.ts';
import { uk, es } from './locale-catalogs-c.ts';
import { ptBR, ko, pl } from './locale-catalogs-b.ts';
import { ja } from './locale-catalogs-e.ts';
import { tr } from './locale-catalogs-c.ts';
import { deShortcuts, frShortcuts, zhCNShortcuts, deShortcutLabels, frShortcutLabels, zhCNShortcutLabels } from './locale-shortcuts-a.ts';
import { zhTWShortcuts, ukShortcuts, esShortcuts, ptBRShortcuts, zhTWShortcutLabels, ukShortcutLabels, esShortcutLabels, ptBRShortcutLabels } from './locale-shortcuts-b.ts';
import { koShortcuts, plShortcuts, jaShortcuts, trShortcuts, koShortcutLabels, plShortcutLabels, jaShortcutLabels, trShortcutLabels } from './locale-shortcuts-c.ts';
import en, { type Dictionary } from './en.ts';

const CATALOGS: Record<string, PartialDictionary> = {
  de: { ...de, ...deShortcuts, ...deShortcutLabels },
  fr: { ...fr, ...frShortcuts, ...frShortcutLabels },
  'zh-CN': { ...zhCN, ...zhCNShortcuts, ...zhCNShortcutLabels },
  'zh-TW': { ...zhTW, ...zhTWShortcuts, ...zhTWShortcutLabels },
  uk: { ...uk, ...ukShortcuts, ...ukShortcutLabels },
  es: { ...es, ...esShortcuts, ...esShortcutLabels },
  'pt-BR': { ...ptBR, ...ptBRShortcuts, ...ptBRShortcutLabels },
  ko: { ...ko, ...koShortcuts, ...koShortcutLabels },
  pl: { ...pl, ...plShortcuts, ...plShortcutLabels },
  ja: { ...ja, ...jaShortcuts, ...jaShortcutLabels },
  tr: { ...tr, ...trShortcuts, ...trShortcutLabels },
};

/** Full dictionaries: en complete, others merged over en per §H.2 resolve. */
export function dictionaryFor(locale: string): Dictionary {
  if (locale === 'en') return en;
  return { ...en, ...(CATALOGS[locale] ?? {}) };
}

export const PARTIAL_CATALOGS = CATALOGS;
