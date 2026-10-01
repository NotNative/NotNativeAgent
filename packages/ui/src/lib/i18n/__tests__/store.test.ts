// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * i18n store/provider gates (doc 14 §H.2/§H.3): optimistic switch w/
 * dictionary swap, en per-key fallback, {param} interpolation with raw
 * token passthrough, closed-key coverage of all 11 partial catalogs, and
 * the pre-dictionary bootstrap strings.
 */
import { describe, expect, it } from 'vitest';
import { PARTIAL_CATALOGS, dictionaryFor } from '../messages/locales.ts';
import en, { type I18nKey } from '../messages/en.ts';
import { LOCALES } from '../runtime.ts';
import { interpolate, translate, useI18nStore } from '../store.ts';
import { bootstrapStrings } from '../bootstrap.ts';
import { getCurrentIntlLocale } from '../intl.ts';

describe('catalogs (closed-key coverage, §H.2/§H.3)', () => {
  it('en is complete; every catalog carries only en keys; all 11 exist', () => {
    const enKeys = new Set(Object.keys(en));
    expect(Object.keys(en).length).toBeGreaterThan(18); // shell + bootstrap + templates
    expect(Object.keys(PARTIAL_CATALOGS).length).toBe(11);
    expect(new Set(Object.keys(PARTIAL_CATALOGS))).toEqual(new Set(LOCALES.filter((locale) => locale !== 'en')));
    for (const [locale, catalog] of Object.entries(PARTIAL_CATALOGS)) {
      for (const key of Object.keys(catalog)) {
        expect(enKeys.has(key), `${locale} key ${key} must exist in en`).toBe(true);
      }
      expect(Object.keys(catalog).length).toBeGreaterThan(3);
    }
    for (const locale of Object.keys(PARTIAL_CATALOGS)) {
      for (const key of [
        'settings.window.title',
        'settings.window.searchPlaceholder',
        'settings.window.searchNoResults',
        'settings.page.general.title',
        'settings.page.appearance.title',
        'settings.page.chat.title',
        'settings.page.notifications.title',
        'settings.page.sessions.title',
        'settings.page.shortcuts.title',
        'settings.search.language',
        'settings.search.themeMode',
        'settings.search.lightTheme',
        'settings.search.darkTheme',
        'settings.search.reloadThemes',
        'settings.search.timeFormat',
        'settings.search.weekStart',
        'settings.search.fontSize',
        'settings.search.padding',
        'settings.search.uiFont',
        'settings.search.monoFont',
        'settings.search.editorFontSize',
        'settings.search.terminalFontSize',
        'settings.search.keymap',
        'settings.appearance.languageFormats',
        'settings.appearance.typographySpacing',
        'settings.appearance.followSystem',
        'settings.appearance.light',
        'settings.appearance.dark',
        'settings.appearance.reloading',
        'settings.appearance.reloadAction',
        'settings.appearance.auto',
        'settings.appearance.monday',
        'settings.appearance.sunday',
        'settings.appearance.defaultKeymap',
        'settings.appearance.vimKeymap',
        'settings.chat.rendering',
        'settings.chat.sorted',
        'settings.chat.live',
        'settings.chat.collapsed',
        'settings.chat.summary',
        'settings.chat.markdown',
        'settings.chat.plainText',
        'settings.chat.composerHistory',
        'settings.chat.composerInputHistory',
        'settings.chat.perSession',
        'settings.chat.allSessions',
        'settings.chat.persistDraft',
        'settings.chat.spellcheck',
        'settings.chat.largeTextPaste',
        'settings.chat.askLargePaste',
        'settings.chat.attachAsFile',
        'settings.chat.pasteInline',
        'settings.chat.enterKeySends',
        'settings.chat.platformDefault',
        'settings.chat.enterSends',
        'settings.chat.modifierEnterSends',
        'settings.search.reasoning',
        'settings.search.streaming',
        'settings.chat.reasoningStreaming',
        'settings.chat.collapsibleThinking',
        'settings.search.messageAppearance',
        'settings.chat.stickyUserHeader',
        'settings.chat.promptNavigator',
        'settings.chat.wideLayout',
        'settings.chat.collapsibleUserMessages',
        'settings.chat.splitActions',
        'settings.chat.lineWrap',
        'settings.search.toolsFiles',
        'settings.search.renderMode',
        'settings.search.followUp',
        'settings.chat.steerInFlightTurn',
        'settings.chat.queueFollowups',
        'settings.search.activityRender',
        'settings.search.userMessageRendering',
        'settings.search.mermaid',
        'settings.search.diffLayout',
        'settings.chat.dynamicDiff',
        'settings.chat.inlineDiff',
        'settings.chat.sideBySideDiff',
        'settings.chat.showToolFileIcons',
        'settings.chat.showTurnChangedFiles',
        'settings.chat.showDotfiles',
        'settings.chat.previewFilesBeforeAttach',
        'settings.search.sessionAssist',
        'settings.chat.draftStartersVisible',
        'settings.chat.allowPromptingSubagent',
        'settings.chat.showAssistantRecaps',
        'settings.chat.showFollowupSuggestions',
        'settings.search.sessionGoal',
        'settings.chat.defaultBudgetAllSessions',
        'settings.chat.defaultBudgetLabel',
        'settings.chat.enableSessionGoals',
        'settings.chat.inputHistory.helper',
        'settings.chat.inputHistory.unit',
        'settings.chat.defaultBudget.helper',
        'settings.search.agentTools',
        'settings.search.harnessBinary',
        'settings.search.reportUsage',
        'settings.general.agentControlTool',
        'settings.general.agentWebTool',
        'settings.general.agentMemoryTool',
        'settings.general.harnessBinaryPath',
        'settings.general.harnessBinaryDefault',
        'settings.general.harnessBinaryExample',
        'settings.general.confirmHarnessRestarts',
        'settings.general.shareUsageReports',
        'settings.general.usageReportConsent',
        'settings.sessions.defaults',
        'settings.sessions.defaultsNote',
        'settings.sessions.behavior',
        'settings.sessions.confirmDelete',
        'settings.sessions.previewOpenFiles',
        'settings.sessions.messageTransport',
        'settings.sessions.messageTransportHelper',
        'settings.sessions.transportAuto',
        'settings.sessions.transportSse',
        'settings.sessions.retention',
        'settings.sessions.autoDelete',
        'settings.sessions.deleteOlderThan',
        'settings.sessions.days',
        'settings.sessions.archiveOnly',
        'settings.sessions.retentionAction',
        'settings.sessions.archive',
        'settings.sessions.delete',
        'settings.search.shortcutsSession',
        'settings.search.shortcutsModels',
        'settings.search.shortcutsPanels',
        'settings.search.shortcutsNavigation',
        'settings.search.shortcutsApplication',
        'settings.shortcuts.edit',
        'settings.shortcuts.reset',
        'settings.shortcuts.resetAll',
        'settings.shortcuts.unassigned',
        'settings.shortcuts.recording',
        'settings.shortcuts.sequenceHint',
        'settings.shortcuts.conflict',
        'settings.shortcuts.conflictInternal',
        'settings.shortcuts.conflictPrefix',
        'settings.shortcuts.replaceable',
        'settings.shortcuts.maxKeys',
        'settings.shortcuts.risky',
        'settings.shortcuts.clear',
        'settings.shortcuts.cancel',
        'settings.shortcuts.confirm',
        'settings.appearance.themesHelper',
        'settings.appearance.time24Hours',
        'settings.appearance.time12Hours',
        'settings.skills.inventory.title',
        'settings.skills.inventory.refresh',
        'settings.skills.inventory.description',
        'settings.skills.inventory.loading',
        'settings.skills.inventory.invalid',
        'settings.skills.inventory.unavailable',
        'settings.skills.inventory.empty',
        'settings.skills.inventory.user',
        'settings.skills.inventory.agent',
        'settings.skills.inventory.userAndAgent',
        'settings.mcp.inventory.title',
        'settings.mcp.inventory.refresh',
        'settings.mcp.inventory.description',
        'settings.mcp.inventory.loading',
        'settings.mcp.inventory.invalid',
        'settings.mcp.inventory.unavailable',
        'settings.mcp.inventory.rawErrorAction',
        'settings.mcp.inventory.empty',
        'settings.mcp.inventory.enabled',
        'settings.mcp.inventory.disabled',
        'settings.mcp.inventory.localProcess',
        'settings.mcp.inventory.httpTransport',
        'settings.mcp.inventory.trusted',
        'settings.mcp.inventory.untrusted',
        'settings.mcp.inventory.unverified',
        'settings.mcp.config.title',
        'settings.mcp.config.refresh',
        'settings.mcp.config.new',
        'settings.mcp.config.importJson',
        'settings.mcp.config.description',
        'settings.mcp.config.loading',
        'settings.mcp.config.empty',
        'settings.mcp.config.projectRequired',
        'settings.mcp.config.record.userScope',
        'settings.mcp.config.record.projectScope',
        'settings.mcp.config.record.localProcess',
        'settings.mcp.config.record.remote',
        'settings.mcp.config.record.enabled',
        'settings.mcp.config.record.disabled',
        'settings.mcp.config.action.edit',
        'settings.mcp.config.action.confirmDelete',
        'settings.mcp.config.action.delete',
        'settings.mcp.config.action.connect',
        'settings.mcp.config.action.test',
        'settings.mcp.config.action.disconnect',
        'settings.mcp.config.action.authorize',
        'settings.mcp.config.action.completeAuth',
        'settings.mcp.config.action.openBrowserAuth',
        'settings.mcp.status.connected',
        'settings.mcp.status.disabled',
        'settings.mcp.status.failed',
        'settings.mcp.status.needsAuth',
        'settings.mcp.status.needsClientRegistration',
        'settings.mcp.status.unknown',
        'settings.mcp.status.unverified',
        'settings.mcp.action.failed',
        'settings.mcp.notice.created',
        'settings.mcp.notice.updated',
        'settings.mcp.notice.deleted',
        'settings.mcp.notice.authorizationStarted',
        'settings.mcp.notice.authorizationCompleted',
        'settings.mcp.notice.importSummary',
        'settings.mcp.error.authorizationUrlMissing',
        'settings.mcp.error.authorizationCodeRequired',
        'settings.mcp.error.shareFileUnreadable',
        'settings.mcp.error.shareImportFailed',
        'settings.mcp.error.authorizationUrlProtocol',
        'settings.mcp.import.created',
        'settings.mcp.import.updated',
        'settings.mcp.import.noChanges',
        'settings.mcp.draft.title.new',
        'settings.mcp.draft.title.edit',
        'settings.mcp.draft.name',
        'settings.mcp.draft.name.helper.new',
        'settings.mcp.draft.name.helper.locked',
        'settings.mcp.draft.transport.local',
        'settings.mcp.draft.transport.remote',
        'settings.mcp.draft.command',
        'settings.mcp.draft.command.helper',
        'settings.mcp.draft.url',
        'settings.mcp.draft.url.helper',
        'settings.mcp.draft.environmentRows',
        'settings.mcp.draft.environmentRows.helper',
        'settings.mcp.draft.requestHeaders',
        'settings.mcp.draft.requestHeaders.helper',
        'settings.mcp.draft.oauthClient',
        'settings.mcp.draft.oauth.clientId',
        'settings.mcp.draft.oauth.clientSecret',
        'settings.mcp.draft.oauth.scope',
        'settings.mcp.draft.oauth.redirectUri',
        'settings.mcp.draft.timeout',
        'settings.mcp.draft.timeout.helper',
        'settings.mcp.draft.enabled',
        'settings.mcp.draft.action.save',
        'settings.mcp.draft.action.cancel',
        'settings.mcp.draft.rows.key',
        'settings.mcp.draft.rows.value',
        'settings.mcp.draft.rows.add',
        'settings.notifications.enable',
        'settings.notifications.apiUnavailable',
        'settings.notifications.deliver',
        'settings.notifications.always',
        'settings.notifications.hiddenOnly',
        'settings.notifications.onCompletion',
        'settings.notifications.onError',
        'settings.notifications.onQuestion',
        'settings.notifications.onSubtask',
        'settings.notifications.harnessUpdates',
        'settings.notifications.templates',
        'settings.notifications.page.template.defaults.completion.title',
        'settings.notifications.page.template.defaults.completion.message',
        'settings.notifications.page.template.defaults.error.title',
        'settings.notifications.page.template.defaults.error.message',
        'settings.notifications.page.template.defaults.question.title',
        'settings.notifications.page.template.defaults.question.message',
        'settings.notifications.page.template.defaults.subtask.title',
        'settings.notifications.page.template.defaults.subtask.message',
      ]) {
        expect(Object.hasOwn(PARTIAL_CATALOGS[locale]!, key), `${locale} should translate ${key}`).toBe(true);
      }
      for (const key of Object.keys(en).filter((candidate) => candidate.startsWith('settings.snippets.'))) {
        expect(Object.hasOwn(PARTIAL_CATALOGS[locale]!, key), `${locale} should translate ${key}`).toBe(true);
      }
      for (const key of Object.keys(en).filter((candidate) => candidate.startsWith('settings.agents.'))) {
        expect(Object.hasOwn(PARTIAL_CATALOGS[locale]!, key), `${locale} should translate ${key}`).toBe(true);
      }
      for (const key of Object.keys(en).filter((candidate) => candidate.startsWith('settings.providers.route.'))) {
        expect(Object.hasOwn(PARTIAL_CATALOGS[locale]!, key), `${locale} should translate ${key}`).toBe(true);
      }
      for (const key of Object.keys(en).filter((candidate) => candidate.startsWith('shortcuts.label.'))) {
        expect(Object.hasOwn(PARTIAL_CATALOGS[locale]!, key), `${locale} should translate ${key}`).toBe(true);
      }
    }
  });

  it('dictionaryFor merges over en; en returns the identity', () => {
    expect(dictionaryFor('en')).toBe(en);
    const de = dictionaryFor('de');
    expect(de['shell.sessions']).toBe('Sitzungen'); // catalog value
    expect(de['shell.connecting']).toBe('Verbindung zum Harness wird hergestellt…');
    expect(de['shell.busy']).toBe('Wird ausgeführt…');
    expect(de['settings.window.title']).toBe('Einstellungen');
    expect(de['settings.page.appearance.title']).toBe('Darstellung');
    expect(de['settings.search.language']).toBe('Sprache');
    expect(de['settings.search.themeMode']).toBe('Darstellungsmodus');
    expect(de['settings.search.timeFormat']).toBe('Uhrzeitformat');
    expect(de['settings.search.keymap']).toBe('Tastaturbelegung des Dateieditors');
    expect(de['settings.appearance.languageFormats']).toBe('Sprache und Formate');
    expect(de['settings.appearance.followSystem']).toBe('System folgen');
    expect(de['settings.chat.sorted']).toBe('Sortiert');
    expect(de['settings.chat.composerHistory']).toBe('Eingabe und Verlauf');
    expect(de['settings.chat.reasoningStreaming']).toBe('Begründung und Streaming');
    expect(de['settings.search.messageAppearance']).toBe('Nachrichtenerscheinung');
    expect(de['settings.search.toolsFiles']).toBe('Werkzeuge und Dateien');
    expect(de['settings.chat.defaultBudgetLabel']).toBe('Standardbudget');
    expect(de['settings.search.renderMode']).toBe('Chat-Darstellungsmodus');
    expect(de['settings.chat.sideBySideDiff']).toBe('Nebeneinander');
    expect(de['settings.search.followUp']).toBe('Folgeverhalten');
    expect(de['settings.chat.steerInFlightTurn']).toBe('Laufenden Durchlauf steuern');
    expect(de['settings.notifications.enable']).toBe('Benachrichtigungen aktivieren');
    expect(interpolate(de['settings.chat.inputHistory.helper'], { max: 100, default: 40 })).toBe('1..100 Nachrichten, Standard 40');
    expect(de['settings.chat.inputHistory.unit']).toBe('Nachrichten');
    expect(interpolate(de['settings.chat.defaultBudget.helper'], { max: 100000000, step: 50000 })).toBe('1000..100000000 Tokens (Schritt 50000)');
    expect(de['settings.shortcuts.resetAll']).toBe('Alle zurücksetzen');
    expect(interpolate(de['settings.shortcuts.replaceable'], { otherActionId: 'focus_input' })).toBe('focus_input wird ersetzt');
    expect(dictionaryFor('tr')['shortcuts.label.cycle_agent']).toBe('Ajanı değiştir');
    expect(dictionaryFor('fr')['settings.chat.lineWrap']).toBe('Activer le retour à la ligne des longues lignes de code');
    expect(dictionaryFor('fr')['settings.search.keymap']).toBe('Configuration des touches de l’éditeur de fichiers');
    expect(dictionaryFor('pl')['shell.mockBanner']).toBe(
      'Środowisko testowe — integracja z NotNativeAgent nie jest jeszcze dostępna',
    );
    expect(dictionaryFor('xx')['app.title']).toBe(en['app.title']);
  });
});

