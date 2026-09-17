// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * ThemeProvider gates (Delta D8 + P5-2): `system` resolves via matchMedia and
 * FOLLOWS OS changes both ways; the light/dark THEME PAIR resolves the active
 * theme (doc 14 §E.1); intent-driven persistence lands only on user setters;
 * the single runtime style element carries both variant blocks (§E.4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { initializeRuntimeEndpoint } from '../../lib/runtime-switch.ts';
import { ThemeProvider, useTheme, type ThemeApi } from '../ThemeProvider.tsx';

const SCOPED_KEY = 'notnative.theme.v2:' + encodeURIComponent('url:http://theme.test');
initializeRuntimeEndpoint({ apiBaseUrl: 'http://theme.test' });

type ModeListener = (event: MediaQueryListEvent) => void;
let listeners: ModeListener[] = [];
let preferDark = true;
let container: HTMLDivElement | null = null;
let rootHandle: Root | null = null;
let reported: string | null = null;
const apiRef: { current: ThemeApi | null } = { current: null };
const variantRef: { current: string | null } = { current: null };

vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
  matches: preferDark,
  addEventListener: (_kind: string, listener: ModeListener) => { listeners.push(listener); },
  removeEventListener: (_kind: string, listener: ModeListener) => {
    listeners = listeners.filter((entry) => entry !== listener);
  },
})));

function ProbedTree(): null {
  const api = useTheme();
  apiRef.current = api;
  useEffect(() => { variantRef.current = api.variant; reported = api.variant; }, [api.variant]);
  return null;
}

function renderHarness(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  act(() => {
    rootHandle!.render(
      <ThemeProvider>
        <ProbedTree />
      </ThemeProvider>,
    );
  });
}

/** Flush generator effect + async custom-theme load inside act(). */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  listeners = [];
  preferDark = true;
  window.localStorage.clear();
  document.documentElement.className = '';
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  reported = null;
  apiRef.current = null;
  await act(async () => {
    renderHarness();
    await settle();
  });
});

afterEach(() => {
  act(() => { rootHandle?.unmount(); });
  container?.remove();
  container = null;
  rootHandle = null;
});

describe('ThemeProvider (Delta D8 re-verified)', () => {
  it('boots on the brand dark default with the .dark root class', () => {
    expect(reported).toBe('dark');
    expect(apiRef.current?.theme.metadata.id).toBe('notnative-dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('mode=system follows matchMedia both ways (D8)', () => {
    act(() => { apiRef.current?.setMode('system'); });
    expect(reported).toBe('dark');
    preferDark = false;
    act(() => {
      listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
    });
    expect(reported).toBe('light');
    preferDark = true;
    act(() => {
      listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    });
    expect(reported).toBe('dark');
  });
});

function snapshotThemeStorage(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key && /(themeMode|useSystem|selectedTheme|Light|Dark|lightTheme|darkTheme|splash)/u.test(key)) {
      snapshot[key] = window.localStorage.getItem(key) ?? '';
    }
  }
  return snapshot;
}

describe('write-intent guard (doc 14 §E.3 flip-flop)', () => {
  it('OS variant flips in system mode never write any theme key', async () => {
    act(() => { apiRef.current?.setMode('system'); });
    await settle();
    const before = snapshotThemeStorage();
    preferDark = false;
    act(() => {
      listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
    });
    expect(reported).toBe('light');
    expect(snapshotThemeStorage()).toEqual(before);
  });

  it('storage-event adoption applies locally but persists nothing', async () => {
    act(() => { apiRef.current?.setMode('dark'); });
    await settle();
    const before = snapshotThemeStorage();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', {
        key: SCOPED_KEY,
        newValue: JSON.stringify({ themeMode: 'light', lightThemeId: 'mono', darkThemeId: 'dracula' }),
      }));
    });
    await settle();
    expect(apiRef.current?.lightThemeId).toBe('mono'); // adopted in memory
    expect(snapshotThemeStorage()).toEqual(before); // but never written back
  });
});

describe('ThemeProvider theme pair + injection (P5-2, doc 14 §E.1/§E.4)', () => {
  it('keeps a TWO-variant pair: explicit light mode flips the active slot', async () => {
    act(() => { apiRef.current?.setMode('light'); });
    await settle();
    expect(apiRef.current?.lightThemeId).toBe('notnative-light');
    expect(apiRef.current?.darkThemeId).toBe('notnative-dark');
    expect(apiRef.current?.theme.metadata.id).toBe('notnative-light');
    const styleElement = document.getElementById('nnd-theme-variables');
    expect(styleElement?.textContent).toContain(':root:not(.dark)');
  });

  it('setDarkTheme swaps the resolved theme while keeping the mode', async () => {
    act(() => { apiRef.current?.setMode('dark'); });
    act(() => { apiRef.current?.setDarkTheme('dracula'); });
    await settle();
    expect(apiRef.current?.theme.metadata.id).toBe('dracula');
    expect(apiRef.current?.lightThemeId).toBe('notnative-light');
    expect(document.getElementById('nnd-theme-variables')?.textContent).toContain('--pr-open: #50fa7b;');
    expect(document.body.style.backgroundColor).toBe('rgb(40, 42, 54)');
  });

  it('persists the SCOPED preference document only under intent', async () => {
    act(() => { apiRef.current?.setMode('light'); });
    await settle();
    const stored = window.localStorage.getItem(SCOPED_KEY);
    expect(JSON.parse(stored!)).toEqual({
      themeMode: 'light',
      lightThemeId: 'notnative-light',
      darkThemeId: 'notnative-dark',
    });
    expect(window.localStorage.getItem('themeMode')).toBe('light'); // splash mirror still lands
    expect(window.localStorage.getItem('useSystemTheme')).toBe('false');
  });

  it('repaints browser chrome behind the theme', async () => {
    await settle();
    const meta = document.head.querySelector('meta[name="theme-color"]');
    expect(meta?.getAttribute('content')).toMatch(/^#/u);
    expect(document.body.style.backgroundColor).not.toBe('');
  });

  it('exposes the full 38-theme catalog for the pickers', () => {
    expect(apiRef.current?.themes.length).toBe(38);
    expect(apiRef.current?.themes.every((entry) => entry.name.length > 0)).toBe(true);
  });
});
