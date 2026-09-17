// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * ThemeProvider gates (Delta D8): `system` resolves via matchMedia and
 * FOLLOWS OS changes; `.dark`/`.light` root classes carry the token variant;
 * explicit modes store + apply; default is dark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRef } from 'react';
import { ThemeProvider, useTheme } from '../ThemeProvider.tsx';

type ModeListener = (event: MediaQueryListEvent) => void;
type ThemeApi = { mode: 'light' | 'dark' | 'system'; variant: 'light' | 'dark'; setMode: (mode: 'light' | 'dark' | 'system') => void };
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
  const variant = api.variant;
  useRef(true); // hooks stay unconditional for the invariant check
  apiRef.current = api;
  useEffect(() => { variantRef.current = variant; reported = variant; }, [variant]);
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

function setMode(mode: 'light' | 'dark' | 'system'): void {
  act(() => { apiRef.current?.setMode(mode); });
}

beforeEach(() => {
  listeners = [];
  preferDark = true;
  window.localStorage.clear();
  document.documentElement.className = '';
  reported = null;
  apiRef.current = null;
  document.body.innerHTML = '';
  act(() => {
    renderHarness();
  });
});

afterEach(() => {
  act(() => { rootHandle?.unmount(); });
  container?.remove();
  container = null;
  rootHandle = null;
});

describe('ThemeProvider (Delta D8)', () => {
  it('defaults to dark and applies the .dark root class', () => {
    expect(reported).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('explicit light follows the token .light block and persists', () => {
    setMode('light');
    expect(variantRef.current).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem('notnative.themeMode')).toBe('light');
  });

  it('mode=system resolves via matchMedia and FOLLOWS OS changes both ways', () => {
    setMode('system');
    expect(reported).toBe('dark'); // preferDark starts true
    preferDark = false;
    act(() => {
      listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
    });
    expect(reported).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    preferDark = true;
    act(() => {
      listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    });
    expect(reported).toBe('dark');
  });
});
