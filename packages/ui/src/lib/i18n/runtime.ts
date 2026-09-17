// SPDX-License-Identifier: Apache-2.0
/**
 * i18n runtime (doc 14 §H): 12 locales, storage `notnative.i18n.v1`
 * (browser-global, NOT per-runtime — the locale follows the browser
 * profile), detection chain stored → host-injected global → `en`, and the
 * §H.1 normalizer rules for browser language tags.
 */
export const LOCALES = [
  'en',
  'de',
  'fr',
  'zh-CN',
  'zh-TW',
  'uk',
  'es',
  'pt-BR',
  'ko',
  'pl',
  'ja',
  'tr',
] as const;

export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const I18N_STORAGE_KEY = 'notnative.i18n.v1';
export const HOST_LANGUAGE_GLOBAL = '__NOTNATIVE_HOST_LANGUAGE__';export const BCP47ByLocale: Record<Locale, string> = {
  en: 'en-US',
  de: 'de-DE',
  fr: 'fr-FR',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
  uk: 'uk-UA',
  es: 'es-ES',
  'pt-BR': 'pt-BR',
  ko: 'ko-KR',
  pl: 'pl-PL',
  ja: 'ja-JP',
  tr: 'tr-TR',
};

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** §H.1 normalizer: browser tags → our Locale ids (prefix matching; the
 * `pt` family collapses to pt-BR per NOTES/14 §C). */
export function normalizeLocaleTag(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh-hans')) return 'zh-CN';
  if (lower.startsWith('zh-hant') || lower.startsWith('zh-tw')) return 'zh-TW';
  if (lower === 'pt-br' || lower.startsWith('pt-br')) return 'pt-BR';
  if (lower === 'ua') return 'uk';
  const exact = LOCALES.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;
  const base = lower.split('-')[0] ?? lower;
  const byPrefix = LOCALES.find((locale) => locale.toLowerCase().split('-')[0] === base);
  return byPrefix ?? null;
}

export function readStoredLocale(storage?: { getItem(key: string): string | null }): Locale | null {
  try {
    const store = storage ?? window.localStorage;
    const raw = store.getItem(I18N_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { locale?: unknown };
    return isLocale(parsed.locale) ? parsed.locale : null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: Locale, storage?: { setItem(key: string, value: string): void }): void {
  try {
    const store = storage ?? window.localStorage;
    store.setItem(I18N_STORAGE_KEY, JSON.stringify({ locale }));
  } catch { /* storage unavailable — locale stays session-only */ }
}

export function readHostLanguage(): Locale | null {
  if (typeof window === 'undefined') return null;
  const tag = window.__NOTNATIVE_HOST_LANGUAGE__;
  return typeof tag === 'string' ? normalizeLocaleTag(tag) : null;
}

/** §H.2 detection: stored → host-injected (e.g. VS Code) → `en`. */
export function detectInitialLocale(): Locale {
  return readStoredLocale() ?? readHostLanguage() ?? DEFAULT_LOCALE;
}

/** Endonym labels for the locale picker (language-invariant). */
export const NATIVE_LABELS: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  uk: 'Українська',
  es: 'Español',
  'pt-BR': 'Português (Brasil)',
  ko: '한국어',
  pl: 'Polski',
  ja: '日本語',
  tr: 'Türkçe',
};
