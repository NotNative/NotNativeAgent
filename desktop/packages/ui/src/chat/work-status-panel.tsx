// SPDX-License-Identifier: Apache-2.0
import { ReviewModeControl } from './review-mode-control.tsx';
/**
 * Work-status panel (doc 05 §E.9, P3c): labelled rows grouped into presence-
 * collapsed sections. Desktop-only (hidden <desktop widths via the chat-area
 * query at the layout layer). Rows read warm caches only; no aggregate
 * endpoints.
 */
import { useEffect, useSyncExternalStore, useRef, useState, type ReactNode } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import { useGlobalSessionStatusStore } from '../sync/global-stores.ts';
import type { SessionStatus } from '../lib/nnd/types.ts';
import { useCurrentIntlLocale } from '../lib/i18n/intl.ts';
import { formatMoney } from '../lib/format/time.ts';
import { contextUsage, nnaActiveTools, nnaContextUsage, nnaGovernanceSummary, nnaSessionConfiguredModel, nnaTurnPhase, nnaWorkSummary, resolveContextLimit, todoRows, subagentRows, sessionCostRollup } from './work-status.ts';
import { panelStatsIfNeeded, type PanelStats } from './panel-gate.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import { resolveComposerModel } from './composer-model-config.ts';
import { contextMessageLedger, MAX_LEDGER_ROWS } from './context-message-ledger.ts';
import { setSessionMessagePinned, messagePinnedState } from './context-message-pins.ts';
import { useSessionOrgStore } from '../stores/useSessionOrgStore.ts';
import { normalizeDirectory } from '../lib/nnd/client.ts';
import { useSessionKnowledgeSummary } from './session-knowledge-summary.ts';

const PANEL_WIDTH = 300;

type PinAction = { sessionID: string; messageID: string; token: number };

