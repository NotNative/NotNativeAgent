// SPDX-License-Identifier: Apache-2.0
/**
 * Work-status selectors (doc 05 §E.9/§G/§C.9): pure over a directory store
 * snapshot. Rows are computed ONLY while the panel is expanded, the session
 * is authoritatively idle, and a completed turn exists (identity is
 * runtime+directory+session at the call site).
 */
import type { PresentationMessage } from '../lib/nnd/types.ts';
import { projectTurns } from './turns.ts';
import type { DirectoryStore } from '../sync/types.ts';

/** Context usage: latest REPORTING assistant message (tokens with a
 * numbers `total`) vs the resolved model context limit. Missing values hide
 * the row (never a fabricated 0% — Harness Port 15). */
export function contextUsage(state: DirectoryStore, sessionID: string, contextLimit?: number): { percent: number | null; tokens: { total?: number; input?: number; output?: number } | null; lastMessageID: string | null } {
  const messages = state.message[sessionID] ?? [];
  for (const source of [...messages].reverse()) {
    const message = source as PresentationMessage;
    if (message.role !== 'assistant' || !message.tokens || !message.tokens.total) continue;
    const totalTokens = message.tokens.total;
    return {
      percent: contextLimit && contextLimit > 0 ? (totalTokens / contextLimit) * 100 : null,
      tokens: { total: message.tokens.total, input: message.tokens.input, output: message.tokens.output },
      lastMessageID: message.id,
    };
  }
  return { percent: null, tokens: null, lastMessageID: null };
}

/** NNA's numeric context projection is an estimate, not provider-billed usage. */
export function nnaContextUsage(state: DirectoryStore, sessionID: string): { estimatedTokens: number; limitTokens: number | null; percent: number | null } | null {
  const session = state.session.find((item) => item.id === sessionID);
  const nnd = session?.metadata?.nnd;
  if (!nnd || typeof nnd !== 'object' || Array.isArray(nnd)) return null;
  const context = (nnd as Record<string, unknown>).context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const record = context as Record<string, unknown>;
  const used = record.estimatedTokens;
  if (!Number.isSafeInteger(used) || (used as number) < 0 || record.measurement !== 'estimated') return null;
  const limit = record.limitTokens;
  const limitTokens = Number.isSafeInteger(limit) && (limit as number) > 0 ? limit as number : null;
  return { estimatedTokens: used as number, limitTokens,
    percent: limitTokens === null ? null : (used as number) / limitTokens * 100 };
}

const NNA_TURN_PHASES = new Set([
  'idle', 'preparing', 'waiting_provider', 'reasoning', 'streaming', 'awaiting_approval',
  'running_tool', 'recovering', 'attention_required', 'cancelling', 'failed', 'needs_input',
]);

/** NNA-authored semantic phase. Client busy/idle is only transport bookkeeping. */
export function nnaTurnPhase(state: DirectoryStore, sessionID: string): string | null {
  const session = state.session.find((item) => item.id === sessionID);
  return nnaTurnPhaseFromMetadata(session?.metadata);
}

export function nnaTurnPhaseFromMetadata(metadata: unknown): string | null {
  const nnd = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).nnd : null;
  if (!nnd || typeof nnd !== 'object' || Array.isArray(nnd)) return null;
  const turnState = (nnd as Record<string, unknown>).turnState;
  if (!turnState || typeof turnState !== 'object' || Array.isArray(turnState)) return null;
  const phase = (turnState as Record<string, unknown>).phase;
  return typeof phase === 'string' && NNA_TURN_PHASES.has(phase) ? phase : null;
}

export interface NnaGovernanceSummary {
  reviewPosture?: 'prompt' | 'auto-review' | 'unattended';
  recordHealth?: 'ready' | 'attention' | 'unavailable';
  durable?: boolean;
  attentionEvidence?: number;
  unsettledDecisions?: number;
  uncertainEffects?: number;
}

/** Configured route identity is authored per NNA session. It is not a claim
 * about a fallback provider or the model that actually answered a turn. */
export function nnaSessionConfiguredModel(state: DirectoryStore, sessionID: string): { providerID: string; modelID: string } | null {
  const session = state.session.find((item) => item.id === sessionID);
  return nnaConfiguredModelFromMetadata(session?.metadata);
}

export function nnaConfiguredModelFromMetadata(metadata: unknown): { providerID: string; modelID: string } | null {
  const nnd = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).nnd : null;
  if (!nnd || typeof nnd !== 'object' || Array.isArray(nnd)) return null;
  const model = (nnd as Record<string, unknown>).configuredModel;
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;
  const { providerID, modelID } = model as Record<string, unknown>;
  const validId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
    && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
  return validId(providerID) && validId(modelID) ? { providerID, modelID } : null;
}

