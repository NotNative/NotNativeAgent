// SPDX-License-Identifier: Apache-2.0
import { PushStoreError } from './subscription-store.ts';

type Lease = { visible: boolean; updatedAt: number; sequence: number };
export class PushVisibility {
  private readonly owners = new Map<string, Map<string, Lease>>();
  constructor(private readonly now: () => number = Date.now) {}
  update(owner: string, body: unknown): void {
    if (!body || typeof body !== 'object') throw new PushStoreError('Invalid visibility', 400);
    const input = body as Record<string, unknown>;
    if (typeof input.visible !== 'boolean') throw new PushStoreError('visible must be a boolean', 400);
    const client = input.clientId ?? 'legacy';
    const sequence = input.sequence ?? 0;
    if (typeof client !== 'string' || !/^[a-z0-9_-]{1,80}$/iu.test(client)
      || !Number.isSafeInteger(sequence) || (sequence as number) < 0) throw new PushStoreError('Invalid visibility identity', 400);
    this.prune();
    const leases = this.owners.get(owner) ?? new Map<string, Lease>();
    const existing = leases.get(client);
    if (existing && sequence !== 0 && (sequence as number) <= existing.sequence) return;
    if (!existing && leases.size >= 32) throw new PushStoreError('Visibility capacity reached', 409);
    if (!this.owners.has(owner) && this.owners.size >= 1_000) throw new PushStoreError('Visibility capacity reached', 409);
    leases.set(client, { visible: input.visible, updatedAt: this.now(), sequence: sequence as number });
    this.owners.set(owner, leases);
  }
  visible(owner: string): boolean {
    this.prune();
    return [...(this.owners.get(owner)?.values() ?? [])].some((lease) => lease.visible && this.now() - lease.updatedAt < 30_000);
  }
  private prune(): void {
    const cutoff = this.now() - 300_000;
    for (const [owner, leases] of this.owners) {
      for (const [client, lease] of leases) if (lease.updatedAt <= cutoff) leases.delete(client);
      if (!leases.size) this.owners.delete(owner);
    }
  }
}
