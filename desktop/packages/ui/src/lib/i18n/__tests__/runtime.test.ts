// SPDX-License-Identifier: Apache-2.0
/** i18n runtime gates (doc 14 §H.1): 12 locales, normalizer rules, the
 * stored → host → en detection chain, and browser-global storage. */
import { describe, expect, it } from 'vitest';
import {
  LOCALES,
  NATIVE_LABELS,
  detectInitialLocale,
  normalizeLocaleTag,
  readHostLanguage,
  readStoredLocale,
  writeStoredLocale,
} from '../runtime.ts';

interface FakeStorage {
  data: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function fakeStorage(seed: Record<string, string> = {}): FakeStorage {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  };
}

describe('locale registry + normalizer (§H.1)', () => {
  it('registers exactly 12 locales with en default and endonym labels', () => {
    expect(LOCALES.length).toBe(12);
    expect(LOCALES[0]).toBe('en');
    expect(Object.keys(NATIVE_LABELS).length).toBe(12);
    expect(NATIVE_LABELS['pt-BR']).toBe('Português (Brasil)');
  });

  it('normalizes browser tags: zh-hans/zh-hant/pt-br/ua/prefix rules', () => {
    expect(normalizeLocaleTag('zh-hans-CN')).toBe('zh-CN');
    expect(normalizeLocaleTag('zh-hant')).toBe('zh-TW');
    expect(normalizeLocaleTag('zh-TW')).toBe('zh-TW');
    expect(normalizeLocaleTag('zh')).toBe('zh-CN'); // LOCALES order: zh-CN precedes zh-TW
    expect(normalizeLocaleTag('pt-BR')).toBe('pt-BR');
    expect(normalizeLocaleTag('pt')).toBe('pt-BR'); // §H.1 "pt(br)→pt-BR" (+ NOTES/14 §C call)
    expect(normalizeLocaleTag('pt-PT')).toBe('pt-BR'); // blunt collapse, recorded
    expect(normalizeLocaleTag('ua')).toBe('uk');
    expect(normalizeLocaleTag('fr-CA')).toBe('fr');
    expect(normalizeLocaleTag('de')).toBe('de');
    expect(normalizeLocaleTag('es-419')).toBe('es'); // regional variants collapse to base
    expect(normalizeLocaleTag('en-GB')).toBe('en');
    expect(normalizeLocaleTag('xx-UNKNOWN')).toBeNull(); // caller falls back to en
  });

  it('keeps the LOCALES order load-bearing (bare-zh target + picker order)', () => {
    expect([...LOCALES]).toEqual(['en', 'de', 'fr', 'zh-CN', 'zh-TW', 'uk', 'es', 'pt-BR', 'ko', 'pl', 'ja', 'tr']);
  });
});

describe('detection chain (§H.2: stored → host → en)', () => {
  it('reads the stored locale first, validates shape, tolerates corruption', () => {
    const store = fakeStorage({});
    expect(readStoredLocale(store)).toBeNull();
    store.setItem('notnative.i18n.v1', JSON.stringify({ locale: 'fr' }));
    expect(readStoredLocale(store)).toBe('fr');
    store.setItem('notnative.i18n.v1', JSON.stringify({ locale: 'klingon' }));
    expect(readStoredLocale(store)).toBeNull();
    store.setItem('notnative.i18n.v1', '{corrupt');
    expect(readStoredLocale(store)).toBeNull();
  });

  it('writes the storage document under the versioned key', () => {
    const store = fakeStorage({});
    writeStoredLocale('pt-BR', store);
    expect(JSON.parse(store.getItem('notnative.i18n.v1')!)).toEqual({ locale: 'pt-BR' });
  });

  it('host-injected language participates (VS Code seed path)', () => {
    expect(readHostLanguage()).toBeNull(); // jsdom-free node: no window global set
  });
});

describe('detectInitialLocale', () => {
  it('falls back to en when nothing is stored/host-injected', () => {
    expect(detectInitialLocale()).toBe('en');
  });
});