describe('store (optimistic switch + cache, §H.2 store.ts)', () => {
  it('boots on the detection chain and swaps dictionaries on setLocale', async () => {
    const state = useI18nStore.getState();
    expect(state.locale).toBe('en');
    useI18nStore.getState().setLocale('de');
    expect(useI18nStore.getState().locale).toBe('de');
    expect(getCurrentIntlLocale()).toBe('de-DE');
    expect(document.documentElement.lang).toBe('de-DE');
    expect(useI18nStore.getState().dictionary['shell.send']).toBe('Senden');
    await Promise.resolve(); // optimistic marker clears after the (sync) load
    expect(useI18nStore.getState().loadingLocale).toBeNull();
    useI18nStore.getState().setLocale('en');
    expect(getCurrentIntlLocale()).toBe('en-US');
    expect(document.documentElement.lang).toBe('en-US');
    expect(useI18nStore.getState().dictionary['shell.send']).toBe('Send');
  });

  it('dedupes same-locale switches (no storage churn, stable dictionary)', () => {
    useI18nStore.getState().setLocale('en');
    const before = useI18nStore.getState().dictionary;
    window.localStorage.setItem('notnative.i18n.v1', 'SENTINEL');
    useI18nStore.getState().setLocale('en'); // same locale → no-op
    expect(window.localStorage.getItem('notnative.i18n.v1')).toBe('SENTINEL'); // untouched
    expect(useI18nStore.getState().dictionary).toBe(before);
  });

  it('switching to en keeps the loading marker null and caches catalog identity', async () => {
    useI18nStore.getState().setLocale('de');
    await Promise.resolve();
    const deDict = useI18nStore.getState().dictionary;
    useI18nStore.getState().setLocale('en');
    expect(useI18nStore.getState().loadingLocale).toBeNull();
    useI18nStore.getState().setLocale('de'); // cached catalog identity
    await Promise.resolve();
    expect(useI18nStore.getState().dictionary).toBe(deDict);
    useI18nStore.getState().setLocale('en');
  });

  it('persists the locale selection to storage (§H.2 runtime.ts)', () => {
    useI18nStore.getState().setLocale('ja');
    const raw = JSON.parse(window.localStorage.getItem('notnative.i18n.v1') ?? '{}');
    expect(raw.locale).toBe('ja');
    useI18nStore.getState().setLocale('en');
  });
});

