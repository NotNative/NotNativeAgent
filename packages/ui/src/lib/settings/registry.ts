// SPDX-License-Identifier: Apache-2.0
/**
 * SETTINGS_REGISTRY (doc 14 §F.1–F.5): the single table naming every
 * setting — key, scope, parser, and flag markers. Snapshot generation, the
 * server gate, the client sanitizer, mirrors, and auto-saves all derive from
 * it; "a key that is not in the registry does not persist" (§K invariant 2).
 * Deferred groups (github rate/ssh, stt) sit out per NOTES/14 §D and land
 * with P11/P12 — their absence is intentional (the tunnels group landed
 * with P8-4c).
 */
import {
  pBool,
  pInt,
  pList,
  pModelRefs,
  pGitIdentityProfiles,
  pNotificationTemplates,
  pNum,
  pOneOf,
  pPermissionAccept,
  pRecord,
  pSet,
  pStr,
  type ParserFn,
} from './parsers.ts';

export type SettingsScope = 'instance' | 'profile' | 'device';
export type SurfaceKind = 'web' | 'desktop' | 'mobile' | 'vscode';
export const SURFACE_KINDS: readonly SurfaceKind[] = ['web', 'desktop', 'mobile', 'vscode'];

export interface SettingsField {
  key: string;
  scope: SettingsScope;
  parse: ParserFn<unknown>;
  perSurface?: boolean;
  surfaces?: SurfaceKind[];
  adopt?: 'bootstrap-only';
  derived?: boolean;
  secret?: boolean;
  computed?: boolean;
  /** LOCAL_DEVICE_KEYS analog: device-scoped, store-local, never synced. */
  local?: boolean;
  owner?: 'desktop-shell';
  autoSave?: boolean;
  uiField?: string;
  note?: string;
}

type Defs = Omit<SettingsField, 'key' | 'scope' | 'parse'>;
const f = (key: string, scope: SettingsScope, parse: ParserFn<unknown>, defs: Defs = {}): SettingsField =>
  ({ key, scope, parse, ...defs });

const USAGES_MODES = ['usage', 'remaining'] as const;