/** NNA-authored classifications only; malformed or unknown fields never
 * become an invented governance claim in the Context rail. */
export function nnaGovernanceSummary(state: DirectoryStore, sessionID: string): NnaGovernanceSummary | null {
  const session = state.session.find((item) => item.id === sessionID);
  const nnd = session?.metadata?.nnd;
  if (!nnd || typeof nnd !== 'object' || Array.isArray(nnd)) return null;
  const raw = (nnd as Record<string, unknown>).governance;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const summary: NnaGovernanceSummary = {};
  if (data.reviewPosture === 'prompt' || data.reviewPosture === 'auto-review' || data.reviewPosture === 'unattended') summary.reviewPosture = data.reviewPosture;
  if (data.recordHealth === 'ready' || data.recordHealth === 'attention' || data.recordHealth === 'unavailable') summary.recordHealth = data.recordHealth;
  if (typeof data.durable === 'boolean') summary.durable = data.durable;
  for (const key of ['attentionEvidence', 'unsettledDecisions', 'uncertainEffects'] as const) {
    const value = data[key];
    if (Number.isSafeInteger(value) && (value as number) >= 0) summary[key] = value as number;
  }
  return Object.keys(summary).length ? summary : null;
}

export interface NnaWorkSummary {
  revision: number;
  goal: { id: string; objective: string; status: 'active' | 'completed' | 'blocked' } | null;
  tasks: { id: string; title: string; status: 'pending' | 'in_progress' | 'completed' | 'blocked' }[];
}

/** Canonical NNA conversation work, not the compatibility todo cache. Ignore
 * evidence and any extra engine fields even when they arrive on the wire. */
export function nnaWorkSummary(state: DirectoryStore, sessionID: string): NnaWorkSummary | null {
  const session = state.session.find((item) => item.id === sessionID);
  const nnd = session?.metadata?.nnd;
  if (!nnd || typeof nnd !== 'object' || Array.isArray(nnd)) return null;
  const raw = (nnd as Record<string, unknown>).work;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const work = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(work.revision) || (work.revision as number) < 0
    || !Array.isArray(work.tasks) || work.tasks.length > 64) return null;
  const goal = work.goal === null ? null : workGoal(work.goal);
  if (work.goal !== null && !goal) return null;
  const tasks = work.tasks.map(workTask);
  if (tasks.some((task) => task === null)) return null;
  return { revision: work.revision as number, goal, tasks: tasks as NnaWorkSummary['tasks'] };
}

function workGoal(raw: unknown): NnaWorkSummary['goal'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!workText(value.id, 128) || !workText(value.objective, 2048)
    || (value.status !== 'active' && value.status !== 'completed' && value.status !== 'blocked')) return null;
  return { id: value.id, objective: value.objective, status: value.status };
}

function workTask(raw: unknown): NnaWorkSummary['tasks'][number] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !/^T[1-9][0-9]{0,5}$/u.test(value.id)
    || !workText(value.title, 512)
    || (value.status !== 'pending' && value.status !== 'in_progress'
      && value.status !== 'completed' && value.status !== 'blocked')) return null;
  return { id: value.id, title: value.title, status: value.status };
}

function workText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** Model context limit from the provider catalog (limit.context); unknown
 * model ⇒ undefined (row suppressed rather than guessed). */
export function resolveContextLimit(providers: { id: string; models: Record<string, { limit?: { context?: number } }> }[] | undefined | null, modelID: string | undefined): number | undefined {
  if (!providers || !modelID) return undefined;
  for (const provider of providers) {
    const model = provider.models?.[modelID];
    if (model?.limit?.context) return model.limit.context;
  }
  return undefined;
}

/** Session cost: whole-subtree rollup (parent + descendant messages). */
export function sessionCostRollup(state: DirectoryStore, rootSessionID: string): number {
  const subtotal = costsOf(state, rootSessionID);
  return totalsRound(sum(subtotal, ...descendants(state, rootSessionID).map((id) => costsOf(state, id))));
}

function descendants(state: DirectoryStore, parentID: string): string[] {
  const out: string[] = [];
  for (const session of state.session) {
    if (session.parentID === parentID) out.push(session.id, ...descendants(state, session.id));
  }
  return out;
}

function costsOf(state: DirectoryStore, sessionID: string): number[] {
  return (state.message[sessionID] ?? [])
    .map((source) => (source as PresentationMessage).cost)
    .filter((cost): cost is number => typeof cost === 'number');
}

