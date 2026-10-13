// SPDX-License-Identifier: Apache-2.0
/**
 * Shell-level shortcut wiring (doc 14 §I.2 router + §I.4 ownership v1):
 * installs the ONE window router with the live `shortcutOverrides`, then
 * binds the shell-owned actions (open_settings, cycle_theme). The rest of
 * the action set binds with its owning surfaces (composer, sidebar) as they
 * land (registered, not silently dropped).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { installShortcutRouter, useKeybind } from '../lib/shortcuts/hooks.ts';
import { useSettingsStore } from '../lib/settings/store.ts';
import { useTheme } from './ThemeProvider.tsx';
import { listBuiltInThemes } from '../lib/theme/themes.ts';
import { isMac } from '../lib/platform.ts';
import { captureToChat } from '../lib/add-selection-to-chat.ts';

const SETTINGS_OPEN_EVENT = 'nnd:settings-open';

export const settingsOpenEventName = SETTINGS_OPEN_EVENT;

export function ShellShortcuts(): ReactNode {
  const overrides = useSettingsStore((state) => state.doc['shortcutOverrides'] as Record<string, string> | undefined);
  const themeApi = useTheme();
  const themeRef = useRef(themeApi);
  themeRef.current = themeApi;

  useEffect(() => {
    installShortcutRouter({ overrides: overrides ?? {}, mac: isMac() });
  }, [overrides]);

  useKeybind('open_settings', () => {
    window.dispatchEvent(new CustomEvent(SETTINGS_OPEN_EVENT));
  });
  useKeybind('cycle_theme', () => {
    cycleRegisteredTheme(themeRef.current);
  });
  // doc 06 Appendix B / §10.5: add-to-chat capture; with nothing selected it
  // just focuses the composer (the capture chain owns that behavior).
  useKeybind('add_selection_to_chat', () => { captureToChat(); });

  return null;
}

/** NOTES/14 C.1: cycle CURRENT-VARIANT themes in registration order. */
export function cycleRegisteredTheme(api: ReturnType<typeof useTheme>): void {
  const { theme, variant, setLightTheme, setDarkTheme } = api;
  const registered = listBuiltInThemes(variant);
  if (registered.length === 0) return;
  const index = registered.findIndex((entry) => entry.metadata.id === theme.metadata.id);
  const next = registered[(index + 1 + registered.length) % registered.length]!;
  if (variant === 'dark') setDarkTheme(next.metadata.id);
  else setLightTheme(next.metadata.id);
}
