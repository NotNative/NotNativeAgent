// SPDX-License-Identifier: Apache-2.0
/** The active product locale as a BCP 47 tag for Intl formatters. */
import { useI18nStore } from './store.ts';
import { BCP47ByLocale } from './runtime.ts';

export function getCurrentIntlLocale(): string {
  return BCP47ByLocale[useI18nStore.getState().locale] ?? BCP47ByLocale.en;
}

/** React subscription for components whose rendered values use Intl output. */
export function useCurrentIntlLocale(): string {
  const locale = useI18nStore((state) => state.locale);
  return BCP47ByLocale[locale] ?? BCP47ByLocale.en;
}
