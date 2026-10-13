// SPDX-License-Identifier: Apache-2.0
/**
 * P0 stub retired (P5-4): the real i18n layer lives in lib/i18n/ (doc 14
 * §H); this module keeps the historical import path for the shell
 * consumers. New code imports from lib/i18n/context.tsx.
 */
export {
  I18nProvider,
  useI18n,
  type I18nApi,
} from '../lib/i18n/context.tsx';
export type { I18nKey } from '../lib/i18n/messages/en.ts';
