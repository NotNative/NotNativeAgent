// SPDX-License-Identifier: Apache-2.0
/**
 * Time formatting (doc 14 §J.1): `auto|12h|24h` → Intl hour12 with 2-digit
 * minutes, always the VIEWER's timezone (no tz picker; everything renders
 * in the viewer's local zone). Legacy IANA ids canonicalize on use (§J.1).
 * Money (§J.2) is USD-fixed with the active locale's grouping.
 */
import { useI18nStore } from '../i18n/store.ts';
import { BCP47ByLocale, type Locale } from '../i18n/runtime.ts';

export type TimeFormatPreference = 'auto' | '12h' | '24h';

function intlLocale(): string {
  return BCP47ByLocale[useI18nStore.getState().locale] ?? BCP47ByLocale.en;
}

export function formatTimeForPreference(
  timestamp: number,
  preference: TimeFormatPreference,
  options: { precision?: 'minute' | 'second'; hour?: 'numeric' | '2-digit'; fallback?: string } = {},
): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return options.fallback ?? '';
  const hour12 = preference === '12h' ? true : preference === '24h' ? false : undefined;
  const formatter = new Intl.DateTimeFormat(intlLocale(), {
    hour: options.hour ?? 'numeric',
    minute: '2-digit',
    ...(options.precision === 'second' ? { second: '2-digit' } : {}),
    hour12,
  });
  return formatter.format(date);
}

export function formatDateTimeForPreference(
  timestamp: number,
  preference: TimeFormatPreference,
  options: Intl.DateTimeFormatOptions & { hour?: 'numeric' | '2-digit' } = {},
): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const hour12 = preference === '12h' ? true : preference === '24h' ? false : undefined;
  const formatter = new Intl.DateTimeFormat(intlLocale(), {
    ...options,
    hour: options.hour ?? 'numeric',
    minute: '2-digit',
    hour12: options.hour12 ?? hour12,
  });
  return formatter.format(date);
}

const LEGACY_TIMEZONES: Record<string, string> = {
  'Europe/Kiev': 'Europe/Kyiv',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Enderbury': 'Pacific/Kanton',
};

/** Canonicalize legacy IANA ids (§J.1) when displaying zone names. */
export function canonicalizeTimezone(timezone: string): string {
  return LEGACY_TIMEZONES[timezone] ?? timezone;
}

/** §J.2 money: USD fixed, locale-grouped, 2 digits (4 below a cent). */
export function formatMoney(value: number, locale?: Locale): string {
  const tag = locale !== undefined ? BCP47ByLocale[locale] : intlLocale();
  const digits = Number.isFinite(value) && value > 0 && value < 0.01 ? 4 : 2;
  const formatter = new Intl.NumberFormat(tag, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return formatter.format(Number.isFinite(value) && value > 0 ? value : 0);
}
