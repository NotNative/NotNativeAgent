// SPDX-License-Identifier: Apache-2.0
/** Focused coverage for the immutable event-delivery receipt (W-29). */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DeliveryReceiptLedger, GENESIS_HASH } from '../notifications/delivery-receipt.ts';

const expectHash = (seq: number, id: string, at: number, prev: string): string =>
  createHash('sha256').update(`${seq}\n${id}\n${at}\n${prev}`).digest('hex');

describe('DeliveryReceiptLedger (W-29.immutable-receipt)', () => {
  it('records form an unbroken sha256 hash chain from genesis', () => {
    let clock = 1_000;
    const ledger = new DeliveryReceiptLedger(() => clock, 16);
    const first = ledger.record('evt-a');
    clock = 2_000;
    const second = ledger.record('evt-b');
    expect(first.seq).toBe(1);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(first.hash).toBe(expectHash(1, 'evt-a', 1_000, GENESIS_HASH));
    expect(second.hash).toBe(expectHash(2, 'evt-b', 2_000, first.hash));
    expect(ledger.chainHead).toBe(second.hash);
    expect(ledger.verify()).toBe(true);
    expect(ledger.delivered).toBe(2);
    expect(ledger.has('evt-a') && ledger.has('evt-b') && !ledger.has('evt-c')).toBe(true);
  });

  it('evicted records fold into the prefix digest and the window stays verifiable', () => {
    let clock = 0;
    const ledger = new DeliveryReceiptLedger(() => ++clock, 4);
    const all = Array.from({ length: 10 }, (_, at) => ledger.record(`evt-${at}`));
    expect(ledger.anchored).toBe(6);
    expect(ledger.verify()).toBe(true);
    const inside = ledger.since(all[5]!.seq);
    expect(inside.anchored).toBe(0);
    const beyond = ledger.since(2);
    expect(beyond.anchored).toBe(4);
    expect(beyond.records.every((record) => record.seq > 2)).toBe(true);
    let digest = createHash('sha256').update('').digest('hex');
    for (const record of all.slice(0, 6)) digest = createHash('sha256').update(digest + record.hash).digest('hex');
    expect(beyond.prefixDigest).toBe(digest);
  });

  it('records are frozen: mutation attempts do not alter the chain', () => {
    const ledger = new DeliveryReceiptLedger(() => 1, 16);
    const record = ledger.record('evt-x');
    expect(() => { (record as { hash: string }).hash = 'tampered'; }).toThrow(TypeError);
    expect(ledger.verify()).toBe(true);
  });

  it('tampering with the ledger breaks verify', () => {
    const ledger = new DeliveryReceiptLedger(() => 1, 16);
    ledger.record('evt-1');
    ledger.record('evt-2');
    const forged = (ledger as unknown as { window: { hash: string }[] }).window;
    forged[0] = { ...forged[0]!, hash: '0'.repeat(64) };
    expect(ledger.verify()).toBe(false);
  });
});