describe('translate (resolve chain + interpolation, §H.2/§H.3)', () => {
  it('resolves active dictionary → en → key and interpolates {name}', () => {
    useI18nStore.getState().setLocale('de');
    expect(translate('shell.send')).toBe('Senden');
    expect(translate('shell.busy')).toBe('Wird ausgeführt…');
    expect(translate('template.test' as I18nKey)).toBe('template.test'); // last resort
    expect(translate('bootstrap.devServerWait', { port: 3902 })).toBe('Waiting for the dev server… (port 3902)');
    useI18nStore.getState().setLocale('en');
    expect(translate('bootstrap.devServerWait', { port: 3902 })).toContain('3902');
    expect(translate('bootstrap.devServerWait')).toContain('{port}'); // missing param = raw token (§H.3)
  });

  it('interpolate replaces every placeholder occurrence; missing params stay raw', () => {
    expect(interpolate('{a} then {a} and {b}', { a: 'x', b: 'y' })).toBe('x then x and y');
    expect(interpolate('{a} then {a}', {})).toBe('{a} then {a}');
    expect(interpolate('no tokens', { a: 1 })).toBe('no tokens');
  });
});

describe('bootstrap strings (§H.2 bootstrap.ts)', () => {
  it('speaks the detected locale before dictionaries install', () => {
    const enStrings = bootstrapStrings('en');
    expect(enStrings['bootstrap.connecting']).toBe('Connecting…');
    expect(enStrings['shell.connected']).toBe('Harness connected');
    const deStrings = bootstrapStrings('de');
    expect(deStrings['bootstrap.cliMissing']).toBe('Harness CLI not found on this machine.'); // untranslated → en fallback
    expect(deStrings['shell.connected']).toBe('Mit dem Harness verbunden');
  });
});
