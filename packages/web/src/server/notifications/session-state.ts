// SPDX-License-Identifier: Apache-2.0
import { callHarness, harnessRequest } from '../queue/queue-adapter-calls.ts';
import type { QueueEnvelope } from '../queue/queue-feed.ts';
import { SessionReceipts } from './session-receipts.ts';
import { emptyNotificationSession, notificationSessionId, projectNotificationEvent, projectNotificationStatus, projectSessionInfo, type NotificationSession } from './session-projection.ts';

export type NotificationEvent = { type: string; properties: Record<string, unknown> };
export class NotificationSessions {
  private readonly sessions = new Map<string, NotificationSession>();
  private readonly listeners = new Set<(event: NotificationEvent) => void>();
  private pendingRefresh: Promise<void> | null = null;
  private refreshedAt = -Infinity;
  private revision = 0;
  readonly receipts: SessionReceipts;
  constructor(private readonly now: () => number = Date.now, private readonly fetch: (path: string) => Promise<Response> =
    (path) => callHarness(harnessRequest(path, null, { signal: AbortSignal.timeout(5000) }))) { this.receipts = new SessionReceipts(now); }
  get(session: string): NotificationSession | undefined { return this.sessions.get(session); }
  subscribe(listener: (event: NotificationEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  publish(event: NotificationEvent): void { for (const listener of this.listeners) { try { listener(event); } catch { /* isolate a closing stream */ } } }
  publishStatus(id: string): void {
    const state = this.sessions.get(id); if (!state) return;
    this.publish({ type: 'notnative:session-status', properties: { sessionID: id, status: state.status, timestamp: state.lastUpdateAt,
      metadata: state.metadata, needsAttention: state.needsInput || !!state.permissions.size || !!state.forms.size } });
  }
  observe(envelope: QueueEnvelope): void {
    const { type, properties } = envelope.payload;
    const id = notificationSessionId(properties.sessionID ?? (properties.info as { id?: unknown } | undefined)?.id);
    if (!id || !/^(session\.|permission\.|question\.)/u.test(type)) return;
    this.revision += 1;
    if (type === 'session.deleted') { this.sessions.delete(id); this.receipts.remove(id); return; }
    const state = this.ensure(id); const completed = state.completedRevision;
    projectNotificationEvent(state, envelope, this.now());
    if (completed !== state.completedRevision) this.receipts.observeCompletion(id, state.completedRevision);
    this.publishStatus(id);
    this.publish({ type: 'notnative:session-activity', properties: { sessionId: id, phase: state.status === 'idle' ? 'idle' : 'busy' } });
  }
  refresh(force = false): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh;
    if (!force && this.now() - this.refreshedAt < 1000) return Promise.resolve();
    const revision = this.revision;
    const pending = this.load(revision).finally(() => { this.pendingRefresh = null; });
    this.pendingRefresh = pending; return pending;
  }
  snapshot(owner: string) {
    const statusSessions: Record<string, unknown> = Object.create(null); const attentionSessions: Record<string, unknown> = Object.create(null);
    const pending: Record<string, unknown> = Object.create(null); const activity: Record<string, unknown> = Object.create(null);
    for (const [id, state] of this.sessions) {
      statusSessions[id] = { status: state.status, lastUpdateAt: state.lastUpdateAt, metadata: state.metadata };
      attentionSessions[id] = this.attention(owner, id);
      if (state.permissions.size || state.forms.size) pending[id] = { permissions: [...state.permissions.values()], forms: [...state.forms.values()] };
      activity[id] = { type: state.status === 'idle' ? 'idle' : 'busy' };
    }
    return { statusSessions, attentionSessions, pending, pendingCoverage: 'live-events-only' as const, activity, serverTime: this.now() };
  }
  attention(owner: string, id: string) {
    const state = this.sessions.get(id); if (!state) return null;
    const receipt = this.receipts.get(owner, id); const viewed = this.receipts.viewed(owner, id);
    return { status: state.status, lastStatusChangeAt: state.lastStatusChangeAt, lastUserMessageAt: receipt?.lastUserMessageAt ?? 0, isViewed: viewed,
      needsAttention: state.needsInput || !!state.permissions.size || !!state.forms.size || !viewed && state.completedRevision > (receipt?.seenRevision ?? 0) };
  }
  private async load(revision: number): Promise<void> {
    const [listReply, statusReply] = await Promise.all([this.fetch('/session'), this.fetch('/session/status')]);
    if (!listReply.ok || !statusReply.ok) throw new Error('NNA session snapshot is unavailable');
    const list: unknown = await listReply.json(); const statuses: unknown = await statusReply.json();
    if (!Array.isArray(list) || !statuses || typeof statuses !== 'object' || Array.isArray(statuses)) throw new Error('NNA session snapshot is invalid');
    if (list.some((info) => !info || typeof info !== 'object' || Array.isArray(info) || !notificationSessionId(info.id))
      || new Set(list.map((info) => info.id)).size !== list.length) throw new Error('NNA session list is invalid');
    if (Object.values(statuses).some((status) => !status || typeof status !== 'object' || !['busy', 'idle', 'retry'].includes((status as { type: string }).type))) throw new Error('NNA status snapshot is invalid');
    if (Object.keys(statuses).some((id) => !notificationSessionId(id))) throw new Error('NNA status identity is invalid');
    if (this.revision !== revision) throw new Error('NNA session snapshot changed during refresh');
    if (list.length > 5000 || listReply.headers.has('link')) throw new Error('NNA session snapshot exceeds the notification coverage limit');
    const listed = new Map<string, Record<string, unknown>>(list.map((info) => [info.id, info]));
    const covered = new Set([...listed.keys(), ...Object.keys(statuses)]);
    if (covered.size > 5000) throw new Error('NNA combined snapshot exceeds the notification coverage limit');
    for (const id of covered) {
      const known = this.sessions.has(id); const state = this.ensure(id); const info = listed.get(id);
      if (info) projectSessionInfo(state, info);
      const status = Object.hasOwn(statuses, id) ? (statuses as Record<string, Record<string, unknown>>)[id]! : { type: 'idle' };
      const completed = state.completedRevision; projectNotificationStatus(state, status, this.now());
      if (completed !== state.completedRevision) this.receipts.observeCompletion(id, state.completedRevision);
      if (!known) state.lastStatusChangeAt = 0;
    }
    for (const id of this.sessions.keys()) if (!covered.has(id)) { this.sessions.delete(id); this.receipts.remove(id); }
    this.refreshedAt = this.now();
  }
  private ensure(id: string): NotificationSession {
    let state = this.sessions.get(id);
    if (!state) { if (this.sessions.size >= 5000) {
      const oldest = this.sessions.keys().next().value!; this.sessions.delete(oldest); this.receipts.remove(oldest);
    }
      state = emptyNotificationSession(this.now()); this.sessions.set(id, state); }
    return state;
  }
}
