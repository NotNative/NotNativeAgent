// SPDX-License-Identifier: Apache-2.0
/**
 * ThemeSystemContext equivalent (doc 14 §E.1/§E.3/§E.4): mode + light/dark
 * pair (NEVER a single toggle — a theme is always a two-variant pair),
 * runtimeKey-scoped persistence with write-intent flag, system-mode
 * matchMedia following, single style-element injection with transition
 * suppression (two frames), browser chrome repaint, custom-theme reload.
 * Embedded/VS Code sync surfaces are deferred (NOTES/14 E4).
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  DEFAULT_THEME_PREFERENCES,
  readThemePreferences,
  subscribeThemeStorageChanges,
  writeThemeMirror,
  writeThemePreferences,
  type ThemeMode,
  type ThemePreferences,
} from '../lib/theme/storage.ts';
import { CSSVariableGenerator } from '../lib/theme/css-generator.ts';
import { fetchCustomThemes } from '../lib/theme/custom.ts';
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  getBuiltInTheme,
  getDefaultBuiltInTheme,
  listBuiltInThemes,
} from '../lib/theme/themes.ts';
import type { Theme, ThemeVariant } from '../lib/theme/types.ts';

export interface ThemeTitle {
  id: string;
  name: string;
  variant: ThemeVariant;
}

export interface ThemeApi {
  mode: ThemeMode;
  variant: ThemeVariant;
  theme: Theme;
  lightThemeId: string;
  darkThemeId: string;
  themes: ThemeTitle[];
  themesLoading: boolean;
  setMode: (mode: ThemeMode) => void;
  setLightTheme: (id: string) => void;
  setDarkTheme: (id: string) => void;
  reloadThemes: () => Promise<void>;
}

const SWITCHING_CLASS = 'nnd-theme-switching';

const ThemeContext = createContext<ThemeApi | null>(null);

export function ThemeProvider({ children }: { children?: ReactNode }) {
  const [prefs, setPrefs] = useState<ThemePreferences>(() => readThemePreferences() ?? DEFAULT_THEME_PREFERENCES);
  const [customThemes, setCustomThemes] = useState<Theme[]>([]);
  const [themesLoading, setThemesLoading] = useState(true);
  const [systemDark, setSystemDark] = useState<boolean>(prefersDark);

  const variant: ThemeVariant = prefs.themeMode === 'system' ? (systemDark ? 'dark' : 'light') : prefs.themeMode;
  const catalog = useMemo(() => catalogFor(customThemes), [customThemes]);
  const theme = useMemo(() => resolveTheme(prefs, variant, catalog), [prefs, variant, catalog]);

  // Persistence rides the setter (§E.3 write intent): adoption paths and OS
  // flips never reach it, so no echo/flip-flop writes are possible by design.
  const prefsRef = useRef(prefs);
  const catalogRef = useRef(catalog);
  prefsRef.current = prefs;
  catalogRef.current = catalog;

  const commit = (next: ThemePreferences): void => {
    const nextVariant: ThemeVariant = next.themeMode === 'system'
      ? (prefersDark() ? 'dark' : 'light')
      : next.themeMode;
    if (writeThemePreferences(next)) {
      writeThemeMirror(next, splashColors(next, catalogRef.current), nextVariant);
    }
    setPrefs(next);
  };

  useEffect(() => listenSystemVariant(setSystemDark), []);
  useEffect(() => subscribeThemeStorageChanges((adopted) => {
    if (adopted) setPrefs(adopted); // adoption: never re-persisted (no intent)
  }), []);
  useEffect(() => {
    const darkPair = resolveSlot(prefs.darkThemeId, catalog, true);
    return applyTheme(theme, darkPair.colors.surface.background);
  }, [theme, prefs.darkThemeId, catalog]);
  useEffect(() => loadInitialCustoms(setCustomThemes, setThemesLoading), []);

  const api: ThemeApi = {
    mode: prefs.themeMode,
    variant,
    theme,
    lightThemeId: prefs.lightThemeId,
    darkThemeId: prefs.darkThemeId,
    themes: catalog.map((entry) => ({
      id: entry.metadata.id,
      name: entry.metadata.name,
      variant: entry.metadata.variant,
    })),
    themesLoading,
    setMode: (mode) => commit({ ...prefsRef.current, themeMode: mode }),
    setLightTheme: (id) => commit({ ...prefsRef.current, lightThemeId: id }),
    setDarkTheme: (id) => commit({ ...prefsRef.current, darkThemeId: id }),
    reloadThemes: () => reloadThemesAction(setCustomThemes, setThemesLoading),
  };

  return <ThemeContext value={api}>{children}</ThemeContext>;
}

/** §E.6 Reload action: ≥500 ms spinner floor so the flicker is readable. */
async function reloadThemesAction(
  setCustomThemes: (themes: Theme[]) => void,
  setThemesLoading: (loading: boolean) => void,
): Promise<void> {
  setThemesLoading(true);
  const started = Date.now();
  try {
    const loaded = await fetchCustomThemes();
    await new Promise((done) => setTimeout(done, Math.max(0, 500 - (Date.now() - started))));
    setCustomThemes(loaded);
  } finally {
    setThemesLoading(false);
  }
}

