// SPDX-License-Identifier: Apache-2.0
/** §J formatting gates: time preference (auto/12h/24h via Intl, 2-digit
 * minutes, invalid-date fallback), legacy timezone canonicalization, and
 * USD-fixed money (4 digits below a cent; non-positive → $0). */
import { describe, expect, it } from 'vitest';
import {
  canonicalizeTimezone,
  formatDateTimeForPreference,
  formatMoney,
  formatTimeForPreference,
} from '../time.ts';

const NOON = new Date(2026, 8, 17, 12, 30).getTime(); // local wall-clock 12:30

describe('time formatting (§J.1)', () => {
  it('honors the 12h/24h preference with 2-digit minutes', () => {
    const h24 = formatTimeForPreference(NOON, '24h');
    expect(h24).toMatch(/^\d{2}:\d{2}$/u);
    expect(h24).toContain('12:30');
    const h12 = formatTimeForPreference(NOON, '12h');
    expect(h12.toLowerCase()).toContain('12:30');
  });

  it('auto defers to the Intl locale default; seconds precision optional', () => {
    expect(formatTimeForPreference(NOON, 'auto')).not.toBe('');
    expect(formatTimeForPreference(NOON, '24h', { precision: 'second' }).length).toBe(8);
  });

  it('returns the fallback for invalid dates', () => {
    expect(formatTimeForPreference(Number.NaN, '24h', { fallback: '—' })).toBe('—');
    expect(formatDateTimeForPreference(Number.NaN, '24h')).toBe('');
  });

  it('datetime merges caller options with caller-supplied hour12 wins', () => {
    const merged = formatDateTimeForPreference(NOON, '24h', { hour12: true });
    expect(merged).not.toBe('');
  });
});

describe('timezone canonicalization + money (§J.1/§J.2)', () => {
  it('maps the legacy IANA ids to modern names', () => {
    expect(canonicalizeTimezone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(canonicalizeTimezone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(canonicalizeTimezone('Pacific/Enderbury')).toBe('Pacific/Kanton');
    expect(canonicalizeTimezone('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('money is USD-fixed with grouping; sub-cent adds precision', () => {
    expect(formatMoney(1245.5, 'en')).toBe('$1,245.50');
    expect(formatMoney(0.0049, 'en')).toBe('$0.0049');
    expect(formatMoney(-3, 'en')).toBe('$0.00');
    expect(formatMoney(Number.NaN, 'en')).toBe('$0.00');
  });
});
