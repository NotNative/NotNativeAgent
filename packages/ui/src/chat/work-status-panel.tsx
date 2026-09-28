// SPDX-License-Identifier: Apache-2.0
/**
 * Work-status panel (doc 05 §E.9, P3c): labelled rows grouped into presence-
 * collapsed sections. Desktop-only (hidden <desktop widths via the chat-area
 * query at the layout layer). Rows read warm caches only; no aggregate
 * endpoints.
 */
import { useEffect, useSyncExternalStore, useState, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useGlobalSessionStatusStore } from '../sync/global-stores.ts';
import type { SessionStatus } from '../lib/nnd/types.ts';
import { contextUsage, nnaActiveTools, nnaContextUsage, nnaGovernanceSummary, nnaSessionConfiguredModel, nnaTurnPhase, nnaWorkSummary, resolveContextLimit, todoRows, subagentRows, sessionCostRollup } from './work-status.ts';
import { panelStatsIfNeeded, type PanelStats } from './panel-gate.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { resolveComposerModel } from './composer-model-config.ts';
import { contextMessageLedger, MAX_LEDGER_ROWS } from './context-message-ledger.ts';

const PANEL_WIDTH = 300;

export function WorkStatusPanel({ store, engine, embedded = false, expanded = false, onOpenSubagent, sessionID: scopedSessionID }: { store: StoreApi<DirectoryStore>; engine: SyncEngine; embedded?: boolean; expanded?: boolean; onOpenSubagent?: (sessionID: string) => void; sessionID?: string | null }): ReactNode {
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const statusById = useGlobalSessionStatusStore((state) => state.statusById);
  const selectedSessionID = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState).currentSessionId;
  const sessionID = scopedSessionID === undefined ? selectedSessionID : scopedSessionID;
  const [hidden, setHidden] = useState<string[]>([]);
  const [committed, setCommitted] = useState<{ sessionID: string; stats: PanelStats } | null>(null);
  const committedForSession = committed?.sessionID === sessionID ? committed.stats : null;
  const stats = sessionID ? panelStatsIfNeeded(snapshot, sessionID, committedForSession) : null;
  useEffect(() => {
    if (sessionID && stats && stats !== committedForSession) setCommitted({ sessionID, stats });
  }, [committedForSession, sessionID, stats]);
  if (!sessionID) return <aside className={`${embedded ? 'flex w-full' : 'hidden w-[300px] xl:flex'} p-3 text-xs text-neutral-500`}
    data-testid="work-status-panel">Select a session to inspect its NNA context.</aside>;

  // model limit resolves from the provider catalog; unknown model hides Context
  const messages = snapshot.message[sessionID] ?? [];
  const ledger = contextMessageLedger(messages, snapshot.part);
  const lastAssistant = [...messages].reverse().find((source) => (source as { role?: string }).role === 'assistant');
  // A later assistant message may have no total yet (for example, while it
  // streams). Match the limit to the message that actually reported usage.
  const lastReportingAssistant = [...messages].reverse().find((source) => source.role === 'assistant' && source.tokens?.total) as { providerID?: string; modelID?: string } | undefined;
  const reportingProviders = lastReportingAssistant?.providerID
    ? snapshot.provider.filter((provider) => (provider as { id?: string }).id === lastReportingAssistant.providerID)
    : [];
  const contextLimit = resolveContextLimit(reportingProviders as never, lastReportingAssistant?.modelID);
  const context = contextUsage(snapshot, sessionID, contextLimit);
  const nnaContext = nnaContextUsage(snapshot, sessionID);
  // These are different measurements. An NNA estimate without a known limit
  // must not borrow the percentage of a provider-reported assistant message.
  const contextPercent = nnaContext ? nnaContext.percent : context.percent;
  const turnPhase = nnaTurnPhase(snapshot, sessionID);
  const activeTools = nnaActiveTools(snapshot, sessionID);
  const turnLabel = turnPhase ? turnPhaseLabel(turnPhase) : null;
  const governance = nnaGovernanceSummary(snapshot, sessionID);
  const work = nnaWorkSummary(snapshot, sessionID);
  const sessionModel = nnaSessionConfiguredModel(snapshot, sessionID);
  const configuredModel = resolveComposerModel(snapshot.config, null, 'nna');
  const selectedSession = snapshot.session.find((session) => session.id === sessionID);
  const reportedTokens = (lastAssistant as { tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } } | undefined)?.tokens;
  const tokenFacts = [
    reportedToken('Input', reportedTokens?.input),
    reportedToken('Output', reportedTokens?.output),
    reportedToken('Reasoning', reportedTokens?.reasoning),
    reportedToken('Cache read', reportedTokens?.cache?.read),
    reportedToken('Cache write', reportedTokens?.cache?.write),
  ].filter((item): item is { label: string; value: string } => item !== null);
  const todos = configuredModel.nnaConfigured || work ? [] : todoRows(snapshot, sessionID);
  const subagents = subagentRows(snapshot, sessionID, statusPhraseOf(snapshot, statusById));
  const cost = sessionCostRollup(snapshot, sessionID);
  const branch = snapshot.vcs?.branch ?? '';
  const latestTool = [...snapshot.activity].reverse().find((record) => record.sessionID === sessionID && record.kind === 'tool');
  // §E.3 recap renders inline in the composer band (chat-view), not a panel
  // section; §E.9 context-sources rows (skills/MCP/memory counts) land with
  // the doc-15 knowledge slice.

  const sections: { id: string; label: string; rows: (ReactNode | null)[] }[] = [];
  // Prefer the session-owned route, including for children. The legacy global
  // /config identity is only a root fallback and must never label a child.
  const routeLabel = sessionModel ? `${sessionModel.providerID} · ${sessionModel.modelID}`
    : configuredModel.nnaConfigured && selectedSession && selectedSession.parentID === undefined ? configuredModel.modelLabel : null;
  if (routeLabel) sections.push({ id: 'engine', label: 'NNA engine', rows: [
    row('Configured route', routeLabel),
  ] });
  const pendingPermissions = snapshot.permission[sessionID]?.length ?? 0;
  const pendingQuestions = snapshot.question[sessionID]?.length ?? 0;
  if (pendingPermissions || pendingQuestions) sections.push({ id: 'attention', label: 'Needs operator', rows: [
    pendingPermissions ? row('Approvals', String(pendingPermissions)) : null,
    pendingQuestions ? row('Questions', String(pendingQuestions)) : null,
  ] });
  if (governance) sections.push({ id: 'governance', label: 'Governance', rows: [
    governance.reviewPosture ? row('Review posture', governance.reviewPosture) : null,
    governance.recordHealth ? row('Record health', governance.recordHealth === 'attention' ? 'Needs attention' : governance.recordHealth === 'ready' ? 'Ready' : 'Unavailable') : null,
    governance.durable !== undefined ? row('Evidence journal', governance.durable ? 'Durable' : 'Ephemeral') : null,
    governance.attentionEvidence ? row('Attention evidence', String(governance.attentionEvidence)) : null,
    governance.unsettledDecisions ? row('Unsettled decisions', String(governance.unsettledDecisions)) : null,
    governance.uncertainEffects ? row('Uncertain effects', String(governance.uncertainEffects)) : null,
  ] });
  if (work?.goal) sections.push({ id: 'goal', label: 'Goal', rows: [
    row('Objective', work.goal.objective),
    row('Status', work.goal.status),
  ] });
  if (nnaContext) {
    sections.push({ id: 'session', label: 'Session', rows: [
      turnLabel ? row('Turn', turnLabel) : null,
      row('Context', nnaContext.percent === null ? 'Limit unknown' : `${nnaContext.percent.toFixed(1)}% estimated`),
      row('Estimated use', `${nnaContext.estimatedTokens.toLocaleString()} tokens`),
      nnaContext.limitTokens === null ? null : row('Limit', `${nnaContext.limitTokens.toLocaleString()} tokens`),
      cost > 0 ? row('Cost', `$${cost.toFixed(2)}`) : null] });
  } else if (context.tokens !== null) {
    sections.push({
      id: 'session',
      label: 'Session',
      rows: [
        turnLabel ? row('Turn', turnLabel) : null,
        row('Context', context.percent === null ? 'unknown limit' : `${context.percent.toFixed(1)}%` + (context.tokens?.total ? ` · ${context.tokens?.total} tok` : '')),
        cost > 0 ? row('Cost', `$${cost.toFixed(2)}`) : null,
      ],
    });
  } else if (context.percent !== null) {
    sections.push({ id: 'session', label: 'Session', rows: [
      turnLabel ? row('Turn', turnLabel) : null,
      row('Context', `${context.percent.toFixed(1)}%`),
    ] });
  } else if (turnLabel) {
    sections.push({ id: 'session', label: 'Session', rows: [row('Turn', turnLabel)] });
  }
  if (branch) sections.push({ id: 'project', label: 'Project', rows: [row('Branch', branch)] });
  if (activeTools && activeTools.count > 0) sections.push({ id: 'active-tools', label: `Running tools (${activeTools.count})`, rows:
    activeTools.names.map((name, index) => row(`Tool ${index + 1}`, name)) });
  if (latestTool) sections.push({ id: 'latest-tool', label: 'Latest tool event', rows: [
    row('Event', latestTool.summary), row('State', latestTool.status === 'attention' ? 'Needs input' : latestTool.status),
  ] });
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
    sections.push({ id: 'subagents', label: 'Subagents', rows: subagents.map((agent) => onOpenSubagent
      ? <button key={agent.sessionID} type="button" className="flex w-full items-baseline justify-between gap-2 rounded px-1 py-1 text-left text-[11px] hover:bg-white/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-sky-400"
          aria-label={`Open ${agent.title} subagent transcript`} onClick={() => onOpenSubagent(agent.sessionID)}>
          <span className="min-w-0 truncate text-sky-300">{agent.title}</span>
          <span className="min-w-0 truncate text-right text-neutral-500">{agent.statusPhrase}{agent.cost ? ` · $${agent.cost.toFixed(2)}` : ''}</span>
        </button>
      : row(agent.title, `${agent.statusPhrase}${agent.cost ? ` · $${agent.cost.toFixed(2)}` : ''}`)) });
  }
  if (work?.tasks.length) {
    sections.push({ id: 'tasks', label: 'Tasks', rows: work.tasks.map((task) => row(task.title,
      task.status === 'in_progress' ? 'in progress' : task.status,
      task.status === 'completed' ? 'line-through' : '')) });
  } else if (todos.length > 0) {
    sections.push({ id: 'tasks', label: 'Tasks', rows: todos.map((todo) => row(todo.content, todo.status, todo.status === 'completed' ? 'line-through' : '')) });
  }

  const visibleSections = sections.filter((section) => !hidden.includes(section.id));
  // The project branch is useful ambient workspace information, but it is
  // not evidence that the selected session has a context projection.
  const hasSessionDetails = sections.some((section) => section.id !== 'project') || (expanded && ledger.length > 0);
  return (
    <aside className={`${embedded ? 'flex w-full' : 'hidden w-[300px] xl:flex'} shrink-0 flex-col overflow-y-auto p-3`} style={{ maxWidth: embedded ? undefined : PANEL_WIDTH }} data-testid="work-status-panel">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3" data-testid="context-reading-column">
      {selectedSession ? <header className={expanded ? 'px-1 py-3' : 'px-1 py-1'} data-testid="context-session-header">
        <h2 className={`truncate font-medium text-neutral-200 ${expanded ? 'text-base' : 'text-sm'}`}>{selectedSession.title}</h2>
        {routeLabel ? <p className="mt-1 truncate text-xs text-neutral-500">{routeLabel}</p> : null}
      </header> : null}
      {(nnaContext || context.tokens || expanded && messages.length > 0) ? <section className={`rounded-lg border border-white/10 bg-neutral-900/40 ${expanded ? 'p-4' : 'p-3'}`} aria-label="Session usage" data-testid="context-usage-summary">
        <h3 className="text-xs font-medium text-neutral-300">Session usage</h3>
        {nnaContext || context.tokens ? <div className="mt-3">
          <div className="flex justify-between gap-3 text-[11px] text-neutral-500"><span>Context</span><span>{nnaContext
            ? `${nnaContext.estimatedTokens.toLocaleString()} estimated tokens${nnaContext.limitTokens ? ` / ${nnaContext.limitTokens.toLocaleString()} limit` : ' · limit unknown'}`
            : `${context.tokens?.total?.toLocaleString() ?? 'Usage reported'} reported tokens${context.percent === null ? ' · limit unknown' : ` · ${context.percent.toFixed(1)}% of model limit`}`}</span></div>
          {contextPercent !== null ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, contextPercent))}>
            <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, Math.max(0, contextPercent))}%` }} />
          </div> : null}
        </div> : null}
        {expanded ? <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {messages.length > 0 ? <UsageFact label="Loaded messages" value={messages.length.toLocaleString()} /> : null}
          {messages.length > 0 ? <UsageFact label="Loaded user" value={messages.filter((message) => message.role === 'user').length.toLocaleString()} /> : null}
          {messages.length > 0 ? <UsageFact label="Loaded assistant" value={messages.filter((message) => message.role === 'assistant').length.toLocaleString()} /> : null}
          {cost > 0 ? <UsageFact label="Recorded cost" value={`$${cost.toFixed(2)}`} /> : null}
        </div> : null}
        {expanded && tokenFacts.length > 0 ? <div className="mt-4 border-t border-white/10 pt-3" data-testid="context-last-assistant-usage">
          <h4 className="mb-2 text-[11px] text-neutral-400">Last assistant message · reported tokens</h4>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{tokenFacts.map((fact) => <UsageFact key={fact.label} {...fact} />)}</div>
        </div> : null}
      </section> : null}
      {expanded && ledger.length > 0 ? <section className="rounded-lg border border-white/10 bg-neutral-900/40 p-3" aria-label="Loaded message ledger" data-testid="context-message-ledger">
        <header className="mb-2 flex items-center justify-between gap-2 text-[11px]">
          <h3 className="font-medium text-neutral-300">Message ledger</h3>
          <span className="text-neutral-500">{messages.length > MAX_LEDGER_ROWS ? `Newest ${MAX_LEDGER_ROWS} of ${messages.length} loaded` : `${messages.length} loaded`}</span>
        </header>
        <p className="mb-2 text-[10px] text-neutral-600">Part kinds and reported tokens only; message content is not shown here.</p>
        <ol className="space-y-1" aria-label="Loaded messages, newest first">{ledger.map((item) => <li key={item.id} className="flex items-center gap-2 rounded bg-white/[0.03] px-2 py-1.5 text-[10px] text-neutral-400">
          <span className="min-w-0 flex-1 truncate" title={`${item.role} · ${item.kinds}`}>{item.role} · {item.kinds}</span>
          {item.input !== null || item.output !== null ? <span className="shrink-0 tabular-nums text-neutral-500" aria-label="Reported input and output tokens">{item.input === null ? '—' : item.input.toLocaleString()} / {item.output === null ? '—' : item.output.toLocaleString()}</span> : null}
          {item.created !== null ? <time className="shrink-0 text-neutral-600" dateTime={new Date(item.created).toISOString()}>{new Date(item.created).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time> : null}
        </li>)}</ol>
      </section> : null}
      {!hasSessionDetails ? <div className="text-[11px] text-neutral-500">NNA context details are not available for this session yet.</div> : null}
      {sections.length > 0 && visibleSections.length === 0 ? <div className="text-[11px] text-neutral-500">All sections hidden</div> : null}
      <div className={`${expanded ? 'grid grid-cols-1 gap-3 md:grid-cols-2' : 'flex flex-col gap-3'}`}>
      {visibleSections.map((section) => (
        <section key={section.id} className="rounded-lg border border-white/10 bg-neutral-900/40 p-2" data-testid={`ws-${section.id}`}>
          <header className="mb-1 flex items-center justify-between">
            <h3 className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">{section.label}</h3>
            <button type="button" aria-label={`Hide ${section.label}`} className="text-[10px] text-neutral-700 hover:text-neutral-400" onClick={() => setHidden([...hidden, section.id])}>×</button>
          </header>
          <div className="flex flex-col gap-1">{section.rows.filter(Boolean).map((row, index) => <div key={index}>{row}</div>)}</div>
        </section>
      ))}
      </div>
      {hidden.length > 0 ? (
        <footer><button type="button" className="text-[10px] text-neutral-600 underline" onClick={() => setHidden([])}>Restore sections</button></footer>
      ) : null}
      </div>
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

function reportedToken(label: string, count: unknown): { label: string; value: string } | null {
  return Number.isSafeInteger(count) && (count as number) >= 0 ? { label, value: (count as number).toLocaleString() } : null;
}

function UsageFact({ label, value }: { label: string; value: string }): ReactNode {
  return <div className="rounded-md bg-white/[0.03] px-3 py-2"><div className="text-[10px] text-neutral-500">{label}</div><div className="mt-1 text-xs text-neutral-200">{value}</div></div>;
}

function turnPhaseLabel(phase: string): string {
  return phase === 'awaiting_approval' ? 'Reviewing tool use'
    : phase.replaceAll('_', ' ').replace(/^./u, (letter) => letter.toUpperCase());
}

function statusPhraseOf(snapshot: DirectoryStore, statusById: Record<string, SessionStatus>): (sessionID: string) => string {
  return (sessionID) => {
    if ((snapshot.permission[sessionID]?.length ?? 0) > 0) return 'needs permission';
    if ((snapshot.question[sessionID]?.length ?? 0) > 0) return 'asked a question';
    const phase = nnaTurnPhase(snapshot, sessionID);
    if (phase === 'idle') return 'Idle';
    const status = statusById[sessionID];
    if (status && status.type !== 'idle') {
      return phase && phase !== 'idle' ? turnPhaseLabel(phase) : 'working';
    }
    // The global index removes idle entries. An explicit directory idle
    // record is evidence, but an absent record is not: this child may have
    // appeared after the last successful directory status snapshot. Neither
    // idle nor absence means the delegated task is "Done".
    if (snapshot.session_status[sessionID]?.type === 'idle') return 'Idle';
    return 'No live status';
  };
}
