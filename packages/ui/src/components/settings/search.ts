// SPDX-License-Identifier: Apache-2.0
/**
 * Settings search index (doc 14 §G.6): static item catalog with stable ids
 * (the `settingsItem` anchors), page slugs, i18n titles, and keywords.
 * Availability mirrors render guards (VS Code/mobile hang off surface — the
 * available() hooks live per surface when those land).
 */
import type { I18nKey } from '../../lib/i18n/messages/en.ts';

export interface SettingsSearchItem {
  id: string;
  page: SettingsPageSlug;
  titleKey: I18nKey;
  keywords: string;
}

export type SettingsPageSlug =
  | 'general'
  | 'appearance'
  | 'chat'
  | 'notifications'
  | 'sessions'
  | 'shortcuts'
  | 'projects'
  | 'remote-instances'
  | 'tunnel'
  | 'git'
  | 'providers'
  | 'native-configuration'
  | 'native-tui'
  | 'native-routes'
  | 'agents'
  | 'behavior'
  | 'commands'
  | 'mcp'
  | 'plugins'
  | 'magic-prompts'
  | 'snippets'
  | 'skills.installed'
  | 'skills.catalog'
  | 'integrations'
  | 'usage';

/** Pages with real content in this build; the rest render landing notes. */
export const BUILT_PAGE_SLUGS: readonly SettingsPageSlug[] = [
  'general',
  'appearance',
  'chat',
  'notifications',
  'sessions',
  'shortcuts',
  'remote-instances',
  'providers',
  'native-configuration',
  'native-tui',
  'native-routes',
  'agents',
  'mcp',
  'skills.catalog',
  'skills.installed',
];

export function isBuiltPage(slug: SettingsPageSlug): boolean {
  return (BUILT_PAGE_SLUGS as readonly string[]).includes(slug);
}

export const SETTINGS_PAGE_ORDER: { slug: SettingsPageSlug; group: 'general' | 'projects' | 'opencode' | 'content'; titleKey: I18nKey }[] = [
  { slug: 'general', group: 'general', titleKey: 'settings.page.general.title' },
  { slug: 'appearance', group: 'general', titleKey: 'settings.page.appearance.title' },
  { slug: 'chat', group: 'general', titleKey: 'settings.page.chat.title' },
  { slug: 'notifications', group: 'general', titleKey: 'settings.page.notifications.title' },
  { slug: 'sessions', group: 'general', titleKey: 'settings.page.sessions.title' },
  { slug: 'shortcuts', group: 'general', titleKey: 'settings.page.shortcuts.title' },
  { slug: 'usage', group: 'general', titleKey: 'settings.page.usage.title' },
  { slug: 'integrations', group: 'general', titleKey: 'settings.page.integrations.title' },
  { slug: 'projects', group: 'projects', titleKey: 'settings.page.projects.title' },
  { slug: 'remote-instances', group: 'projects', titleKey: 'settings.page.remoteInstances.title' },
  { slug: 'tunnel', group: 'projects', titleKey: 'settings.page.tunnel.title' },
  { slug: 'git', group: 'projects', titleKey: 'settings.page.git.title' },
  { slug: 'providers', group: 'opencode', titleKey: 'settings.page.providers.title' },
  { slug: 'native-configuration', group: 'opencode', titleKey: 'settings.page.nativeConfiguration.title' },
  { slug: 'native-tui', group: 'opencode', titleKey: 'settings.page.nativeTui.title' },
  { slug: 'native-routes', group: 'opencode', titleKey: 'settings.page.nativeRoutes.title' },
  { slug: 'agents', group: 'opencode', titleKey: 'settings.page.agents.title' },
  { slug: 'behavior', group: 'opencode', titleKey: 'settings.page.behavior.title' },
  { slug: 'commands', group: 'opencode', titleKey: 'settings.page.commands.title' },
  { slug: 'mcp', group: 'opencode', titleKey: 'settings.page.mcp.title' },
  { slug: 'plugins', group: 'opencode', titleKey: 'settings.page.plugins.title' },
  { slug: 'magic-prompts', group: 'content', titleKey: 'settings.page.magicPrompts.title' },
  { slug: 'snippets', group: 'content', titleKey: 'settings.page.snippets.title' },
  { slug: 'skills.installed', group: 'content', titleKey: 'settings.page.skills.title' },
  { slug: 'skills.catalog', group: 'content', titleKey: 'settings.page.skillsCatalog.title' },
];

