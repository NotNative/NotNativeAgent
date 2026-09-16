// SPDX-License-Identifier: Apache-2.0
/**
 * Work-status panel (doc 05 §E.9, P3c): labelled rows grouped into presence-
 * collapsed sections. Desktop-only (hidden <desktop widths via the chat-area
 * query at the layout layer). Rows read warm caches only; no aggregate
 * endpoints.
 */
import { useSyncExternalStore, useState, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useGlobalSessionStatusStore } from '../sync/global-stores.ts';
import { contextUsage, resolveContextLimit, todoRows, subagentRows, sessionCostRollup } from './work-status.ts';
import { panelStatsIfNeeded, type PanelStats } from './panel-gate.ts';
import { useSessionViewStore } from '../sync/view-store.ts';

const PANEL_WIDTH = 300;

export function WorkStatusPanel({ store, engine }: { store: StoreApi<DirectoryStore>; engine: SyncEngine }): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const sessionID = useSessionViewStore.getState().currentSessionId;
  const [hidden, setHidden] = useState<string[]>([]);
  const [committed, setCommitted] = useState<PanelStats | null>(null);
  if (!sessionID) return null;

  // model limit resolves from the provider catalog; unknown model hides Context
  const messages = snapshot.message[sessionID] ?? [];
  const lastAssistant = [...messages].reverse().find((source) => (source as { role?: string }).role === 'assistant');
  const contextLimit = resolveContextLimit(snapshot.provider as never, (lastAssistant as { modelID?: string } | undefined)?.modelID);
  const context = contextUsage(snapshot, sessionID, contextLimit);
  const todos = todoRows(snapshot, sessionID);
  const subagents = subagentRows(snapshot, sessionID, statusPhraseOf(store));
  const stats = panelStatsIfNeeded(snapshot, sessionID, committed);
  if (stats && stats !== committed) {
    queueMicrotask(() => setCommitted(stats)); // commit-once render exit
  }
  const cost = sessionCostRollup(snapshot, sessionID);
  const branch = snapshot.vcs?.branch ?? '';
  // §E.3 recap renders inline in the composer band (chat-view), not a panel
  // section; §E.9 context-sources rows (skills/MCP/memory counts) land with
  // the doc-15 knowledge slice.

  const sections: { id: string; label: string; rows: (ReactNode | null)[] }[] = [];
  if (context.tokens !== null) {
    sections.push({
      id: 'session',
      label: 'Session',
      rows: [
        row('Context', context.percent === null ? 'unknown limit' : `${context.percent.toFixed(1)}%` + (context.tokens?.total ? ` · ${context.tokens?.total} tok` : '')),
        cost > 0 ? row('Cost', `$${cost.toFixed(2)}`) : null,
      ],
    });
  } else if (context.percent !== null) {
    sections.push({ id: 'session', label: 'Session', rows: [row('Context', `${context.percent.toFixed(1)}%`)] });
  }
  if (branch) sections.push({ id: 'project', label: 'Project', rows: [row('Branch', branch)] });
  // Usage section stays presence-collapsed until a quota provider registry
  // exists (doc 05 §G HARNESS PORT 9); it never shows the token label.
  if (stats && (stats.wholeTurnMS !== null || stats.outputTokens !== null)) {
    sections.push({
      id: 'telemetry',
      label: 'Turn stats',
      rows: [
        stats.responseSpeedTokensPerSec !== null ? row('Response', `${stats.responseSpeedTokensPerSec} tok/s`) : null,
        stats.wholeTurnMS !== null ? row('Whole turn', `${Math.round(stats.wholeTurnMS / 100) / 10}s · ${stats.steps} steps`) : null,
        stats.outputTokens !== null ? row('Tokens', `${stats.inputTokens ?? '—'} ↑ · ${stats.outputTokens} ↓`) : null,
      ],
    });
  }
  if (subagents.length > 0) {
    sections.push({ id: 'subagents', label: 'Subagents', rows: subagents.map((agent) => row(agent.title, `${agent.statusPhrase}${agent.cost ? ` · $${agent.cost.toFixed(2)}` : ''}`)) });
  }
  if (todos.length > 0) {
    sections.push({ id: 'tasks', label: 'Tasks', rows: todos.map((todo) => row(todo.content, todo.status, todo.status === 'completed' ? 'line-through' : '')) });
  }

  const visibleSections = sections.filter((section) => !hidden.includes(section.id));
  return (
    <aside className="hidden w-[300px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/10 bg-neutral-950/40 p-3 xl:flex" style={{ maxWidth: PANEL_WIDTH }} data-testid="work-status-panel">
      {visibleSections.length === 0 ? <div className="text-[11px] text-neutral-600">All sections hidden</div> : null}
      {visibleSections.map((section) => (
        <section key={section.id} className="rounded-lg border border-white/10 bg-neutral-900/40 p-2" data-testid={`ws-${section.id}`}>
          <header className="mb-1 flex items-center justify-between">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">{section.label}</h3>
            <button type="button" aria-label={`Hide ${section.label}`} className="text-[10px] text-neutral-700 hover:text-neutral-400" onClick={() => setHidden([...hidden, section.id])}>×</button>
          </header>
          <div className="flex flex-col gap-1">{section.rows.filter(Boolean).map((row, index) => <div key={index}>{row}</div>)}</div>
        </section>
      ))}
      {hidden.length > 0 ? (
        <footer><button type="button" className="text-[10px] text-neutral-600 underline" onClick={() => setHidden([])}>Restore sections</button></footer>
      ) : null}
    </aside>
  );

  function row(label: string, value: string | null, extraClass = ''): ReactNode {
    if (value === null || value.length === 0) return null;
    return (
      <div className="flex items-baseline justify-between gap-2 text-[11px]" data-testid={`ws-row-${label.toLowerCase().replace(/\W+/g, '-')}`}>
        <span className="min-w-0 shrink text-neutral-500">{label}</span>
        <span className={`min-w-0 truncate text-right text-neutral-300 ${extraClass}`}>{value}</span>
      </div>
    );
  }
}

function statusPhraseOf(store: StoreApi<DirectoryStore>): (sessionID: string) => 'working' | 'needs permission' | 'asked a question' | 'Done' {
  return (sessionID) => {
    const status = useGlobalSessionStatusStore.getState().statusById[sessionID];
    if (status && status.type !== 'idle') return 'working';
    if ((store.getState().permission[sessionID]?.length ?? 0) > 0) return 'needs permission';
    if ((store.getState().question[sessionID]?.length ?? 0) > 0) return 'asked a question';
    return 'Done';
  };
}
