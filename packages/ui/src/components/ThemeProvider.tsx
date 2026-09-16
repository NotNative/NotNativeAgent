import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

// Delta P0: `system` variant resolution via matchMedia lands with doc 14 (P5);
// until then `system` renders the dark variant. Default mode is dark.
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
  const variant: Variant = mode === 'light' ? 'light' : 'dark';

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

function readStoredMode(): Mode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {}
  return 'dark';
}
