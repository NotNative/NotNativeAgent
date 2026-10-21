// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeStoredLocale } from '@notnative/ui/lib/i18n/runtime.ts';
import { applyStoredLocaleToSplash } from '../splash-locale.ts';

afterEach(() => {
  localStorage.clear();
  delete window.__NOTNATIVE_LOCAL_ORIGIN__;
  delete window.__notnativeAppReady;
});

async function inlineScripts(): Promise<string[]> {
  const html = await readFile(resolve(process.cwd(), 'index.html'), 'utf8');
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1] ?? '');
}

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

  it('uses the system light preference on first paint when no theme is stored', async () => {
    const [bootstrap] = await inlineScripts();
    if (!bootstrap) throw new Error('missing splash theme bootstrap');
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: false }) as MediaQueryList;
    document.documentElement.className = 'dark';
    try {
      new Function('window', 'document', 'localStorage', 'console', bootstrap)(window, document, localStorage, console);
      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(document.documentElement.getAttribute('data-nn-splash-variant')).toBe('light');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('still resolves the system theme when storage is unavailable', async () => {
    const [bootstrap] = await inlineScripts();
    if (!bootstrap) throw new Error('missing splash theme bootstrap');
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: false }) as MediaQueryList;
    document.documentElement.className = 'dark';
    const unavailableStorage = { getItem: () => { throw new Error('storage blocked'); } };
    const warnings: unknown[] = [];
    try {
      new Function('window', 'document', 'localStorage', 'console', bootstrap)(
        window, document, unavailableStorage, { warn: (...args: unknown[]) => warnings.push(args) },
      );
      expect(document.documentElement.classList.contains('light')).toBe(true);
      expect(warnings).toHaveLength(1);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('offers a retry after a stalled packaged desktop boot', async () => {
    const scripts = await inlineScripts();
    const fallback = scripts.at(-1);
    expect(fallback).toBeDefined();
    document.body.innerHTML = '<div id="initial-loading"><div id="initial-loading-text">Starting…</div><button id="initial-loading-retry" hidden>Reload</button></div>';
    window.__NOTNATIVE_LOCAL_ORIGIN__ = 'http://127.0.0.1:3000';
    let onTimeout: (() => void) | undefined;
    const schedule = (callback: () => void, ms: number) => {
      expect(ms).toBe(10_000);
      onTimeout = callback;
    };
    new Function('window', 'document', 'setTimeout', fallback ?? '')(window, document, schedule);
    expect(onTimeout).toBeDefined();
    onTimeout?.();
    expect(document.getElementById('initial-loading')).not.toBeNull();
    expect(document.getElementById('initial-loading-text')?.textContent).toContain('taking longer');
    expect((document.getElementById('initial-loading-retry') as HTMLButtonElement).hidden).toBe(false);
  });
});
