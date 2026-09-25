// SPDX-License-Identifier: Apache-2.0
/**
 * SettingsWindow (doc 14 §G.1) + SettingsView (§G.2/§G.6): the centered
 * dialog chrome, grouped page tree, search-with-jump (data-settings-item
 * scroll + 1600 ms highlight), and the page registry. Bootstrap-grade
 * settings sync + appearance appliers bind on first open. Landing pages
 * render their registered-phase note — never a silent gap. The window
 * refuses to close while a nested recording dialog owns input (§G.1).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { suspendShortcutRegistry } from '../../lib/shortcuts/registry.ts';
import { useI18n } from '../I18nProvider.tsx';
import type { I18nKey } from '../../lib/i18n/messages/en.ts';
import { SETTINGS_PAGE_ORDER, isBuiltPage, searchIndex, type SettingsPageSlug } from './search.ts';
import { AppearancePage } from './pages/appearance.tsx';
import { ChatPage } from './pages/chat.tsx';
import { SessionsPage } from './pages/sessions.tsx';
import { NotificationsPage } from './pages/notifications.tsx';
import { ShortcutsPage } from './pages/shortcuts.tsx';
import { GeneralPage } from './pages/general.tsx';
import { ProvidersPage } from './pages/providers.tsx';
import { McpPage } from './pages/mcp.tsx';
import { SkillsPage } from './pages/skills.tsx';
import { ErrorBoundary } from '../ErrorBoundary.tsx';

export { PAGE_TITLE_KEYS };

const PAGE_COMPONENTS: Partial<Record<SettingsPageSlug, () => ReactNode>> = {
  appearance: () => <AppearancePage />,
  chat: () => <ChatPage />,
  sessions: () => <SessionsPage />,
  notifications: () => <NotificationsPage />,
  shortcuts: () => <ShortcutsPage />,
  general: () => <GeneralPage />,
  providers: () => <ProvidersPage />,
  mcp: () => <McpPage />,
  'skills.installed': () => <SkillsPage />,
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

let highlightTimer: number | null = null;

export function SettingsWindow({ initialPage, onClose }: { initialPage?: SettingsPageSlug; onClose: () => void }): ReactNode {
  const { t } = useI18n();
  const [page, setPage] = useState<SettingsPageSlug>(initialPage ?? 'general');
  const [query, setQuery] = useState('');
  const [pendingJump, setPendingJump] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const results = useMemo(() => matchesFor(query, t), [query, t]);

  // §I.2: the window SUSPENDS the app registry while open (search input is
  // an editable; global chords must not fire behind the dialog).
  useEffect(() => {
    suspendShortcutRegistry(true);
    return () => suspendShortcutRegistry(false);
  }, []);

  // §G.6: rAF-wait for the page DOM, scroll to the anchor, highlight 1600 ms.
  useEffect(() => {
    if (pendingJump === null) return;
    const id = pendingJump;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`jump-target-${id}`) ?? document.querySelector(`[data-settings-item="${cssEscape(id)}"]`);
      if (target instanceof HTMLElement) {
        if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
        target.setAttribute('data-settings-search-highlight', 'true');
        setHighlight(id);
        if (highlightTimer !== null) window.clearTimeout(highlightTimer);
        highlightTimer = window.setTimeout(() => {
          highlightTimer = null;
          setHighlight(null);
          target.removeAttribute('data-settings-search-highlight');
        }, 1600);
      }
      setPendingJump(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingJump, page]);

  const jumpTo = useCallback((result: SearchResult): void => {
    setPendingJump(result.id);
    setQuery('');
    setPage(result.page);
  }, []);

  // §G.1: refuse to close while a nested machine (recorder) owns input.
  const requestClose = useCallback((): void => {
    if (document.querySelector('[data-nnd-recording-overlay]') !== null) return;
    onClose();
  }, [onClose]);

  return (
    <SettingsDialog
      page={page}
      query={{ query, setQuery, searchResults: results, jumpTo, setPage }}
      requestClose={requestClose}
      highlight={highlight}
    />
  );
}

function SettingsDialog({
  page, query, requestClose, highlight,
}: {
  page: SettingsPageSlug;
  query: HeaderSearch;
  requestClose: () => void;
  highlight: string | null;
}): ReactNode {
  const { t } = useI18n();
  const searching = query.query.trim().length > 0;
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-[var(--oc-glass-blur)]"
      role="dialog"
      aria-label={t('settings.window.title')}
      onClick={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="flex h-[85vh] max-h-[900px] w-[90vw] max-w-[1200px] flex-col rounded-xl border border-border/60 bg-background shadow-2xl" data-testid="settings-window">
        <SettingsHeader search={query} requestClose={requestClose} />
        {searching ? (
          <SearchResultsPanel results={query.searchResults} onJump={query.jumpTo} />
        ) : (
          <div className="flex min-h-0 flex-1">
            <SettingsNav page={page} onNavigate={query.setPage} />
            <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3" data-highlight={highlight ?? undefined}>
              <ErrorBoundary>
                {renderPage(page, t)}
              </ErrorBoundary>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function matchesFor(query: string, t: (key: I18nKey) => string): SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return searchIndex()
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
      <button type="button" className="ml-auto rounded px-2 py-1 text-muted-foreground hover:text-foreground" onClick={requestClose}>
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

function renderPage(slug: SettingsPageSlug, t: (key: I18nKey) => string): ReactNode {
  const built = PAGE_COMPONENTS[slug];
  if (built !== undefined) return built();
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <div className="text-sm font-medium text-foreground">{t(PAGE_TITLE_KEYS[slug])}</div>
      <div className="max-w-sm text-xs text-muted-foreground">{t('settings.common.landingBody')}</div>
    </div>
  );
}

function SettingsNav({ page, onNavigate }: { page: SettingsPageSlug; onNavigate: (slug: SettingsPageSlug) => void }): ReactNode {
  const { t } = useI18n();
  const groups = ['general', 'projects', 'opencode', 'content'] as const;
  return (
    <nav className="w-56 shrink-0 overflow-y-auto border-r border-border/50 px-2 py-3">
      {groups.map((group) => (
        <div key={group} className="mb-3">
          <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{group}</div>
          {SETTINGS_PAGE_ORDER.filter((entry) => entry.group === group).map((entry) => (
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