export function WorkStatusPanel({ store, engine, embedded = false, expanded = false, onOpenSubagent, sessionID: scopedSessionID }: { store: StoreApi<DirectoryStore>; engine: SyncEngine; embedded?: boolean; expanded?: boolean; onOpenSubagent?: (sessionID: string) => void; sessionID?: string | null }): ReactNode {
  const intlLocale = useCurrentIntlLocale();
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const statusById = useGlobalSessionStatusStore((state) => state.statusById);
  const selectedSessionID = useSyncExternalStore(useSessionViewStore.subscribe, useSessionViewStore.getState).currentSessionId;
  const sessionID = scopedSessionID === undefined ? selectedSessionID : scopedSessionID;
  const [hidden, setHidden] = useState<string[]>([]);
  const [committed, setCommitted] = useState<{ sessionID: string; stats: PanelStats } | null>(null);
  const [pinAction, setPinAction] = useState<PinAction | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [knowledgePinAction, setKnowledgePinAction] = useState<string | null>(null);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const currentSessionIDRef = useRef<string | null | undefined>(sessionID);
  const pinActionRef = useRef<PinAction | null>(null);
  const pinActionTokenRef = useRef(0);
  const committedForSession = committed?.sessionID === sessionID ? committed.stats : null;
  const stats = sessionID ? panelStatsIfNeeded(snapshot, sessionID, committedForSession) : null;
  useEffect(() => {
    if (sessionID && stats && stats !== committedForSession) setCommitted({ sessionID, stats });
  }, [committedForSession, sessionID, stats]);
  useEffect(() => {
    currentSessionIDRef.current = sessionID;
    setPinError(null);
  }, [sessionID]);
  const selectedSession = snapshot.session.find((session) => session.id === sessionID);
  // Subscribed before the early return below: hooks must run unconditionally.
  const orgRecord = useSessionOrgStore((state) =>
    state.recordsByDirectory[normalizeDirectory(selectedSession?.directory ?? '')]?.[sessionID ?? '']);
  const knowledge = useSessionKnowledgeSummary({
    directory: selectedSession?.directory ?? '',
    sessionID: sessionID ?? '',
  });
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
  const messagePinIDs = messagePinnedState(selectedSession, orgRecord);
  const reportedTokens = (lastAssistant as { tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } } | undefined)?.tokens;
  const tokenFacts = [
    reportedToken('Input', reportedTokens?.input, intlLocale),
    reportedToken('Output', reportedTokens?.output, intlLocale),
    reportedToken('Reasoning', reportedTokens?.reasoning, intlLocale),
    reportedToken('Cache read', reportedTokens?.cache?.read, intlLocale),
    reportedToken('Cache write', reportedTokens?.cache?.write, intlLocale),
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
      row('Estimated use', `${nnaContext.estimatedTokens.toLocaleString(intlLocale)} tokens`),
      nnaContext.limitTokens === null ? null : row('Limit', `${nnaContext.limitTokens.toLocaleString(intlLocale)} tokens`),
      cost > 0 ? row('Cost', formatMoney(cost)) : null] });
  } else if (context.tokens !== null) {
    sections.push({
      id: 'session',
      label: 'Session',
      rows: [
        turnLabel ? row('Turn', turnLabel) : null,
        row('Context', context.percent === null ? 'unknown limit' : `${context.percent.toFixed(1)}%` + (context.tokens?.total ? ` · ${context.tokens.total.toLocaleString(intlLocale)} tok` : '')),
        cost > 0 ? row('Cost', formatMoney(cost)) : null,
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
          <span className="min-w-0 truncate text-right text-neutral-500">{agent.statusPhrase}{agent.cost ? ` · ${formatMoney(agent.cost)}` : ''}</span>
        </button>
      : row(agent.title, `${agent.statusPhrase}${agent.cost ? ` · ${formatMoney(agent.cost)}` : ''}`)) });
  }
  if (work?.tasks.length) {
    sections.push({ id: 'tasks', label: 'Tasks', rows: work.tasks.map((task) => row(task.title,
      task.status === 'in_progress' ? 'in progress' : task.status,
      task.status === 'completed' ? 'line-through' : '')) });
  } else if (todos.length > 0) {
    sections.push({ id: 'tasks', label: 'Tasks', rows: todos.map((todo) => row(todo.content, todo.status, todo.status === 'completed' ? 'line-through' : '')) });
  }
  if (messagePinIDs.size > 0) sections.push({ id: 'pins', label: 'Context pins', rows: [
    row('Saved messages', String(messagePinIDs.size)),
  ] });
  if (knowledge.summary || knowledge.unavailable) {
    const knowledgeRows: (ReactNode | null)[] = [];
    for (const note of knowledge.summary?.notes ?? []) {
      knowledgeRows.push(
        <div key={`note-${note.id}`} className="flex items-start justify-between gap-2 text-[11px]" data-testid={`ws-knowledge-note-${note.id}`}>
          <span className="min-w-0 flex-1 break-words text-neutral-300">{shortKnowledgeText(note.body)}</span>
          <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-sky-400 disabled:opacity-50"
            disabled={knowledgePinAction === `note:${note.id}`}
            onClick={() => void unpinKnowledge('note', note.id)}>Unpin</button>
        </div>,
      );
    }
    for (const plan of knowledge.summary?.plans ?? []) {
      knowledgeRows.push(
        <div key={`plan-${plan.id}`} className="flex items-start justify-between gap-2 text-[11px]" data-testid={`ws-knowledge-plan-${plan.id}`}>
          <span className="min-w-0 flex-1 break-words text-neutral-300">{shortKnowledgeText(plan.title)}</span>
          <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-sky-400 disabled:opacity-50"
            disabled={knowledgePinAction === `plan:${plan.id}`}
            onClick={() => void unpinKnowledge('plan', plan.id)}>Unpin</button>
        </div>,
      );
    }
    if (knowledgeError) knowledgeRows.push(row('Pin error', knowledgeError));
    knowledgeRows.push(row('Memory', knowledge.summary
      ? `${knowledge.summary.memory.global} global · ${knowledge.summary.memory.project} project`
      : null));
    if (!knowledge.summary) knowledgeRows.push(row('Knowledge', 'Unavailable'));
    sections.push({ id: 'knowledge-sources', label: 'Knowledge sources', rows: knowledgeRows });
  }

  const visibleSections = sections.filter((section) => !hidden.includes(section.id));
  // The project branch is useful ambient workspace information, but it is
  // not evidence that the selected session has a context projection.
  const hasSessionDetails = sections.some((section) => section.id !== 'project') || (expanded && ledger.length > 0);

  async function toggleMessagePin(messageID: string, pinned: boolean): Promise<void> {
    if (typeof sessionID !== 'string' || !selectedSession || pinAction !== null) return;
    const message = messages.find((candidate) => candidate.id === messageID);
    if (!message) return;
    const action = { sessionID, messageID, token: ++pinActionTokenRef.current };
    pinActionRef.current = action;
    setPinAction(action);
    setPinError(null);
    try {
      await setSessionMessagePinned({
        sessionID, directory: selectedSession.directory, message, pinned,
        ...(selectedSession.metadata ? { metadata: selectedSession.metadata } : {}),
      });
    } catch {
      if (currentSessionIDRef.current === sessionID) setPinError('Could not update the context pin');
    } finally {
      if (pinActionRef.current === action) {
        pinActionRef.current = null;
        setPinAction(null);
      }
    }
  }

  async function unpinKnowledge(kind: 'note' | 'plan', id: string): Promise<void> {
    if (!selectedSession || knowledgePinAction !== null) return;
    setKnowledgePinAction(`${kind}:${id}`);
    setKnowledgeError(null);
    try {
      await knowledge.unpin({ kind, id });
    } catch {
      if (currentSessionIDRef.current === selectedSession.id) setKnowledgeError('Could not update the knowledge pin');
    } finally {
      setKnowledgePinAction(null);
    }
  }

  return (
    <aside className={`${embedded ? 'flex w-full' : 'hidden w-[300px] xl:flex'} shrink-0 flex-col overflow-y-auto p-3`} style={{ maxWidth: embedded ? undefined : PANEL_WIDTH }} data-testid="work-status-panel">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-3" data-testid="context-reading-column">
      {selectedSession ? <header className={expanded ? 'px-1 py-3' : 'px-1 py-1'} data-testid="context-session-header">
        <h2 className={`truncate font-medium text-neutral-200 ${expanded ? 'text-base' : 'text-sm'}`}>{selectedSession.title}</h2>
        {routeLabel ? <p className="mt-1 truncate text-xs text-neutral-500">{routeLabel}</p> : null}
      </header> : null}
      {configuredModel.nnaConfigured && selectedSession && !selectedSession.parentID ? <ReviewModeControl sessionID={sessionID}
        busy={statusById[sessionID]?.type !== undefined && statusById[sessionID]?.type !== 'idle'} /> : null}
      {(nnaContext || context.tokens || expanded && messages.length > 0) ? <section className={`rounded-lg border border-white/10 bg-neutral-900/40 ${expanded ? 'p-4' : 'p-3'}`} aria-label="Session usage" data-testid="context-usage-summary">
        <h3 className="text-xs font-medium text-neutral-300">Session usage</h3>
        {nnaContext || context.tokens ? <div className="mt-3">
          <div className="flex justify-between gap-3 text-[11px] text-neutral-500"><span>Context</span><span>{nnaContext
            ? `${nnaContext.estimatedTokens.toLocaleString(intlLocale)} estimated tokens${nnaContext.limitTokens ? ` / ${nnaContext.limitTokens.toLocaleString(intlLocale)} limit` : ' · limit unknown'}`
            : `${context.tokens?.total?.toLocaleString(intlLocale) ?? 'Usage reported'} reported tokens${context.percent === null ? ' · limit unknown' : ` · ${context.percent.toFixed(1)}% of model limit`}`}</span></div>
          {contextPercent !== null ? <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, contextPercent))}>
            <div className="h-full bg-amber-500" style={{ width: `${Math.min(100, Math.max(0, contextPercent))}%` }} />
          </div> : null}
        </div> : null}
        {expanded ? <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {messages.length > 0 ? <UsageFact label="Loaded messages" value={messages.length.toLocaleString(intlLocale)} /> : null}
          {messages.length > 0 ? <UsageFact label="Loaded user" value={messages.filter((message) => message.role === 'user').length.toLocaleString(intlLocale)} /> : null}
          {messages.length > 0 ? <UsageFact label="Loaded assistant" value={messages.filter((message) => message.role === 'assistant').length.toLocaleString(intlLocale)} /> : null}
          {cost > 0 ? <UsageFact label="Recorded cost" value={formatMoney(cost)} /> : null}
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
        {messagePinIDs.size > 0 ? <div className="mb-2 text-[11px] text-neutral-400" data-testid="context-pin-count">{messagePinIDs.size} saved context {messagePinIDs.size === 1 ? 'pin' : 'pins'}</div> : null}
        {pinError ? <p className="mb-2 text-[10px] text-amber-400" data-testid="context-pin-error">{pinError}</p> : null}
        <p className="mb-2 text-[10px] text-neutral-600">Part kinds and reported tokens only; message content is not shown here.</p>
        <ol className="space-y-1" aria-label="Loaded messages, newest first">{ledger.map((item) => <li key={item.id} className="flex items-center gap-2 rounded bg-white/[0.03] px-2 py-1.5 text-[10px] text-neutral-400">
          <span className="min-w-0 flex-1 truncate" title={`${item.role} · ${item.kinds}`}>{item.role} · {item.kinds}</span>
          {item.input !== null || item.output !== null ? <span className="shrink-0 tabular-nums text-neutral-500" aria-label="Reported input and output tokens">{item.input === null ? '—' : item.input.toLocaleString(intlLocale)} / {item.output === null ? '—' : item.output.toLocaleString(intlLocale)}</span> : null}
          {item.created !== null ? <time className="shrink-0 text-neutral-600" dateTime={new Date(item.created).toISOString()}>{new Date(item.created).toLocaleTimeString(intlLocale, { hour: 'numeric', minute: '2-digit' })}</time> : null}
          <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-white/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-sky-400 disabled:opacity-50"
            aria-pressed={messagePinIDs.has(item.id)}
            disabled={pinAction?.sessionID === sessionID && pinAction.messageID === item.id}
            onClick={() => void toggleMessagePin(item.id, !messagePinIDs.has(item.id))}>
            {messagePinIDs.has(item.id) ? 'Unpin' : 'Pin'}
          </button>
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

function reportedToken(label: string, count: unknown, locale: string): { label: string; value: string } | null {
  return Number.isSafeInteger(count) && (count as number) >= 0 ? { label, value: (count as number).toLocaleString(locale) } : null;
}

function shortKnowledgeText(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 120)}…`;
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
