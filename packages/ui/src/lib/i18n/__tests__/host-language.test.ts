// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Host-language detection leg (doc 14 §H.2/§H.4): __NOTNATIVE_HOST_LANGUAGE__
 * normalizes through the §H.1 rules, type-rejects junk, and the stored
 * preference beats the host seed (stored → host → en order pinned).
 */
import { describe, expect, it } from 'vitest';
import { detectInitialLocale, readHostLanguage } from '../runtime.ts';

describe('host language (§H.2 middle leg)', () => {
  it('normalizes host tags through the §H.1 rules', () => {
    window.__NOTNATIVE_HOST_LANGUAGE__ = 'fr-CA';
    expect(readHostLanguage()).toBe('fr');
    expect(detectInitialLocale()).toBe('fr');
    window.__NOTNATIVE_HOST_LANGUAGE__ = 'zh-hant';
    expect(readHostLanguage()).toBe('zh-TW');
  });

  it('rejects non-string host globals instead of crashing boot', () => {
    Object.assign(window, { __NOTNATIVE_HOST_LANGUAGE__: 42 });
    expect(readHostLanguage()).toBeNull();
    expect(detectInitialLocale()).toBe('en'); // falls through the chain
  });

  it('stored preference wins over the host seed (order: stored → host)', () => {
    window.__NOTNATIVE_HOST_LANGUAGE__ = 'fr-CA';
    window.localStorage.setItem('notnative.i18n.v1', JSON.stringify({ locale: 'de' }));
    expect(detectInitialLocale()).toBe('de'); // stored beats host
    window.localStorage.removeItem('notnative.i18n.v1');
    expect(detectInitialLocale()).toBe('fr'); // host beats en
    delete window.__NOTNATIVE_HOST_LANGUAGE__;
    expect(detectInitialLocale()).toBe('en');
  });
});