export const SETTINGS_REGISTRY: SettingsField[] = [
  // Theme (profile, perSurface except derived themeVariant)
  f('themeId', 'profile', pStr({ max: 128 }), { perSurface: true, uiField: 'theme', note: 'legacy single-theme id' }),
  f('useSystemTheme', 'profile', pBool(), { perSurface: true, uiField: 'theme' }),
  f('themeVariant', 'profile', pOneOf(['light', 'dark']), { perSurface: true, derived: true, uiField: 'theme' }),
  f('lightThemeId', 'profile', pStr({ max: 128 }), { perSurface: true, uiField: 'theme' }),
  f('darkThemeId', 'profile', pStr({ max: 128 }), { perSurface: true, uiField: 'theme' }),

  // Workspace & instance facts
  f('lastDirectory', 'instance', pStr({ trim: true, max: 2048 }), { adopt: 'bootstrap-only' }),
  f('homeDirectory', 'instance', pStr({ trim: true, max: 2048 })),
  f('opencodeBinary', 'instance', pStr({ trim: true, max: 2048, allowEmpty: true }), { note: 'harness binary path (brand pass pending, D13); empty clears the override' }),
  f('projects', 'instance', pList(pStr({ max: 2048 }), 64), { note: 'string paths v1; ProjectEntry[] with sidebarCollapsed when the projects UI lands (P6)' }),
  f('activeProjectId', 'instance', pStr({ trim: true, max: 256 }), { adopt: 'bootstrap-only' }),
  f('securityScopedBookmarks', 'instance', pSet(64), { surfaces: ['desktop'] }),
  f('pinnedDirectories', 'instance', pSet(64)),
  f('desktopLanAccessEnabled', 'instance', pBool(), { surfaces: ['desktop'] }),
  f('desktopKeepAwakeEnabled', 'instance', pBool(), { surfaces: ['desktop'] }),
  f('desktopMinimizeToTrayEnabled', 'instance', pBool(), { surfaces: ['desktop'] }),
  f('desktopMacMenuBarEnabled', 'instance', pBool(), { surfaces: ['desktop'] }),
  f('desktopUiPassword', 'instance', pStr({ trim: true, max: 256 }), { surfaces: ['desktop'], secret: true, note: 'empty string clears' }),
  f('hasDesktopUiPassword', 'instance', pBool(), { surfaces: ['desktop'], computed: true }),
  f('desktopLanAccessActive', 'instance', pBool(), { surfaces: ['desktop'], computed: true }),
  f('desktopLanAccessBlockedReason', 'instance', pStr({ trim: true, max: 256 }), { surfaces: ['desktop'], computed: true }),
  f('githubClientId', 'instance', pStr({ trim: true, max: 128 })),
  f('githubScopes', 'instance', pStr({ trim: true, max: 512 })),
  f('skillCatalogs', 'instance', pList(pStr({ max: 2048 }), 16), { note: 'string catalog ids v1; SkillCatalogConfig[] when the skills UI lands (P9)' }),
  f('terminalShell', 'instance', pStr({ trim: true, max: 256 }), { uiField: 'terminal', note: 'oneof validated TerminalShell narrowing lands with P7' }),
  f('defaultGitIdentityId', 'instance', pStr({ trim: true, max: 256 })),
  f('gitIdentityProfiles', 'instance', pGitIdentityProfiles(), { uiField: 'skills', note: 'credential-free SSH-only Git identity profiles used for clones' }),
  f('permissionAutoAccept', 'instance', pPermissionAccept()),
  f('agentControlToolEnabled', 'instance', pBool(), { uiField: 'agentTools' }),
  f('agentWebToolEnabled', 'instance', pBool(), { uiField: 'agentTools' }),
  f('agentMemoryToolEnabled', 'instance', pBool(), { uiField: 'agentTools' }),
  f('openCodeUpdateToastDismissedVersion', 'instance', pStr({ trim: true, max: 128 })),
  f('autoDeleteEnabled', 'instance', pBool(), { uiField: 'retention' }),
  f('autoDeleteAfterDays', 'instance', pInt(1, 365), { uiField: 'retention' }),
  f('sessionRetentionOnlyArchived', 'instance', pBool(), { uiField: 'retention' }),
  f('sessionRetentionAction', 'instance', pOneOf(['archive', 'delete']), { uiField: 'retention' }),
  f('terminalLoginShells', 'instance', pList(pStr({ trim: true, max: 256 }), 8), { uiField: 'terminal', note: 'validated TerminalShell list lands with P7' }),
  f('openInAppId', 'instance', pStr({ trim: true, max: 128 })),

  // Sidebar display (profile → SessionDisplayStore)
  f('sidebarProjectDisplayMode', 'profile', pOneOf(['all', 'single']), { uiField: 'sessionDisplay', autoSave: true }),
  f('sidebarSessionGroupingMode', 'profile', pOneOf(['by-worktree', 'flat']), { uiField: 'sessionDisplay', autoSave: true }),
  f('sidebarProjectSortOrder', 'profile', pOneOf(['manual', 'a-z', 'z-a', 'date-added', 'recent']), { uiField: 'sessionDisplay', autoSave: true }),
  f('sidebarShowRecentSection', 'profile', pBool(), { uiField: 'sessionDisplay', autoSave: true }),

  // Work status
  f('workStatusPanelEnabled', 'profile', pBool(), { uiField: 'workStatus', autoSave: true }),
  f('workStatusHiddenSections', 'profile', pSet(32), { uiField: 'workStatus', autoSave: true }),
  f('workStatusHiddenSectionsExplicit', 'profile', pBool(), { uiField: 'workStatus', autoSave: true }),

  // Chat & rendering (profile)
  f('showReasoningTraces', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('streamingAutoFollowEnabled', 'profile', pBool(), { perSurface: true, uiField: 'chat', autoSave: true }),
  f('collapsibleThinkingBlocks', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('showTextJustificationActivity', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('chatRenderMode', 'profile', pOneOf(['sorted', 'live']), { uiField: 'chat', autoSave: true }),
  f('activityRenderMode', 'profile', pOneOf(['collapsed', 'summary']), { uiField: 'chat', autoSave: true }),
  f('mermaidRenderingMode', 'profile', pOneOf(['svg', 'ascii']), { uiField: 'chat', autoSave: true }),
  f('userMessageRenderingMode', 'profile', pOneOf(['markdown', 'plain']), { uiField: 'chat', autoSave: true }),
  f('collapsibleUserMessages', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('stickyUserHeader', 'profile', pBool(), { perSurface: true, uiField: 'chat', autoSave: true }),
  f('promptNavigatorEnabled', 'profile', pBool(), { perSurface: true, uiField: 'chat', autoSave: true }),
  f('wideChatLayoutEnabled', 'profile', pBool(), { perSurface: true, uiField: 'chat', autoSave: true }),
  f('showSplitAssistantMessageActions', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('showToolFileIcons', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('codeBlockLineWrap', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('showTurnChangedFiles', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('showExpandedBashTools', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('showExpandedEditTools', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('toolJsonViewMode', 'profile', pOneOf(['summary', 'formatted', 'raw']), { uiField: 'chat', autoSave: true }),
  f('timeFormatPreference', 'profile', pOneOf(['auto', '12h', '24h']), { uiField: 'chat', autoSave: true }),
  f('weekStartPreference', 'profile', pOneOf(['auto', 'sunday', 'monday']), { uiField: 'chat', autoSave: true }),
  f('messageStreamTransport', 'profile', pOneOf(['auto', 'ws', 'sse']), { uiField: 'config' }),
  f('diffLayoutPreference', 'profile', pOneOf(['dynamic', 'inline', 'side-by-side']), { uiField: 'chat', autoSave: true }),
  f('diffWrapLines', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('gitChangesViewMode', 'profile', pOneOf(['flat', 'tree']), { uiField: 'chat', autoSave: true }),
  f('gitmojiEnabled', 'profile', pBool(), { uiField: 'git' }),
  f('defaultFileViewerPreview', 'profile', pBool(), { uiField: 'chat' }),
  f('directoryShowHidden', 'profile', pBool(), { uiField: 'files' }),
  f('filesViewShowGitignored', 'profile', pBool(), { uiField: 'files' }),
  f('fileEditorKeymap', 'profile', pOneOf(['default', 'vim']), { uiField: 'editor', autoSave: true }),
  f('autoSaveEnabled', 'profile', pBool(), { uiField: 'skills' }),
  f('autoCreateWorktree', 'profile', pBool(), { uiField: 'model' }),
  f('sessionTabsEnabled', 'profile', pBool(), { surfaces: ['web', 'desktop', 'vscode'], uiField: 'chat', autoSave: true }),
  f('allowPromptingSubagentSessions', 'profile', pBool(), { uiField: 'chat', autoSave: true }),
  f('showOpenCodeRestartConfirm', 'profile', pBool(), { uiField: 'harness' }),
  f('globalBehaviorPrompt', 'profile', pStr({ max: 1_048_576 }), { uiField: 'behavior' }),
  f('optimizeSystemPrompt', 'profile', pBool(), { uiField: 'behavior' }),
  f('responseStyleEnabled', 'profile', pBool(), { uiField: 'behavior' }),
  f('responseStylePreset', 'profile', pOneOf(['concise', 'detailed', 'mentor', 'pushback', 'noFiller', 'matchEnergy', 'warmPeer', 'custom']), { uiField: 'behavior' }),
  f('responseStyleCustomInstructions', 'profile', pStr({ max: 50_000 }), { uiField: 'behavior' }),

  // Composer (profile)
  f('inputSpellcheckEnabled', 'profile', pBool(), { uiField: 'composer', autoSave: true }),
  f('enterToSend', 'profile', pBool(), { uiField: 'composer', autoSave: true }),
  f('enterToSendConfigured', 'profile', pBool(), { uiField: 'composer', autoSave: true }),
  f('persistChatDraft', 'profile', pBool(), { uiField: 'composer', autoSave: true }),
  f('largeTextPasteBehavior', 'profile', pOneOf(['ask', 'attach', 'inline']), { uiField: 'composer', autoSave: true }),
  f('followUpBehavior', 'profile', pOneOf(['steer', 'queue']), { uiField: 'messageQueue' }),
  f('queueModeEnabled', 'profile', pBool(), { uiField: 'messageQueue' }),
  f('inputHistoryScope', 'profile', pOneOf(['global', 'session']), { uiField: 'inputHistory' }),
  f('inputHistoryLimit', 'profile', pInt(1, 100), { uiField: 'inputHistory' }),
  f('draftStarters', 'profile', pList(pRecord(pStr({ max: 512 }), { maxEntries: 8 }), 32), { uiField: 'drafts' }),
  f('draftStartersVisible', 'profile', pBool(), { uiField: 'drafts' }),
  f('draftStartersCraftGoalAdded', 'profile', pBool()),
  f('draftStartersScheduleTaskAdded', 'profile', pBool()),

  // Typography & chrome (caps per §F.5: fontSize/padding 50..200,
  // terminalFontSize 9..52, editorFontSize 9..32)
  f('fontSize', 'profile', pNum(50, 200), { perSurface: true, uiField: 'typography', autoSave: true }),
  f('terminalFontSize', 'profile', pNum(9, 52), { perSurface: true, uiField: 'typography', autoSave: true }),
  f('editorFontSize', 'profile', pNum(9, 32), { perSurface: true, uiField: 'typography', autoSave: true }),
  f('uiFont', 'profile', pOneOf(['inter', 'fixel', 'geist-sans', 'atkinson-hyperlegible', 'source-sans-3', 'roboto', 'noto-sans', 'dm-sans', 'manrope', 'system']), { uiField: 'typography', autoSave: true }),
  f('monoFont', 'profile', pOneOf(['jetbrains-mono', 'fira-code', 'geist-mono', 'commit-mono', 'source-code-pro', 'cascadia-code', 'roboto-mono', 'iosevka', 'system-mono']), { uiField: 'typography', autoSave: true }),
  f('padding', 'profile', pNum(50, 200), { perSurface: true, uiField: 'typography', autoSave: true }),
  f('cornerRadius', 'profile', pNum(0, 1024), { perSurface: true, uiField: 'typography', autoSave: true }),
  f('shortcutOverrides', 'profile', pRecord(pStr({ min: 1, max: 64 }), { maxEntries: 64 }), { uiField: 'shortcuts' }),

  // Models & agents (profile)
  f('defaultModel', 'profile', pStr({ trim: true, max: 256 }), { uiField: 'model' }),
  f('defaultVariant', 'profile', pStr({ trim: true, max: 128 }), { uiField: 'model' }),
  f('defaultAgent', 'profile', pStr({ trim: true, max: 128 }), { uiField: 'model' }),
  f('smallModelUseDefault', 'profile', pBool(), { uiField: 'model' }),
  f('smallModelOverride', 'profile', pStr({ trim: true, max: 256 }), { uiField: 'model' }),
  f('walkthroughModelOverride', 'profile', pStr({ trim: true, max: 256 }), { uiField: 'model' }),
  f('zenModel', 'profile', pStr({ trim: true, max: 256 }), { uiField: 'model' }),
  f('favoriteModels', 'profile', pModelRefs(64), { uiField: 'modelPrefs' }),
  f('hiddenModels', 'profile', pModelRefs(1024), { uiField: 'modelPrefs' }),
  f('collapsedModelProviders', 'profile', pSet(64), { uiField: 'modelPrefs' }),
  f('recentModels', 'profile', pModelRefs(16), { uiField: 'modelPrefs' }),
  f('recentAgents', 'profile', pSet(32), { uiField: 'modelPrefs' }),
  f('recentEfforts', 'profile', pRecord(pSet(8), { maxEntries: 64 }), { uiField: 'modelPrefs' }),
  f('providerOrder', 'profile', pSet(64), { uiField: 'modelPrefs' }),

  // Sessions & summaries (profile)
  f('sessionRecapEnabled', 'profile', pBool(), { uiField: 'session', autoSave: true }),
  f('sessionSuggestionEnabled', 'profile', pBool(), { uiField: 'session', autoSave: true }),
  f('sessionGoalEnabled', 'profile', pBool(), { uiField: 'session', autoSave: true }),
  f('sessionGoalDefaultBudgetEnabled', 'profile', pBool(), { uiField: 'session', autoSave: true }),
  f('sessionGoalDefaultBudget', 'profile', pInt(1000, 100_000_000), { uiField: 'session', autoSave: true }),
  f('summarizeLastMessage', 'profile', pBool(), { uiField: 'session' }),
  f('summaryThreshold', 'profile', pInt(0), { uiField: 'session' }),
  f('summaryLength', 'profile', pInt(10), { uiField: 'session' }),
  f('maxLastMessageLength', 'profile', pInt(10), { uiField: 'session' }),
  f('showDeletionDialog', 'profile', pBool(), { uiField: 'session', autoSave: true }),

  // Notifications (profile)
  f('nativeNotificationsEnabled', 'profile', pBool(), { uiField: 'notifications' }),
  f('notificationMode', 'profile', pOneOf(['always', 'hidden-only']), { uiField: 'notifications' }),
  f('notifyOnSubtasks', 'profile', pBool(), { uiField: 'notifications' }),
  f('notifyOnCompletion', 'profile', pBool(), { uiField: 'notifications' }),
  f('notifyOnError', 'profile', pBool(), { uiField: 'notifications' }),
  f('notifyOnQuestion', 'profile', pBool(), { uiField: 'notifications' }),
  f('notificationTemplates', 'profile', pNotificationTemplates(), { uiField: 'notifications' }),
  f('showOpenCodeUpdateNotifications', 'profile', pBool(), { uiField: 'notifications' }),
  f('reportUsage', 'profile', pBool(), { uiField: 'usageTelemetry' }),

  // Usage page (profile; page self-reads)
  f('usageDisplayMode', 'profile', pOneOf(USAGES_MODES), { uiField: 'usagePage' }),
  f('usageDropdownProviders', 'profile', pSet(64), { uiField: 'usagePage' }),
  f('usageSelectedModels', 'profile', pModelRefs(16), { uiField: 'usagePage' }),
  f('usageCollapsedFamilies', 'profile', pSet(64), { uiField: 'usagePage' }),
  f('usageExpandedFamilies', 'profile', pRecord(pSet(64), { maxEntries: 64 }), { uiField: 'usagePage' }),
  f('usageModelGroups', 'profile', pList(pStr({ max: 256 }), 64), { uiField: 'usagePage' }),

  // PWA (instance, web only)
  f('pwaAppName', 'instance', pStr({ trim: true, max: 64 }), { surfaces: ['web'] }),
  f('pwaOrientation', 'instance', pOneOf(['system', 'portrait', 'landscape']), { surfaces: ['web'] }),

  // Device scope (never crosses the wire)
  f('mobileKeyboardMode', 'device', pOneOf(['native', 'resize-content']), { surfaces: ['mobile'], uiField: 'device' }),
  f('desktopWindowControlsPosition', 'device', pOneOf(['left', 'right']), { surfaces: ['desktop'], uiField: 'device' }),
  f('desktopWindowControlsStyle', 'device', pOneOf(['classic', 'traffic-lights']), { surfaces: ['desktop'], uiField: 'device' }),
  f('inputBarOffset', 'device', pInt(0, 100), { surfaces: ['mobile', 'web'], uiField: 'device' }),

  // LOCAL_DEVICE_KEYS (doc 14 §F.4): device facts that only ever lived in
  // the persisted UI store; snapshot emits {scope:'device', local:true}.
  f('theme', 'device', pStr({ max: 64 }), { local: true }),
  f('isSidebarOpen', 'device', pBool(), { local: true }),
  f('sidebarWidth', 'device', pNum(0), { local: true }),
  f('contextPanelByDirectory', 'device', pRecord(pBool(), { maxEntries: 128 }), { local: true }),
  f('contextRailOrder', 'device', pSet(16), { local: true }),
  f('contextRailHiddenSurfaces', 'device', pSet(16), { local: true }),
  f('contextEditorTreeVisible', 'device', pBool(), { local: true }),
  f('contextEditorTreeWidth', 'device', pNum(0), { local: true }),
  f('notesPanelHeight', 'device', pNum(0), { local: true }),
  f('workStatusExpandedSections', 'device', pSet(16), { local: true }),
  f('workStatusScrollTop', 'device', pNum(0), { local: true }),
  f('isSessionSwitcherOpen', 'device', pBool(), { local: true }),
  f('sidebarSection', 'device', pStr({ max: 64 }), { local: true }),
  f('settingsPage', 'device', pStr({ max: 64 }), { local: true }),
  f('settingsHasOpenedOnce', 'device', pBool(), { local: true }),
  f('settingsProjectsSelectedId', 'device', pStr({ max: 128 }), { local: true }),
  f('settingsRemoteInstancesSelectedId', 'device', pStr({ max: 128 }), { local: true }),
  f('isSessionCreateDialogOpen', 'device', pBool(), { local: true }),
  f('autoDeleteLastRunAt', 'device', pNum(0), { local: true }),
  f('messageLimit', 'device', pInt(10, 500), { local: true }),
  f('walkthroughTocWidth', 'device', pNum(0), { local: true }),
  f('linearIssueListStatus', 'device', pSet(32), { local: true }),
  f('linearIssueListAssignee', 'device', pSet(32), { local: true }),
  f('linearIssueListTeamIdByRuntime', 'device', pRecord(pStr({ max: 128 }), { maxEntries: 16 }), { local: true }),
  f('linearIssueListPriority', 'device', pStr({ max: 64 }), { local: true }),
  f('showTerminalQuickKeysOnDesktop', 'device', pBool(), { local: true }),
  f('dockBadgeEnabled', 'device', pBool(), { local: true }),
  f('alwaysShowScrollbars', 'device', pBool(), { local: true }),
  f('agentMemoryViewedAt', 'device', pNum(0), { local: true }),
  f('projectContextSidebarWidth', 'device', pNum(0), { local: true }),

  // DESKTOP_SHELL_KEYS (doc 14 §F.4): instance facts the Electron main
  // writes straight into settings.json; clients never read or send them.
  f('desktopSplashColors', 'instance', pRecord(pStr({ max: 16 }), { maxEntries: 8 }), { owner: 'desktop-shell', surfaces: ['desktop'] }),
  f('desktopHosts', 'instance', pList(pStr({ max: 1024 }), 8), { owner: 'desktop-shell', surfaces: ['desktop'] }),
  f('desktopDefaultHostId', 'instance', pStr({ trim: true, max: 128 }), { owner: 'desktop-shell', surfaces: ['desktop'] }),
  f('desktopInstallId', 'instance', pStr({ trim: true, max: 128 }), { owner: 'desktop-shell', surfaces: ['desktop'] }),
  f('desktopLocalPort', 'instance', pInt(0, 65535), { owner: 'desktop-shell', surfaces: ['desktop'] }),
  f('desktopSshInstances', 'instance', pList(pStr({ max: 1024 }), 16), { owner: 'desktop-shell', surfaces: ['desktop'] }),
  f('desktopWindowState', 'instance', pRecord(pNum(0), { maxEntries: 16 }), { owner: 'desktop-shell', surfaces: ['desktop'] }),

  // TUNNELS (doc 08 §11.2): the tunnels group (P8-4c server side). UI
  // affordances ride the pairing/instance-UX slice; `tunnelBootstrapTtlMs`
  // null-disable authoring rides the server write paths (§4.5).
  f('tunnelProvider', 'instance', pOneOf(['cloudflare', 'ngrok']), { note: 'preferred provider fallback (blank -> cloudflare)' }),
  f('tunnelMode', 'instance', pOneOf(['quick', 'managed-local', 'managed-remote']), { note: 'preferred mode (blank -> quick)' }),
  f('managedLocalTunnelConfigPath', 'instance', pStr({ trim: true, max: 2048 }), { note: '~ or absolute inside the home directory (doc 08 section 4.2)' }),
  f('managedRemoteTunnelHostname', 'instance', pStr({ trim: true, max: 256 })),
  f('managedRemoteTunnelToken', 'instance', pStr({ trim: true, max: 4096 }), { secret: true, note: 'cloudflared run token; profile store preferred (4.4)' }),
  f('tunnelBootstrapTtlMs', 'instance', pInt(60_000, 24 * 60 * 60_000), { note: 'connect-link TTL; explicit null disables expiry (4.5)' }),
  f('tunnelSessionTtlMs', 'instance', pInt(300_000, 30 * 24 * 60 * 60_000)),
];

/** One dead marker field kept for the parser-map contract sample above; the
 * registry is append-only per §F.6 — dead key removed in the same pass. */
export const REGISTRY_SNAPSHOT_VERSION = 1;

const BY_KEY = new Map(SETTINGS_REGISTRY.map((field) => [field.key, field]));

export function getSettingsField(key: string): SettingsField | null {
  return BY_KEY.get(key) ?? null;
}

export function isRegisteredKey(key: string): boolean {
  return BY_KEY.has(key);
}

/** Registry keys bound for the appearance auto-save subscriber (§F.3). */
export function autoSaveKeys(): string[] {
  return SETTINGS_REGISTRY.filter((field) => field.autoSave === true).map((field) => field.key);
}
