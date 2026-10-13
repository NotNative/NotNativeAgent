// SPDX-License-Identifier: Apache-2.0
import { PushVisibility } from '../push/visibility.ts';

interface Receipt { seenAt: number; seenRevision: number; lastUserMessageAt: number; visibility: PushVisibility }
export class SessionReceipts {
  private readonly owners = new Map<string, Map<string, Receipt>>();
  constructor(private readonly now: () => number = Date.now) {}
  get(owner: string, session: string): Receipt | undefined { return this.owners.get(owner)?.get(session); }
  viewed(owner: string, session: string): boolean { return this.get(owner, session)?.visibility.visible(owner) ?? false; }
  view(owner: string, session: string, visible: boolean, body: Record<string, unknown>, revision = 0): void {
    const receipt = this.ensure(owner, session);
    receipt.visibility.update(owner, { visible, clientId: body.clientId, sequence: body.sequence });
    if (visible && receipt.visibility.visible(owner)) { receipt.seenAt = this.now(); receipt.seenRevision = revision; }
  }
  sent(owner: string, session: string, revision = 0): void {
    const receipt = this.ensure(owner, session); receipt.lastUserMessageAt = this.now(); receipt.seenAt = this.now(); receipt.seenRevision = revision;
  }
  observeCompletion(session: string, revision: number): void {
    for (const [owner, sessions] of this.owners) {
      const receipt = sessions.get(session);
      if (receipt?.visibility.visible(owner)) { receipt.seenRevision = revision; receipt.seenAt = this.now(); }
    }
  }
  remove(session: string): void { for (const sessions of this.owners.values()) sessions.delete(session); }
  private ensure(owner: string, session: string): Receipt {
    let sessions = this.owners.get(owner);
    if (!sessions) {
      if (this.owners.size >= 1000) this.owners.delete(this.owners.keys().next().value!);
      sessions = new Map(); this.owners.set(owner, sessions);
    }
    let receipt = sessions.get(session);
    if (!receipt) {
      if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!);
      receipt = { seenAt: 0, seenRevision: 0, lastUserMessageAt: 0, visibility: new PushVisibility(this.now) }; sessions.set(session, receipt);
    }
    return receipt;
  }
}
