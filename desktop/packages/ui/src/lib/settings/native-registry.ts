// SPDX-License-Identifier: Apache-2.0
import { getSettingsField } from './registry.ts';
import { getBuiltInTheme } from '../theme/themes.ts';
import { parseCombo, UNASSIGNED_SHORTCUT } from '../shortcuts/bindings.ts';
import { shortcutDecl } from '../shortcuts/schema.ts';

export const NATIVE_SETTINGS_PAGES = [
  { slug: 'general', title: 'General', group: 'Preferences', keywords: 'about version browser tray startup' },
  { slug: 'appearance', title: 'Appearance', group: 'Preferences', keywords: 'theme colors font size scale' },
  { slug: 'chat', title: 'Conversations', group: 'Preferences', keywords: 'chat composer messages' },
  { slug: 'notifications', title: 'Notifications', group: 'Preferences', keywords: 'completion indicator celebration' },
  { slug: 'shortcuts', title: 'Keyboard', group: 'Preferences', keywords: 'shortcuts keybind rebind conflicts' },
  { slug: 'providers', title: 'Providers and models', group: 'Agent', keywords: 'api key endpoint profile credential model route' },
  { slug: 'agent-policy', title: 'Agent policy', group: 'Agent', keywords: 'review permissions instructions recovery retry delegation subagent cancellation persistence' },
  { slug: 'agent-context', title: 'Memory and context', group: 'Agent', keywords: 'memory context compression compaction budgets instructions sources' },
  { slug: 'operations-tools', title: 'Tools and integrations', group: 'Capabilities', keywords: 'mcp tools connections references deadlines' },
  { slug: 'skills.installed', title: 'Skills and hooks', group: 'Capabilities', keywords: 'skills hooks instructions catalog bundles provenance' },
  { slug: 'operations-search', title: 'Search and browsing', group: 'Capabilities', keywords: 'searxng web search fetch trust playwright chromium browser' },
  { slug: 'operations-services', title: 'Services and updates', group: 'System', keywords: 'desktop gateway opencode compatibility service updates tray restart login' },
  { slug: 'operations-data', title: 'Data and diagnostics', group: 'System', keywords: 'data diagnostics storage export archives conversations files usage environment' },
  { slug: 'native-configuration', title: 'Advanced', group: 'System', keywords: 'configuration trust secrets mcp login gateway opencode services updates diagnostics' },
] as const;

/** Invariant: this allowlist contains presentation preferences only; it cannot change execution authority. */
export const NATIVE_PREFERENCE_DEFAULTS: Record<string, unknown> = {
  themeId: 'notnative-dark', useSystemTheme: true,
  lightThemeId: 'notnative-light', darkThemeId: 'notnative-dark',
  fontSize: 100,
  enterToSend: true, enterToSendConfigured: false, inputSpellcheckEnabled: true,
  wideChatLayoutEnabled: false, userMessageRenderingMode: 'markdown',
  celebrationPreference: 'off', shortcutOverrides: {},
  favoriteModels: [], hiddenModels: [],
};
export const NATIVE_SHORTCUT_IDS = ['open_settings', 'cycle_theme', 'focus_input', 'new_chat', 'toggle_sidebar'] as const;

export function parseNativePreferencePatch(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > Object.keys(NATIVE_PREFERENCE_DEFAULTS).length) return null;
  const result: Record<string, unknown> = {};
  for (const [key, input] of entries) {
    if (!Object.hasOwn(NATIVE_PREFERENCE_DEFAULTS, key)) return null;
    const parsed = getSettingsField(key)?.parse(input);
    if (parsed === null || parsed === undefined || JSON.stringify(parsed) !== JSON.stringify(input)) return null;
    if (['themeId', 'lightThemeId', 'darkThemeId'].includes(key)) {
      const theme = getBuiltInTheme(String(parsed));
      if (!theme || (key === 'lightThemeId' && theme.metadata.variant !== 'light') || (key === 'darkThemeId' && theme.metadata.variant !== 'dark')) return null;
    }
    if (key === 'shortcutOverrides') {
      for (const [id, binding] of Object.entries(parsed as Record<string, string>)) {
        if (!NATIVE_SHORTCUT_IDS.includes(id as typeof NATIVE_SHORTCUT_IDS[number]) && !(binding === UNASSIGNED_SHORTCUT && shortcutDecl(id)?.customizable)) return null;
        try { if (binding !== UNASSIGNED_SHORTCUT && parseCombo(binding).chords.some(chord => chord.prefix)) return null; }
        catch { return null; }
      }
    }
    if (key === 'favoriteModels' || key === 'hiddenModels') {
      if ((parsed as string[]).some(ref => ref.length > 321 || !/^[A-Za-z0-9_-]{1,64}\/.{1,256}$/u.test(ref))) return null;
    }
    result[key] = parsed;
  }
  return result;
}
