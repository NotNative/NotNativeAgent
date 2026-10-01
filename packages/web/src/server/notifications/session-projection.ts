// SPDX-License-Identifier: Apache-2.0
import type { QueueEnvelope } from '../queue/queue-feed.ts';

export interface NotificationSession {
  status: 'busy' | 'idle' | 'retry'; lastUpdateAt: number; lastStatusChangeAt: number; metadata: Record<string, unknown>;
  needsInput: boolean; completedAt: number; completedRevision: number; startedRevision: number;
  permissions: Map<string, Record<string, unknown>>; forms: Map<string, Record<string, unknown>>;
}
export function notificationSessionId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}
export function emptyNotificationSession(now: number): NotificationSession {
  return { status: 'idle', lastUpdateAt: now, lastStatusChangeAt: 0, metadata: {}, needsInput: false, completedAt: 0, completedRevision: 0, startedRevision: 0, permissions: new Map(), forms: new Map() };
}
export function projectNotificationStatus(state: NotificationSession, value: Record<string, unknown>, now: number): void {
  if (value.type !== 'busy' && value.type !== 'retry' && value.type !== 'idle') return;
  if (value.type !== state.status) {
    if (state.status === 'idle' && value.type !== 'idle') state.startedRevision += 1;
    state.lastStatusChangeAt = now;
    if (value.type === 'idle') { state.completedAt = now; state.completedRevision += 1; }
  }
  state.status = value.type; state.lastUpdateAt = now;
  state.metadata = Object.fromEntries(['attempt', 'message', 'next'].filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}
export function projectSessionInfo(state: NotificationSession, info: Record<string, unknown>): void {
  const metadata = info.metadata as { nnd?: { attention?: { kind?: unknown }; turnState?: { phase?: unknown } } } | undefined;
  state.needsInput = metadata?.nnd?.attention?.kind === 'needs_input'
    || ['attention_required', 'needs_input', 'awaiting_approval'].includes(String(metadata?.nnd?.turnState?.phase ?? ''));
}
export function projectNotificationEvent(state: NotificationSession, envelope: QueueEnvelope, now: number): void {
  const { type, properties: props } = envelope.payload;
  if (type === 'session.updated' || type === 'session.created') projectSessionInfo(state, (props.info ?? {}) as Record<string, unknown>);
  const status = type === 'session.idle' ? { type: 'idle' } : type === 'session.status' ? props.status : null;
  if (status && typeof status === 'object') {
    projectNotificationStatus(state, status as Record<string, unknown>, now);
  }
  if (type === 'session.error') {
    const idle = state.status === 'idle'; projectNotificationStatus(state, { type: 'idle' }, now);
    state.completedAt = now; if (idle) state.completedRevision += 1;
  }
  const kind = type.startsWith('permission.') ? state.permissions : type.startsWith('question.') ? state.forms : null;
  if (!kind) return;
  const id = notificationSessionId(props.id ?? props.requestID ?? props.question_token);
  if (type.endsWith('.asked') && id) {
    if (kind.size >= 128 && !kind.has(id)) kind.delete(kind.keys().next().value!);
    kind.set(id, props);
  } else if (type.endsWith('.replied') || type.endsWith('.rejected')) { if (id) kind.delete(id); else kind.clear(); }
}
