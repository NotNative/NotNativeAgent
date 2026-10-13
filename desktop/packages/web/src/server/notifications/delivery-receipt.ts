// SPDX-License-Identifier: Apache-2.0
/**
 * Immutable event-delivery receipt (W-29.immutable-receipt, doc F2): every
 * notification-bus publish appends ONE hash-chained record — seq, event id,
 * delivered-at, previous hash, SHA-256 chain hash. There is no mutation or
 * deletion API: the only operations are append, probe, and verify. The chain
 * is windowed for memory: evicted oldest records are folded into a running
 * `prefixDigest` (sha256 over the evicted hashes, in order) and the retained
 * window's chain links stay intact, so verify() attests (a) the retained
 * window is an unbroken hash chain and (b) the exposed head equals the last
 * computed hash. A client that observed record N can prove continuity by
 * recomputing forward from N.
 */
import { createHash } from 'node:crypto';

export interface DeliveryReceiptRecord {
  readonly seq: number;
  readonly eventID: string;
  readonly deliveredAt: number;
  readonly prevHash: string;
  readonly hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);
const EMPTY_PREFIX_DIGEST = createHash('sha256').update('').digest('hex');

function chainHash(seq: number, eventID: string, deliveredAt: number, prevHash: string): string {
  return createHash('sha256').update(`${seq}\n${eventID}\n${deliveredAt}\n${prevHash}`).digest('hex');
}

export class DeliveryReceiptLedger {
  private seq = 0;
  private head = GENESIS_HASH;
  private prefixDigest = EMPTY_PREFIX_DIGEST;
  private anchoredCount = 0;
  private readonly window: DeliveryReceiptRecord[] = [];

  constructor(private readonly now: () => number = Date.now,
    private readonly capacity = 4_096) {}

  /** Append one record; returns the frozen immutable record. */
  record(eventID: string): DeliveryReceiptRecord {
    this.seq += 1;
    const deliveredAt = this.now();
    const record: DeliveryReceiptRecord = Object.freeze({
      seq: this.seq,
      eventID,
      deliveredAt,
      prevHash: this.head,
      hash: chainHash(this.seq, eventID, deliveredAt, this.head),
    });
    this.head = record.hash;
    this.window.push(record);
    while (this.window.length > this.capacity) {
      const evicted = this.window.shift()!;
      this.prefixDigest = createHash('sha256').update(this.prefixDigest + evicted.hash).digest('hex');
      this.anchoredCount += 1;
    }
    return record;
  }

  /** True when this exact event id is still retained as delivered. */
  has(eventID: string): boolean {
    return this.window.some((record) => record.eventID === eventID);
  }

  last(): DeliveryReceiptRecord | null {
    return this.window.at(-1) ?? null;
  }

  /** Retained records strictly newer than seq, plus the anchor state.
   * `anchored` counts evicted (prefix) records with seq > the probe, i.e.
   * delivered events the caller cannot enumerate from the window. */
  since(seq: number): { anchored: number; prefixDigest: string; records: DeliveryReceiptRecord[] } {
    return {
      anchored: Math.max(0, this.anchoredCount - Math.max(0, seq)),
      prefixDigest: this.prefixDigest,
      records: this.window.filter((record) => record.seq > seq),
    };
  }

  /** The retained window is an unbroken chain ending at the exposed head. */
  verify(): boolean {
    let prev: string | null = null;
    for (const record of this.window) {
      if (prev !== null && record.prevHash !== prev) return false;
      if (chainHash(record.seq, record.eventID, record.deliveredAt, record.prevHash) !== record.hash) return false;
      prev = record.hash;
    }
    return prev === this.head;
  }

  get delivered(): number {
    return this.seq;
  }

  get chainHead(): string {
    return this.head;
  }

  get anchored(): number {
    return this.anchoredCount;
  }
}