/** settingsItem notices for EVERY control rendered on the built pages. */
export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  { id: 'native-configuration.inventory', page: 'native-configuration', titleKey: 'settings.page.nativeConfiguration.title', keywords: 'nna native configuration settings source explicit effective redacted revision' },
  { id: 'native-configuration.attachments', page: 'native-configuration', titleKey: 'settings.nativeAttachments.title', keywords: 'nna native attachments upload maximum size retention enabled' },
  { id: 'native-configuration.memory-limits', page: 'native-configuration', titleKey: 'settings.nativeMemory.title', keywords: 'nna native memory enable required timeout maximum items bytes limits' },
  { id: 'native-configuration.provider-scheduling', page: 'native-configuration', titleKey: 'settings.nativeScheduling.title', keywords: 'nna provider concurrency queue limit scheduling requests' },
  { id: 'native-configuration.dream', page: 'native-configuration', titleKey: 'settings.nativeDream.title', keywords: 'nna dream maintenance idle inference hygiene retention enabled' },
  { id: 'native-configuration.runtime-timeouts', page: 'native-configuration', titleKey: 'settings.nativeTimeouts.title', keywords: 'nna provider connection semantic review timeout latency milliseconds' },
  { id: 'native-configuration.provider-deadline', page: 'native-configuration', titleKey: 'settings.nativeDeadline.title', keywords: 'nna global provider timeout primary route deadline disable milliseconds' },
  { id: 'native-configuration.stream-timeouts', page: 'native-configuration', titleKey: 'settings.nativeStreamTimeouts.title', keywords: 'nna first token idle streaming timeouts disable milliseconds' },
  { id: 'native-gateway.timeout', page: 'native-configuration', titleKey: 'settings.nativeGateway.title', keywords: 'nna telegram gateway settings enabled token token env workspace root polling timeout seconds authorized users allowlist restart' },
  { id: 'native-web-fetch.trust', page: 'native-configuration', titleKey: 'settings.nativeWebFetch.title', keywords: 'nna webfetch web fetch trust trusted origins authority grant http https revoke destination private network next fetch' },
  { id: 'native-web-search.settings', page: 'native-configuration', titleKey: 'settings.nativeWebSearch.title', keywords: 'nna websearch web search settings searxng searx profile profiles endpoint enabled disable primary promote remove next search' },
  { id: 'native-tui.preferences', page: 'native-tui', titleKey: 'settings.page.nativeTui.title', keywords: 'nna tui terminal color reduced motion key bindings shortcuts' },
  { id: 'native-routes.tuning', page: 'native-routes', titleKey: 'settings.page.nativeRoutes.title', keywords: 'nna reviewer vision route model provider temperature budget deadline' },
  { id: 'appearance.theme-mode', page: 'appearance', titleKey: 'settings.search.themeMode', keywords: 'theme, color, dark mode, light mode, system' },
  { id: 'appearance.light-theme', page: 'appearance', titleKey: 'settings.search.lightTheme', keywords: 'light theme, theme id' },
  { id: 'appearance.dark-theme', page: 'appearance', titleKey: 'settings.search.darkTheme', keywords: 'dark theme, theme id' },
  { id: 'appearance.reload-themes', page: 'appearance', titleKey: 'settings.search.reloadThemes', keywords: 'reload themes, custom themes' },
  { id: 'appearance.language', page: 'appearance', titleKey: 'settings.search.language', keywords: 'language, locale, i18n' },
  { id: 'appearance.time-format', page: 'appearance', titleKey: 'settings.search.timeFormat', keywords: 'time, clock, 24h, 12h' },
  { id: 'appearance.week-start', page: 'appearance', titleKey: 'settings.search.weekStart', keywords: 'week, monday, sunday' },
  { id: 'appearance.interface-font-size', page: 'appearance', titleKey: 'settings.search.fontSize', keywords: 'font size, zoom, scale' },
  { id: 'appearance.spacing-density', page: 'appearance', titleKey: 'settings.search.padding', keywords: 'padding, spacing, density' },
  { id: 'appearance.interface-font', page: 'appearance', titleKey: 'settings.search.uiFont', keywords: 'ui font, typeface' },
  { id: 'appearance.code-font', page: 'appearance', titleKey: 'settings.search.monoFont', keywords: 'mono font, code font' },
  { id: 'appearance.editor-font-size', page: 'appearance', titleKey: 'settings.search.editorFontSize', keywords: 'editor font size' },
  { id: 'appearance.terminal-font-size', page: 'appearance', titleKey: 'settings.search.terminalFontSize', keywords: 'terminal font size' },
  { id: 'appearance.file-editor-keymap', page: 'appearance', titleKey: 'settings.search.keymap', keywords: 'keymap, vim, editor' },
  { id: 'chat.render-mode', page: 'chat', titleKey: 'settings.search.renderMode', keywords: 'sorted, live, streaming' },
  { id: 'chat.activity-default', page: 'chat', titleKey: 'settings.search.activityRender', keywords: 'activity, collapsed, summary' },
  { id: 'chat.user-message-rendering', page: 'chat', titleKey: 'settings.search.userMessageRendering', keywords: 'markdown, plain, messages' },
  { id: 'chat.mermaid', page: 'chat', titleKey: 'settings.search.mermaid', keywords: 'mermaid, diagrams' },
  { id: 'chat.diff-layout', page: 'chat', titleKey: 'settings.search.diffLayout', keywords: 'diff, inline, side-by-side' },
  { id: 'chat.follow-up', page: 'chat', titleKey: 'settings.search.followUp', keywords: 'steer, queue, follow up' },
  { id: 'chat.input-history', page: 'chat', titleKey: 'settings.search.inputHistory', keywords: 'history, recall' },
  { id: 'chat.reasoning-traces', page: 'chat', titleKey: 'settings.search.reasoning', keywords: 'thinking, reasoning traces' },
  { id: 'chat.streaming-follow', page: 'chat', titleKey: 'settings.search.streaming', keywords: 'auto follow, streaming' },
  { id: 'chat.message-appearance', page: 'chat', titleKey: 'settings.search.messageAppearance', keywords: 'sticky, collapsible, wide' },
  { id: 'chat.tools-and-files', page: 'chat', titleKey: 'settings.search.toolsFiles', keywords: 'tool icons, changed files' },
  { id: 'chat.composer', page: 'chat', titleKey: 'settings.search.composer', keywords: 'spellcheck, draft, enter, paste' },
  { id: 'chat.session-assist', page: 'chat', titleKey: 'settings.search.sessionAssist', keywords: 'recap, suggestion, starters' },
  { id: 'chat.session-goal', page: 'chat', titleKey: 'settings.search.sessionGoal', keywords: 'goal, budget, autonomy' },
  { id: 'sessions.defaults', page: 'sessions', titleKey: 'settings.search.defaults', keywords: 'default model, agent, variant' },
  { id: 'sessions.retention', page: 'sessions', titleKey: 'settings.search.retention', keywords: 'auto delete, archive days' },
  { id: 'notifications.master', page: 'notifications', titleKey: 'settings.search.notifications', keywords: 'notifications, alerts' },
  { id: 'notifications.events', page: 'notifications', titleKey: 'settings.search.notificationEvents', keywords: 'completion, error, question' },
  { id: 'shortcuts.session', page: 'shortcuts', titleKey: 'settings.search.shortcutsSession', keywords: 'keybinding, shortcut' },
  { id: 'shortcuts.models', page: 'shortcuts', titleKey: 'settings.search.shortcutsModels', keywords: 'keybinding, model, agent' },
  { id: 'shortcuts.panels', page: 'shortcuts', titleKey: 'settings.search.shortcutsPanels', keywords: 'keybinding, terminal, sidebar' },
  { id: 'shortcuts.navigation', page: 'shortcuts', titleKey: 'settings.search.shortcutsNavigation', keywords: 'keybinding, editor' },
  { id: 'shortcuts.application', page: 'shortcuts', titleKey: 'settings.search.shortcutsApplication', keywords: 'keybinding, palette, settings' },
  { id: 'remote-instances.default', page: 'remote-instances', titleKey: 'settings.page.remoteInstances.title', keywords: 'host, server, instance, remote, local, connection' },
  { id: 'general.tools', page: 'general', titleKey: 'settings.search.agentTools', keywords: 'agent tools, control, web, memory' },
  { id: 'general.harness', page: 'general', titleKey: 'settings.search.harnessBinary', keywords: 'binary, cli, restart' },
  { id: 'general.telemetry', page: 'general', titleKey: 'settings.search.reportUsage', keywords: 'usage, telemetry, privacy' },
  { id: 'skills.inventory', page: 'skills.installed', titleKey: 'settings.page.skills.title', keywords: 'skills, inventory, nna' },
  { id: 'skills.catalog', page: 'skills.catalog', titleKey: 'settings.page.skillsCatalog.title', keywords: 'skills, catalog, install' },
];

/** The search index covers ONLY the built pages this slice; the rest join
 * as their pages land (§G.6 re-derive per control). */
export function searchIndex(): SettingsSearchItem[] {
  return SETTINGS_SEARCH_ITEMS.filter((item) => isBuiltPage(item.page));
}
