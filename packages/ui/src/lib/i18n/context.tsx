// SPDX-License-Identifier: Apache-2.0
/**
 * I18nProvider (doc 14 §H.2 context.tsx/react-context): supplies
 * {t, locale, locales, setLocale, label}; `t(key, params?)` resolves the
 * active dictionary → en → the key itself, then interpolates {param}
 * placeholders. useI18n throws outside the provider.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useI18nStore, translate } from './store.ts';
import { LOCALES, NATIVE_LABELS } from './runtime.ts';
import type { I18nKey, Dictionary } from './messages/en.ts';
import type { Locale } from './runtime.ts';

export interface I18nApi {
  t: (key: I18nKey, params?: Record<string, unknown>) => string;
  locale: Locale;
  locales: readonly Locale[];
  setLocale: (locale: Locale) => void;
  label: (locale: Locale) => string;
}

const I18nContext = createContext<I18nApi | null>(null);

const locales = LOCALES;
const label = (locale: Locale): string => NATIVE_LABELS[locale];

export function I18nProvider({ children }: { children?: ReactNode }) {
  const locale = useI18nStore((state) => state.locale);
  const loadingLocale = useI18nStore((state) => state.loadingLocale);
  const setLocale = useI18nStore((state) => state.setLocale);
  const dictionary = useI18nStore((state) => state.dictionary); // subscribe: re-render on locale swap
  void dictionary;
  const api: I18nApi = useMemo(
    () => ({
      t: translate,
      locale: loadingLocale ?? locale,
      locales,
      setLocale,
      label,
    }),
    [locale, loadingLocale, setLocale],
  );
  return <I18nContext value={api}>{children}</I18nContext>;
}

export function useI18n(): I18nApi {
  const api = useContext(I18nContext);
  if (!api) throw new Error('useI18n outside I18nProvider');
  return api;
}

export type { I18nKey, Dictionary } from './messages/en.ts';
export type { Locale } from './runtime.ts';
