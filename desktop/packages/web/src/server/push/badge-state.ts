// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';

export interface BadgeSnapshot { count: number; epoch: string; revision: number }
interface OwnerBadges { resetAll: number; resets: Map<string, number>; sessions: Map<string, number> }
export interface BadgeTicket { owner: string; state: OwnerBadges; session: string; snapshot: BadgeSnapshot }

/** Unread notification counts are process-local, bounded, and credential-owned. */
export class PushBadges {
  private readonly owners = new Map<string, OwnerBadges>();
  private readonly epoch = randomUUID();
  private revision = 0;
  checkpoint(): number { return this.revision; }
  snapshot(owner: string): BadgeSnapshot {
    const counts = this.owners.get(owner)?.sessions.values() ?? [];
    return { count: Math.min(9999, Array.from(counts).reduce((sum, count) => sum + count, 0)), epoch: this.epoch, revision: this.revision };
  }
  mark(owner: string, session: string): BadgeTicket {
    return this.markQueued(owner, session, this.revision)!;
  }
  markQueued(owner: string, session: string, queuedRevision: number): BadgeTicket | null {
    const state = this.owner(owner);
    if (state.resetAll > queuedRevision || (state.resets.get(session) ?? 0) > queuedRevision) return null;
    if (!state.sessions.has(session) && state.sessions.size >= 256) state.sessions.delete(state.sessions.keys().next().value!);
    state.sessions.set(session, Math.min(9999, (state.sessions.get(session) ?? 0) + 1));
    this.revision += 1;
    return { owner, state, session, snapshot: this.snapshot(owner) };
  }
  clear(owner: string, session?: string): BadgeSnapshot {
    const state = this.owner(owner);
    this.revision += 1;
    if (session === undefined) { state.sessions.clear(); state.resets.clear(); state.resetAll = this.revision; }
    else {
      state.sessions.delete(session);
      state.resets.delete(session); state.resets.set(session, this.revision);
      if (state.resets.size > 256) {
        const oldest = state.resets.keys().next().value!;
        // Bound reset tombstones without allowing older queued work to resurrect read activity.
        state.resetAll = Math.max(state.resetAll, state.resets.get(oldest)!); state.resets.delete(oldest);
      }
    }
    return this.snapshot(owner);
  }
  current(ticket: BadgeTicket): boolean {
    return this.owners.get(ticket.owner) === ticket.state && ticket.state.resetAll <= ticket.snapshot.revision
      && (ticket.state.resets.get(ticket.session) ?? 0) <= ticket.snapshot.revision;
  }
  private owner(owner: string): OwnerBadges {
    let state = this.owners.get(owner);
    if (!state) {
      if (this.owners.size >= 1000) this.owners.delete(this.owners.keys().next().value!);
      state = { resetAll: 0, resets: new Map(), sessions: new Map() }; this.owners.set(owner, state);
    }
    return state;
  }
}
