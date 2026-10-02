// SPDX-License-Identifier: Apache-2.0
import type { Session } from '../lib/nnd/types.ts';

const PHASES = new Set(['idle', 'preparing', 'waiting_provider', 'reasoning', 'streaming', 'awaiting_approval',
  'running_tool', 'recovering', 'attention_required', 'cancelling', 'failed', 'needs_input']);
const KEYS = ['version', 'sessionID', 'epoch', 'revision', 'updatedAt', 'turnState', 'activeTools', 'context'];
type RecordValue = Record<string, unknown>;
export interface NnaProjection extends RecordValue {
  version: '1.0'; sessionID: string; epoch: string; revision: number; updatedAt: number;
  turnState: { phase: string } | null; activeTools: { count: number; names: string[] } | null;
  context: RecordValue | null;
}
// Epochs supersede wall-clock recency after restart. Keep only the 32 most recent
// retired epochs for the lifetime of the current in-memory frame; transport
// generations separately invalidate old streams, including across page reloads.
const retiredEpochs = new WeakMap<NnaProjection, readonly string[]>();
function record(value: unknown): value is RecordValue { return !!value && typeof value === 'object' && !Array.isArray(value); }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
export function parseNnaProjection(value: unknown): NnaProjection | null {
  if (!record(value) || Object.keys(value).length !== KEYS.length || KEYS.some((key) => !Object.hasOwn(value, key))
    || value.version !== '1.0' || !id(value.sessionID) || !id(value.epoch) || !positive(value.revision) || !positive(value.updatedAt)) return null;
  const phase = value.turnState; const tools = value.activeTools; const context = value.context;
  if (phase !== null && (!record(phase) || Object.keys(phase).length !== 1 || typeof phase.phase !== 'string' || !PHASES.has(phase.phase))) return null;
  if (tools !== null && (!record(tools) || Object.keys(tools).length !== 2 || !Number.isSafeInteger(tools.count)
    || (tools.count as number) < 0 || (tools.count as number) > 64 || !Array.isArray(tools.names) || tools.names.length !== tools.count
    || tools.names.some((name) => typeof name !== 'string' || !name.trim() || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)))) return null;
  if (context !== null && (!record(context) || Object.keys(context).length !== 4 || context.measurement !== 'estimated'
    || !Number.isSafeInteger(context.estimatedTokens) || (context.estimatedTokens as number) < 0
    || (context.limitTokens !== null && !positive(context.limitTokens)) || !positive(context.observedAt))) return null;
  return value as NnaProjection;
}
export function sessionProjection(session: Session | undefined): NnaProjection | null {
  const value = parseNnaProjection((session?.metadata?.nnd as RecordValue | undefined)?.projection);
  return value?.sessionID === session?.id ? value : null;
}
export function staleProjection(current: NnaProjection | null, incoming: NnaProjection, equal = false): boolean {
  return !!current && (current.epoch === incoming.epoch
    ? incoming.revision < current.revision || equal && incoming.revision === current.revision
    : retiredEpochs.get(current)?.includes(incoming.epoch) === true);
}
function rememberEpochs(current: NnaProjection | null, incoming: NnaProjection): void {
  if (!current || current === incoming) return;
  const retired = new Set([...(retiredEpochs.get(incoming) ?? []), ...(retiredEpochs.get(current) ?? [])]);
  if (current.epoch !== incoming.epoch) retired.add(current.epoch);
  retiredEpochs.set(incoming, [...retired].slice(-32));
}
export function adoptSessionProjection(current: Session | undefined, incoming: Session): Session {
  const frame = sessionProjection(incoming);
  if (frame) rememberEpochs(sessionProjection(current), frame);
  return incoming;
}
export function applyNnaProjection(session: Session, frame: NnaProjection): Session {
  const previous = sessionProjection(session);
  rememberEpochs(previous, frame);
  const nnd: RecordValue = { ...session.metadata?.nnd as RecordValue, projection: frame };
  for (const key of ['turnState', 'activeTools', 'context'] as const) {
    if (frame[key] === null) delete nnd[key]; else nnd[key] = frame[key];
  }
  // A restored epoch can predate the last live description. Carry its authored
  // timestamp so an equal-revision refetch can also restore non-frame metadata.
  const updated = previous && previous.epoch !== frame.epoch ? frame.updatedAt : Math.max(session.time.updated, frame.updatedAt);
  return { ...session, metadata: { ...session.metadata, nnd }, time: { ...session.time, updated } };
}