function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** §E.1: on `system`, prefers-color-scheme is live-listened (both ways, D8). */
function listenSystemVariant(setSystemDark: (dark: boolean) => void): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  setSystemDark(query.matches);
  const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function splashColors(prefs: ThemePreferences, catalog: Theme[]): {
  bgLight: string; fgLight: string; bgDark: string; fgDark: string;
} {
  const light = resolveSlot(prefs.lightThemeId, catalog, false).colors.surface;
  const dark = resolveSlot(prefs.darkThemeId, catalog, true).colors.surface;
  return { bgLight: light.background, fgLight: light.foreground, bgDark: dark.background, fgDark: dark.foreground };
}

function resolveSlot(id: string, catalog: Theme[], dark: boolean): Theme {
  return catalog.find((entry) => entry.metadata.id === id) ?? getBuiltInTheme(id) ?? getDefaultBuiltInTheme(dark);
}

/** §E.4 step 1–3: style-element swap, `nnd-theme-switching` for two frames. */
function applyTheme(theme: Theme, darkBackground: string): () => void {
  const root = document.documentElement;
  root.classList.add(SWITCHING_CLASS);
  const frames = scheduleFramePair(() => root.classList.remove(SWITCHING_CLASS));
  CSSVariableGenerator.apply(theme);
  updateBrowserChrome(theme.colors.surface.background, darkBackground);
  return () => frames.cancel();
}

/** §E.4 step 5: plain AND media-matched theme-color metas, patched in place. */
function updateBrowserChrome(background: string, darkBackground: string): void {
  document.body.style.backgroundColor = background;
  upsertMeta('meta[name="theme-color"]:not([media])', [['name', 'theme-color']], background);
  upsertMeta(
    'meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
    [['name', 'theme-color'], ['media', '(prefers-color-scheme: dark)']],
    darkBackground,
  );
}

function upsertMeta(selector: string, attrs: [string, string][], content: string): void {
  let meta = document.head.querySelector(selector) as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement('meta');
    for (const [key, value] of attrs) meta.setAttribute(key, value);
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', content);
}

function loadInitialCustoms(
  setCustomThemes: (themes: Theme[]) => void,
  setThemesLoading: (loading: boolean) => void,
): () => void {
  let cancelled = false;
  fetchCustomThemes()
    .then((loaded) => {
      if (!cancelled) {
        setCustomThemes(loaded);
        setThemesLoading(false);
      }
    })
    .catch(() => {
      if (!cancelled) setThemesLoading(false);
    });
  return () => {
    cancelled = true;
  };
}

/** §E.7 merge order: custom themes override built-ins with the same id. */
function catalogFor(custom: Theme[]): Theme[] {
  const byId = new Map<string, Theme>();
  for (const entry of listBuiltInThemes()) byId.set(entry.metadata.id, entry);
  for (const entry of custom) byId.set(entry.metadata.id, entry);
  return [...byId.values()];
}

function resolveTheme(prefs: ThemePreferences, variant: ThemeVariant, catalog: Theme[]): Theme {
  const wanted = prefs.themeMode === 'light'
    ? prefs.lightThemeId
    : prefs.themeMode === 'dark'
      ? prefs.darkThemeId
      : variant === 'dark'
        ? prefs.darkThemeId
        : prefs.lightThemeId;
  const found = catalog.find((entry) => entry.metadata.id === wanted) ?? getBuiltInTheme(wanted);
  if (found) return found;
  return getDefaultBuiltInTheme(prefersDark());
}

/** Two-frame rAF pair (setTimeout pairs in non-visual hosts). */
function scheduleFramePair(onDone: () => void): { cancel: () => void } {
  const schedule = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame
    : ((cb: FrameRequestCallback): number => window.setTimeout(() => cb(0), 0)) as typeof window.requestAnimationFrame;
  const cancelFrame = typeof window.cancelAnimationFrame === 'function'
    ? window.cancelAnimationFrame
    : ((id: number): void => clearTimeout(id)) as typeof window.cancelAnimationFrame;
  let second = 0;
  const first = schedule(() => {
    second = schedule(onDone);
  });
  return { cancel: (): void => { cancelFrame(first); cancelFrame(second); } };
}

export function useTheme(): ThemeApi {
  const api = useContext(ThemeContext);
  if (!api) throw new Error('useTheme outside ThemeProvider');
  return api;
}

export { DEFAULT_LIGHT_THEME_ID, DEFAULT_DARK_THEME_ID };