type SumLeaf = number | number[];
function sum(...groups: SumLeaf[]): number {
  let total = 0;
  for (const group of groups) {
    for (const value of Array.isArray(group) ? group : [group]) total += value;
  }
  return total;
}
function totalsRound(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Turn stats (§E.9 telemetry): computed once per completed final answer;
 * output tokens include reasoning across steps; whole-turn window bounds
 * response speed (text-interval unions refine this in the virtualizer slice). */
export function turnStats(state: DirectoryStore, sessionID: string): { responseSpeedTokensPerSec: number | null; wholeTurnMS: number | null; steps: number; outputTokens: number | null; inputTokens: number | null } {
  const messages = state.message[sessionID] ?? [];
  const turns = projectTurns(messages);
  const last = turns.at(-1);
  if (!last) return { responseSpeedTokensPerSec: null, wholeTurnMS: null, steps: 0, outputTokens: null, inputTokens: null };
  const final = last.assistant.at(-1);
  const outputTokens = final?.tokens?.output ?? null;
  const inputTokens = final?.tokens?.input ?? null;
  const steps = last.assistant.length;
  const start = Math.min(...last.assistant.map((message) => message.time.created), last.userMessage.time.created);
  const end = final?.time.completed ?? undefined;
  const wholeTurnMS = end !== undefined ? Math.max(0, end - start) : null;
  const responseSpeedTokensPerSec = outputTokens !== null && wholeTurnMS !== null && wholeTurnMS > 0 ? outputTokens / (wholeTurnMS / 1000) : null;
  return { responseSpeedTokensPerSec: busyRound(responseSpeedTokensPerSec), wholeTurnMS, steps, outputTokens, inputTokens };
}

function busyRound(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

/** Subagent rows (§E.9 section 5): per-child status phrase + subtree cost. */
export type SubagentRow = { sessionID: string; title: string; statusPhrase: string; cost: number | null };

export function subagentRows(state: DirectoryStore, parentID: string, statusOf: (sessionID: string) => string): SubagentRow[] {
  return state.session
    .filter((session) => session.parentID === parentID)
    .map((session) => {
      const childrenCost = descendants(state, session.id).map((id) => costsOf(state, id));
      const rollup = totalsRound(sum(costsOf(state, session.id), ...childrenCost.map((group) => group)));
      return { sessionID: session.id, title: session.title || 'Subagent', statusPhrase: statusOf(session.id), cost: rollup > 0 ? rollup : null };
    });
}

/** Tasks section: completed items STAY (a record, not a queue), ordered
 * in-progress → pending → completed and stable within a rank. */
export interface TodoRowView { content: string; status: string; priority: string }

export function todoRows(state: DirectoryStore, sessionID: string): TodoRowView[] {
  const rank: Record<string, number> = { 'in-progress': 0, pending: 1, completed: 2, cancelled: 3 };
  return [...(state.todo[sessionID] ?? [])]
    .sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.content.localeCompare(b.content))
    .map((todo) => ({ content: todo.content, status: todo.status, priority: todo.priority }));
}

/** §E.3 recap validity: `metadata.<namespace>.assist` where the namespace is
 * the product brand (nnd); only while its forMessageID is STILL the last
 * assistant message AND a 1-minute quiet window has passed SINCE GENERATION
 * (generatedAt) — the recap must never crowd a fresh turn. */
export function recapFor(state: DirectoryStore, sessionID: string, now = Date.now()): { recap: string; suggestion: string } | null {
  const bag = findSession(state, sessionID)?.metadata as Record<string, unknown> | undefined;
  const assist = (bag?.nnd as Record<string, unknown> | undefined)?.assist as { recap?: string; suggestion?: string; forMessageID?: string; generatedAt?: number } | undefined;
  if (!assist?.recap || !assist.forMessageID) return null;
  const messages = state.message[sessionID] ?? [];
  const last = messages.at(-1);
  if (!last || last.id !== assist.forMessageID) return null; // stale anchor
  const generatedAt = assist.generatedAt ?? 0;
  if (!Number.isFinite(generatedAt) || now - generatedAt < 60_000) return null; // 1-minute quiet window (§E.3)
  return { recap: assist.recap, suggestion: assist.suggestion ?? '' };
}

function findSession(state: DirectoryStore, sessionID: string): { metadata?: unknown } | undefined {
  return state.session.find((session) => session.id === sessionID);
}

/** §G data rule (v1): the engine exposes no quota provider registry yet —
 * the section renders presence-collapsed and the row never borrows another
 * provider's number. */
export function usageRows(): { label: string; value: string }[] {
  return [{ label: 'No rate limits reported', value: '—' }];
}
