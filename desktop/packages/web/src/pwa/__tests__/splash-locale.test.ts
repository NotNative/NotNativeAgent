// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeStoredLocale } from '@notnative/ui/lib/i18n/runtime.ts';
import { applyStoredLocaleToSplash } from '../splash-locale.ts';

afterEach(() => localStorage.clear());

describe('web startup splash locale', () => {
  it('speaks the stored locale before rendering the React app', () => {
    writeStoredLocale('fr');
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<div id="initial-loading-text">Starting NotNativeDesktop…</div>';

    applyStoredLocaleToSplash(document);

    expect(document.documentElement.lang).toBe('fr-FR');
    expect(document.getElementById('initial-loading-text')?.textContent).toBe('Chargement de NotNativeDesktop…');
  });

  it('leaves the default splash unchanged when no locale is stored', () => {
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<div id="initial-loading-text">Starting NotNativeDesktop…</div>';
    applyStoredLocaleToSplash(document);
    expect(document.documentElement.lang).toBe('en');
    expect(document.getElementById('initial-loading-text')?.textContent).toBe('Starting NotNativeDesktop…');
  });

  it('loads the small splash bootstrap module before the main app module', async () => {
    const html = await readFile(resolve(process.cwd(), 'index.html'), 'utf8');
    expect(html.indexOf('/src/pwa/splash-locale-entry.ts')).toBeLessThan(html.indexOf('/src/main.tsx'));
  });
});
