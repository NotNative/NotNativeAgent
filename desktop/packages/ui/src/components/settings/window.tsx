// SPDX-License-Identifier: Apache-2.0
/**
 * SettingsWindow (doc 14 §G.1) + SettingsView (§G.2/§G.6): the centered
 * dialog chrome, grouped page tree, search-with-jump (data-settings-item
 * scroll + 1600 ms highlight), and the page registry. Bootstrap-grade
 * settings sync + appearance appliers bind on first open. Landing pages
 * render their registered-phase note — never a silent gap. The window
 * refuses to close while a nested recording dialog owns input (§G.1).
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { suspendShortcutRegistry } from '../../lib/shortcuts/registry.ts';
import { useI18n } from '../I18nProvider.tsx';
import type { I18nKey } from '../../lib/i18n/messages/en.ts';
import { SETTINGS_PAGE_ORDER, isBuiltPage, searchIndex, type SettingsPageSlug } from './search.ts';
import { AppearancePage } from './pages/appearance.tsx';
import { ChatPage } from './pages/chat.tsx';
import { SessionsPage } from './pages/sessions.tsx';
import { SpeechPage } from './pages/speech.tsx';
import { NotificationsPage } from './pages/notifications.tsx';
import { ShortcutsPage } from './pages/shortcuts.tsx';
import { GeneralPage } from './pages/general.tsx';
import { ProvidersPage } from './pages/providers.tsx';
import { NativeConfigurationPage } from './pages/native-configuration.tsx';
import { NativeTuiPreferencesPage } from './pages/native-tui-preferences.tsx';
import { NativeRoutesPage } from './pages/native-routes.tsx';
import { McpPage } from './pages/mcp.tsx';
import { SkillsPage } from './pages/skills.tsx';
import { SkillsCatalogPage } from './pages/skills-catalog.tsx';
import { AgentsPage } from './pages/agents.tsx';
import { SnippetsPage } from './pages/snippets.tsx';
import { RemoteInstancesPage } from './pages/remote-instances.tsx';
import { ErrorBoundary } from '../ErrorBoundary.tsx';
import { NATIVE_SETTINGS_PAGES } from '../../lib/settings/native-registry.ts';
import { NativeFoundationPage, NativePreferenceStatus, NATIVE_FOUNDATION_SEARCH } from './pages/native-foundation.tsx';
import { AgentSettingsPage } from './pages/agent-settings.tsx';
import { AGENT_SETTINGS_SEARCH } from './pages/agent-settings-fields.ts';
import { OperationalSettingsPage } from './pages/operational-settings.tsx';
import { isOperationalPage, OPERATIONAL_SEARCH } from './pages/operational-registry.ts';
import { SettingsEditBoundary, useSettingsLeave } from './edit-boundary.tsx';
import './settings-cohesion.css';
import { onRuntimeEndpointChanged } from '../../lib/runtime-switch.ts';
import { nativeObservationScope } from './pages/use-native-observation.ts';

export { PAGE_TITLE_KEYS };

const PAGE_COMPONENTS: Partial<Record<SettingsPageSlug, (navigate: (page: SettingsPageSlug) => void) => ReactNode>> = {
  appearance: () => <AppearancePage />,
  chat: () => <ChatPage />,
  sessions: () => <SessionsPage />,
  notifications: () => <NotificationsPage />,
  shortcuts: () => <ShortcutsPage />,
  general: () => <GeneralPage />,
  providers: navigate => <ProvidersPage onOpenConfiguration={() => navigate('native-configuration')} />,
  'agent-policy': () => <AgentSettingsPage page="agent-policy" />,
  'agent-context': () => <AgentSettingsPage page="agent-context" />,
  'native-configuration': () => <NativeConfigurationPage />,
  'native-tui': () => <NativeTuiPreferencesPage />,
  'native-routes': () => <NativeRoutesPage />,
  agents: () => <AgentsPage />,
  mcp: () => <McpPage />,
  'skills.installed': () => <SkillsPage />,
  'skills.catalog': () => <SkillsCatalogPage />,
  snippets: () => <SnippetsPage />,
  'remote-instances': () => <RemoteInstancesPage />,
  integrations: () => <SpeechPage />,
};

const PAGE_TITLE_KEYS: Record<SettingsPageSlug, I18nKey> = {
  general: 'settings.page.general.title',
  appearance: 'settings.page.appearance.title',
  chat: 'settings.page.chat.title',
  notifications: 'settings.page.notifications.title',
  sessions: 'settings.page.sessions.title',
  shortcuts: 'settings.page.shortcuts.title',
  usage: 'settings.page.usage.title',
  integrations: 'settings.page.integrations.title',
  projects: 'settings.page.projects.title',
  'remote-instances': 'settings.page.remoteInstances.title',
  tunnel: 'settings.page.tunnel.title',
  git: 'settings.page.git.title',
  providers: 'settings.page.providers.title',
  'agent-policy': 'settings.page.agentPolicy.title',
  'agent-context': 'settings.page.agentContext.title',
  'operations-tools': 'settings.page.operationalTools.title',
  'operations-search': 'settings.page.operationalSearch.title',
  'operations-services': 'settings.page.operationalServices.title',
  'operations-data': 'settings.page.operationalData.title',
  'operations-trust': 'settings.page.trustSecrets.title',
  'native-configuration': 'settings.page.nativeConfiguration.title',
  'native-tui': 'settings.page.nativeTui.title',
  'native-routes': 'settings.page.nativeRoutes.title',
  agents: 'settings.page.agents.title',
  behavior: 'settings.page.behavior.title',
  commands: 'settings.page.commands.title',
  mcp: 'settings.page.mcp.title',
  plugins: 'settings.page.plugins.title',
  'magic-prompts': 'settings.page.magicPrompts.title',
  snippets: 'settings.page.snippets.title',
  'skills.installed': 'settings.page.skills.title',
  'skills.catalog': 'settings.page.skillsCatalog.title',
};

interface SearchResult {
  id: string;
  page: SettingsPageSlug;
  title: string;
}

const NATIVE_ALPHA_PAGES = new Set<SettingsPageSlug>(NATIVE_SETTINGS_PAGES.map(page => page.slug));
const availablePage = (page: SettingsPageSlug | undefined, nativeAlpha: boolean): SettingsPageSlug =>
  nativeAlpha && (!page || !NATIVE_ALPHA_PAGES.has(page)) ? 'general' : page ?? 'general';

let highlightTimer: number | null = null;

export function SettingsWindow({ initialPage, onClose, onPageChange, nativeAlpha = false }: { initialPage?: SettingsPageSlug; onClose: () => void; onPageChange?: (page: SettingsPageSlug) => void; nativeAlpha?: boolean }): ReactNode {
  return <SettingsEditBoundary><SettingsWindowContent initialPage={initialPage} onClose={onClose} onPageChange={onPageChange} nativeAlpha={nativeAlpha} /></SettingsEditBoundary>;
}

function SettingsWindowContent({ initialPage, onClose, onPageChange, nativeAlpha }: { initialPage?: SettingsPageSlug; onClose: () => void; onPageChange?: (page: SettingsPageSlug) => void; nativeAlpha: boolean }): ReactNode {
  const { t } = useI18n();
  const leave = useSettingsLeave();
  const [page, setPage] = useState<SettingsPageSlug>(availablePage(initialPage, nativeAlpha));
  useEffect(() => { setPage(availablePage(initialPage, nativeAlpha)); }, [initialPage, nativeAlpha]);
  const navigate = useCallback((next: SettingsPageSlug): void => {
    const selected = availablePage(next, nativeAlpha);
    if (selected !== page) leave(() => { setPage(selected); onPageChange?.(selected); });
  }, [nativeAlpha, onPageChange, leave, page]);
  const [query, setQuery] = useState('');
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const results = useMemo(() => matchesFor(query, t, nativeAlpha), [query, t, nativeAlpha]);

  // §I.2: the window SUSPENDS the app registry while open (search input is
  // an editable; global chords must not fire behind the dialog).
  useEffect(() => {
    suspendShortcutRegistry(true);
    return () => suspendShortcutRegistry(false);
  }, []);

  useSettingsHighlight(pendingJump, page, setHighlight, setPendingJump);

  const jumpTo = useCallback((result: SearchResult): void => {
    setPendingJump(result.id);
    setQuery('');
    navigate(result.page);
  }, [navigate]);

  // §G.1: refuse to close while a nested machine (recorder) owns input.
  const requestClose = useCallback((): void => {
    if (document.querySelector('[data-nnd-recording-overlay]') !== null) return;
    leave(onClose);
  }, [onClose, leave]);

  return (
    <SettingsDialog
      page={page}
      query={{ query, setQuery: value => { if (!query && value) leave(() => setQuery(value)); else setQuery(value); }, searchResults: results, jumpTo, setPage: navigate }}
      requestClose={requestClose}
      highlight={highlight}
      pendingJump={pendingJump}
      nativeAlpha={nativeAlpha}
    />
  );
}

function useSettingsHighlight(pendingJump: string | null, page: SettingsPageSlug,
  setHighlight: (value: string | null) => void, setPendingJump: (value: string | null) => void): void {
  // Why: native pages load their fields asynchronously; one frame can precede their controls.
  useEffect(() => {
    if (pendingJump === null) return;
    const id = pendingJump;
    let finished = false;
    const observer = new MutationObserver(() => locate());
    const deadline = window.setTimeout(() => { finished = true; observer.disconnect(); setPendingJump(null); }, 26000);
    const locate = () => {
      if (finished) return;
      const target = document.getElementById(`jump-target-${id}`) ?? document.querySelector(`[data-settings-item="${cssEscape(id)}"]`);
      if (target instanceof HTMLElement) {
        finished = true; observer.disconnect(); window.clearTimeout(deadline);
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
        target.setAttribute('data-settings-search-highlight', 'true');
        setHighlight(id);
        if (highlightTimer !== null) window.clearTimeout(highlightTimer);
        highlightTimer = window.setTimeout(() => {
          highlightTimer = null;
          setHighlight(null);
          target.removeAttribute('data-settings-search-highlight');
        }, 1600);
        setPendingJump(null);
      }
    };
    observer.observe(document.body, { childList: true, subtree: true });
    const frame = requestAnimationFrame(locate);
    return () => { finished = true; observer.disconnect(); window.clearTimeout(deadline); cancelAnimationFrame(frame); };
  }, [pendingJump, page]);
}

function SettingsDialog({
  page, query, requestClose, highlight, nativeAlpha, pendingJump,
}: {
  page: SettingsPageSlug;
  query: HeaderSearch;
  requestClose: () => void;
  highlight: string | null;
  nativeAlpha: boolean;
  pendingJump: string | null;
}): ReactNode {
  const { t } = useI18n();
  const searching = query.query.trim().length > 0;
  const scope = useSyncExternalStore(onRuntimeEndpointChanged, nativeObservationScope);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { if (content.current) content.current.scrollTop = 0; }, [page]);
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-[var(--oc-glass-blur)]"
      role="dialog"
      aria-label={t('settings.window.title')}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="flex h-[85vh] max-h-[900px] w-[90vw] max-w-[1200px] flex-col rounded-xl border border-border/60 bg-background shadow-2xl" data-testid="settings-window" data-native-settings={nativeAlpha || undefined}>
        <SettingsHeader search={query} requestClose={requestClose} />
        {nativeAlpha && ['general', 'appearance', 'chat', 'notifications', 'shortcuts'].includes(page) ? <NativePreferenceStatus /> : null}
        {searching ? (
          <SearchResultsPanel results={query.searchResults} onJump={query.jumpTo} />
        ) : (
          <div className="flex min-h-0 flex-1">
            <SettingsNav page={page} onNavigate={query.setPage} nativeAlpha={nativeAlpha} />
            <div ref={content} className="min-w-0 flex-1 overflow-y-auto px-4 py-3" data-highlight={highlight ?? undefined}>
              <ErrorBoundary key={nativeAlpha ? scope : 'compatibility'}>
                {renderPage(page, t, query.setPage, nativeAlpha, pendingJump)}
              </ErrorBoundary>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function matchesFor(query: string, t: (key: I18nKey) => string, nativeAlpha: boolean): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  if (nativeAlpha) {
    const fields = [...NATIVE_FOUNDATION_SEARCH, ...AGENT_SETTINGS_SEARCH, ...OPERATIONAL_SEARCH].filter(item => `${item.title} ${item.keywords}`.toLowerCase().includes(needle))
      .map(item => ({ id: item.id, page: item.page as SettingsPageSlug, title: item.title }));
    const pages = NATIVE_SETTINGS_PAGES.filter(item => !fields.some(field => field.page === item.slug) && `${item.title} ${item.keywords}`.toLowerCase().includes(needle))
      .map(item => ({ id: `native.page.${item.slug}`, page: item.slug as SettingsPageSlug, title: item.title }));
    return [...fields, ...pages];
  }
  return searchIndex()
    .filter((item) => !nativeAlpha || NATIVE_ALPHA_PAGES.has(item.page))
    .filter((item) => {
      const title = t(item.titleKey);
      return title.toLowerCase().includes(needle) || item.keywords.includes(needle) || item.id.toLowerCase().includes(needle);
    })
    .map((item) => ({ id: item.id, page: item.page, title: t(item.titleKey) }));
}

interface HeaderSearch {
  query: string;
  setQuery: (query: string) => void;
  searchResults: SearchResult[];
  jumpTo: (result: SearchResult) => void;
  setPage: (slug: SettingsPageSlug) => void;
}

function SettingsHeader({ search, requestClose }: { search: HeaderSearch; requestClose: () => void }): ReactNode {
  const { t } = useI18n();
  return (
    <header className="flex items-center gap-3 border-b border-border/50 px-4 py-2">
      <span className="text-sm font-semibold text-foreground">{t('settings.window.title')}</span>
      <div className="ml-4 flex h-8 w-80 items-center rounded-md border border-border/60 bg-interactive-hover/30 px-2" data-settings-search="">
        <input
          className="h-full w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={t('settings.window.searchPlaceholder')}
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') search.setQuery('');
            if (event.key === 'Enter' && search.searchResults.length > 0) search.jumpTo(search.searchResults[0]!);
          }}
        />
      </div>
      <button type="button" aria-label="Close settings" className="ml-auto rounded px-2 py-1 text-muted-foreground hover:text-foreground" onClick={requestClose}>
        ✕
      </button>
    </header>
  );
}

function SearchResultsPanel({
  results, onJump,
}: { results: SearchResult[]; onJump: (result: SearchResult) => void }): ReactNode {
  const { t } = useI18n();
  return (
    <div className="flex-1 overflow-y-auto p-4">
      {results.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('settings.window.searchNoResults')}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {results.map((result) => (
            <button
              key={result.id}
              type="button"
              className="flex items-center justify-between rounded px-2 py-1.5 text-left hover:bg-interactive-hover/40"
              onClick={() => onJump(result)}
            >
              <span className="text-xs text-foreground">{result.title}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t(PAGE_TITLE_KEYS[result.page])}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function renderPage(slug: SettingsPageSlug, t: (key: I18nKey) => string,
  navigate: (page: SettingsPageSlug) => void, nativeAlpha: boolean, pendingJump?: string | null): ReactNode {
  if (nativeAlpha && isOperationalPage(slug)) return <OperationalSettingsPage key={slug} page={slug} focusItem={pendingJump} />;
  if (nativeAlpha && slug === 'native-configuration') return <NativeConfigurationPage nativeOnly />;
  if (nativeAlpha && ['general', 'appearance', 'chat', 'notifications'].includes(slug)) return <NativeFoundationPage page={slug} />;
  if (nativeAlpha && slug === 'shortcuts') return <ShortcutsPage native />;
  const built = PAGE_COMPONENTS[slug];
  if (built !== undefined) return built(navigate);
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <div className="text-sm font-medium text-foreground">{t(PAGE_TITLE_KEYS[slug])}</div>
      <div className="max-w-sm text-xs text-muted-foreground">{t('settings.common.landingBody')}</div>
    </div>
  );
}

function SettingsNav({ page, onNavigate, nativeAlpha }: { page: SettingsPageSlug; onNavigate: (slug: SettingsPageSlug) => void; nativeAlpha: boolean }): ReactNode {
  const { t } = useI18n();
  if (nativeAlpha) return <nav aria-label="Settings pages" className="w-48 shrink-0 overflow-y-auto border-r border-border/50 p-3">
    {['Preferences', 'Agent', 'Capabilities', 'System'].map(group => <div key={group} className="mb-5">
      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">{group}</h2>
      {NATIVE_SETTINGS_PAGES.filter(item => item.group === group).map(item => <button key={item.slug} type="button" aria-current={page === item.slug ? 'page' : undefined}
        className={`mb-1 block w-full rounded px-2 py-2 text-left text-sm ${page === item.slug ? 'bg-primary/15 text-primary' : 'hover:bg-interactive-hover/40'}`}
        onClick={() => onNavigate(item.slug)}>{item.title}</button>)}
    </div>)}
  </nav>;
  const groups = ['general', 'projects', 'opencode', 'content'] as const;
  return (
    <nav className="w-56 shrink-0 overflow-y-auto border-r border-border/50 px-2 py-3">
      {groups.filter((group) => SETTINGS_PAGE_ORDER.some((entry) => entry.group === group
        && (!nativeAlpha || NATIVE_ALPHA_PAGES.has(entry.slug)))).map((group) => (
        <div key={group} className="mb-3">
          <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group}</div>
          {SETTINGS_PAGE_ORDER.filter((entry) => entry.group === group
            && (!nativeAlpha || NATIVE_ALPHA_PAGES.has(entry.slug))).map((entry) => (
            <button
              key={entry.slug}
              type="button"
              className={`mb-0.5 flex w-full items-center rounded px-2 py-1 text-left text-xs ${
                page === entry.slug ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-interactive-hover/40'
              }`}
              onClick={() => onNavigate(entry.slug)}
            >
              {t(entry.titleKey)}
              {isBuiltPage(entry.slug) ? null : (
                <span className="ml-auto text-[9px] uppercase text-muted-foreground">phase</span>
              )}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function cssEscape(id: string): string {
  return id.replaceAll('"', '\\"');
}
