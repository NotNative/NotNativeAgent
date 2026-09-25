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

export function subagentRows(state: DirectoryStore, parentID: string, statusOf: (sessionID: string) => 'working' | 'needs permission' | 'asked a question' | 'Done'): SubagentRow[] {
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
