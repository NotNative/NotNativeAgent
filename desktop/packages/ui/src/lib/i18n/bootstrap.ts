// SPDX-License-Identifier: Apache-2.0
/**
 * Bootstrap strings (doc 14 §H.2 bootstrap.ts): pre-dictionary copy for
 * splash/connection UI. Plain functions so hosts can call them before any
 * dictionary installs; English with the per-locale catalog overlay applied.
 */
import { dictionaryFor } from './messages/locales.ts';
import { detectInitialLocale, readStoredLocale, type Locale } from './runtime.ts';
import type { I18nKey } from './messages/en.ts';

type BootstrapKeyId = Extract<
  I18nKey,
  | 'bootstrap.connecting'
  | 'bootstrap.loading'
  | 'bootstrap.cliMissing'
  | 'bootstrap.devServerWait'
  | 'bootstrap.offline'
  | 'shell.connecting'
  | 'shell.connected'
  | 'shell.offline'
>;

/** §H.4 pre-React boot read: stored locale (never the host seed) — consumed
 * by the P12 shell splash; the web splash wires with P12 too (delta E7). */
export function readStoredLocaleForBootstrap(): Locale | null {
  return readStoredLocale();
}

export function bootstrapStrings(locale: Locale = detectInitialLocale()): Record<BootstrapKeyId, string> {
  const dictionary = dictionaryFor(locale);
  const pick = (key: BootstrapKeyId): string => dictionary[key] ?? key;
  return {
    'bootstrap.connecting': pick('bootstrap.connecting'),
    'bootstrap.loading': pick('bootstrap.loading'),
    'bootstrap.cliMissing': pick('bootstrap.cliMissing'),
    'bootstrap.devServerWait': pick('bootstrap.devServerWait'),
    'bootstrap.offline': pick('bootstrap.offline'),
    'shell.connecting': pick('shell.connecting'),
    'shell.connected': pick('shell.connected'),
    'shell.offline': pick('shell.offline'),
  };
}
