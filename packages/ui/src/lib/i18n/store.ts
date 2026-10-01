// SPDX-License-Identifier: Apache-2.0
/**
 * i18n store (doc 14 §H.2 store.ts): English is synchronous; other locales
 * resolve through the partial catalogs (module-cached) — the switch applies
 * optimistically (old dictionary stays visible + `loadingLocale` marker),
 * then swaps; failure logs and falls back to the English dictionary
 * (storage credited back to en so a reload never boots into the failure).
 */
import { create } from 'zustand';
import en, { type Dictionary, type I18nKey } from './messages/en.ts';
import { PARTIAL_CATALOGS, dictionaryFor } from './messages/locales.ts';
import { BCP47ByLocale, DEFAULT_LOCALE, detectInitialLocale, writeStoredLocale, type Locale } from './runtime.ts';

const catalogCache = new Map<string, Dictionary>();
catalogCache.set(DEFAULT_LOCALE, en);

export interface I18nState {
  locale: Locale;
  dictionary: Dictionary;
  loadingLocale: Locale | null;
  setLocale: (locale: Locale) => void;
}

const initialLocale = detectInitialLocale();
const initialDictionary = dictionaryFor(initialLocale);
catalogCache.set(initialLocale, initialDictionary);
syncDocumentLanguage(initialLocale);

export const useI18nStore = create<I18nState>((set, get) => ({
  locale: initialLocale,
  dictionary: initialDictionary,
  loadingLocale: null,
  setLocale: (locale) => {
    if (locale === get().locale) return; // dedupe: no churn, no storage write
    try {
      const cached = catalogCache.get(locale);
      const dictionary = cached ?? dictionaryFor(locale);
      catalogCache.set(locale, dictionary);
      set({ locale, dictionary, loadingLocale: getLocaleMarker(locale) });
      writeStoredLocale(locale);
      syncDocumentLanguage(locale);
    } catch (error) {
      console.error?.('[i18n] catalog load failed; falling back to en', error);
      set({ locale: DEFAULT_LOCALE, dictionary: en, loadingLocale: null });
      writeStoredLocale(DEFAULT_LOCALE);
      syncDocumentLanguage(DEFAULT_LOCALE);
      return;
    }
    // Our catalogs are synchronous partials (delta E2); the async loader
    // contract remains for future dynamic bundles (log+fallback per §H.2).
    Promise.resolve()
      .then(() => {
        if (get().locale !== locale) return; // a newer switch won
        set({ loadingLocale: null });
      })
      .catch((error) => {
        if (get().locale !== locale) return;
        console.error?.('[i18n] locale load failed; falling back to en', error);
        set({ locale: DEFAULT_LOCALE, dictionary: en, loadingLocale: null });
        writeStoredLocale(DEFAULT_LOCALE);
        syncDocumentLanguage(DEFAULT_LOCALE);
      });
  },
}));

function syncDocumentLanguage(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = BCP47ByLocale[locale];
}

function getLocaleMarker(locale: Locale): Locale | null {
  return locale === DEFAULT_LOCALE ? null : locale;
}

/** `{name}` interpolation; missing params render the raw token (§H.3). */
export function translate(key: I18nKey, params?: Record<string, unknown>): string {
  const { dictionary } = useI18nStore.getState();
  const template = dictionary[key] ?? en[key] ?? String(key);
  if (params === undefined) return template;
  return interpolate(template, params);
}

export function interpolate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/gu, (token, name) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

// Re-exported so consumers never import the raw catalogs directly.
export { DEFAULT_LOCALE, PARTIAL_CATALOGS };
export type { I18nKey, Locale };
