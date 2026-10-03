// SPDX-License-Identifier: Apache-2.0
/** Owner-scoped deletion receipts. This journal never certifies complete history. */
import { harnessClient } from '../lib/nnd/client.ts';

export type DeletionReceipt = { sequence: number; sessionID: string; createdAt: number; deletedAt: number; kind: 'deleted' };
export type DeletionPage = { status: 'page' | 'gap'; floor: number; nextCursor: number | null;
  records: DeletionReceipt[]; historyComplete: false };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function parseDeletionPage(value: unknown, after: number): DeletionPage | null {
  if (!object(value) || !sequence(after) || !sequence(value.floor) || value.historyComplete !== false
    || !Array.isArray(value.records) || value.records.length > 50) return null;
  if (value.status === 'gap') {
    return after < value.floor && value.nextCursor === null && value.records.length === 0
      ? { status: 'gap', floor: value.floor, nextCursor: null, records: [], historyComplete: false } : null;
  }
  if (value.status !== 'page' || after < value.floor || !sequence(value.nextCursor)
    || Number(value.nextCursor) < after) return null;
  const records: DeletionReceipt[] = [];
  let last = after;
  for (const row of value.records) {
    if (!object(row) || row.kind !== 'deleted' || !sequence(row.sequence) || Number(row.sequence) <= last
      || typeof row.sessionID !== 'string' || row.sessionID.length < 1 || row.sessionID.length > 264
      || /[\u0000-\u001f\u007f]/u.test(row.sessionID)
      || !sequence(row.createdAt) || !sequence(row.deletedAt)) return null;
    last = Number(row.sequence);
    records.push({ sequence: last, sessionID: row.sessionID, createdAt: Number(row.createdAt),
      deletedAt: Number(row.deletedAt), kind: 'deleted' });
  }
  if (Number(value.nextCursor) !== last) return null;
  return { status: 'page', floor: value.floor, nextCursor: last, records, historyComplete: false };
}

export async function readDeletionPage(after = 0): Promise<DeletionPage> {
  const result = await harnessClient.readActivityTombstones(after);
  if (result.error) throw new Error(result.error);
  const page = parseDeletionPage(result.data, after);
  if (!page) throw new Error('Native deletion receipts are invalid');
  return page;
}
