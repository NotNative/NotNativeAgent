// SPDX-License-Identifier: Apache-2.0
/**
 * ThemeProvider (doc 14 §E/Delta D8): `system` resolves via matchMedia and
 * follows OS changes; the variant is applied as `.dark`/`.light` root classes
 * (the token default block keys off those selectors). The chosen mode
 * persists under `notnative.themeMode`.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'notnative.themeMode';
type Mode = 'system' | 'light' | 'dark';
type Variant = 'light' | 'dark';

interface ThemeApi {
  mode: Mode;
  variant: Variant;
  setMode: (mode: Mode) => void;
}

const ThemeContext = createContext<ThemeApi | null>(null);

export function ThemeProvider({ children }: { children?: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(readStoredMode);
  const [systemVariant, setSystemVariant] = useState<Variant>(detectSystemVariant);
  const variant: Variant = mode === 'system' ? systemVariant : (mode as Variant);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemVariant(event.matches ? 'dark' : 'light');
    };
    setSystemVariant(query.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', variant === 'dark');
    root.classList.toggle('light', variant === 'light');
    root.dataset.nndVariant = variant;
    root.style.colorScheme = variant;
  }, [variant]);

  const setMode = (next: Mode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  };

  return <ThemeContext value={{ mode, variant, setMode }}>{children}</ThemeContext>;
}

export function useTheme(): ThemeApi {
  const api = useContext(ThemeContext);
  if (!api) throw new Error('useTheme outside ThemeProvider');
  return api;
}

function detectSystemVariant(): Variant {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredMode(): Mode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {}
  return 'dark';
}
