// SPDX-License-Identifier: Apache-2.0
/**
 * Durable creation-operation receipts (F9 multi-run / session creation):
 * `<data-dir>/session-operations.json` maps an operation id to the request
 * fingerprint and outcome so a retry after a lost acknowledgement replays the
 * ORIGINAL result instead of creating a second native session. The three
 * answers a retry can get are machine state, not prose: `settled` replays the
 * stored outcome, `conflict` rejects a changed payload under the same id, and
 * `pending` (reservation without a settled outcome) reports an unknown outcome
 * that must never be blindly resubmitted — the pid check distinguishes an
 * in-flight peer from a crash, and only the crash case is stale enough for the
 * caller to re-drive after inspecting native state.
 * Bounded: at most `OPERATION_CAP` receipts survive, oldest settled receipts
 * evicted first so an unsettled reservation cannot be silently dropped.
 * Security: receipts hold NND-created session ids for the local operator;
 * they grant no authority of their own.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { ENV } from '../env.ts';

export const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const OPERATION_CAP = 200;

export type OperationState = 'pending' | 'settled';

export interface OperationReceipt {
  fingerprint: string;
  state: OperationState;
  /** The original outcome envelope; present only when settled. */
  response?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  pid: number;
}

export type ReserveOutcome =
  | { kind: 'fresh' }
  | { kind: 'settled'; receipt: OperationReceipt }
  | { kind: 'conflict' }
  /** `live` is true only when ANOTHER live process holds the reservation
   *  (an attempt in flight there); a pending reservation this process made
   *  itself means an attempt whose outcome was lost — always unknown. */
  | { kind: 'pending'; live: boolean };

interface OperationFile {
  version: 1;
  operations: Record<string, OperationReceipt>;
}

/** Request identity: the operation id must map to EXACTLY this payload or a
 *  retry with the same id is a conflict. Keys are canonicalized recursively
 *  so key insertion order from different client builds cannot flip the answer. */
export function fingerprintOf(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload ?? null))).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function operationsFile(): string {
  return joinPath(ENV.dataDir, 'session-operations.json');
}

function readOperations(path: string): OperationFile | null {
  if (!existsSync(path)) return { version: 1, operations: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // the caller reports the conflict path as 'unknown file'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const doc = parsed as Partial<OperationFile>;
  if (doc.version !== 1 || doc.operations === null || typeof doc.operations !== 'object'
    || Array.isArray(doc.operations)) return null;
  return { version: 1, operations: doc.operations as Record<string, OperationReceipt> };
}

function writeOperations(path: string, doc: OperationFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(doc)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** Bounded eviction: oldest SETTLED receipts go first; a full ring of
 *  unsettled receipts still evicts its oldest entry (the bound must hold),
 *  which only happens under sustained unknown outcomes the operator must clear. */
function evict(doc: OperationFile): void {
  const entries = Object.entries(doc.operations);
  if (entries.length <= OPERATION_CAP) return;
  const sorted = entries.sort((left, right) => {
    const leftSettled = left[1].state === 'settled' ? 0 : 1;
    const rightSettled = right[1].state === 'settled' ? 0 : 1;
    return leftSettled - rightSettled || left[1].updatedAt - right[1].updatedAt;
  });
  const excess = entries.length - OPERATION_CAP;
  for (let index = 0; index < excess; index += 1) {
    delete doc.operations[sorted[index]![0]];
  }
}

/** Reserves (or reconciles) an operation id under the config lock. The
 *  reservation and its fingerprint land atomically with the outcome decision,
 *  so two racing retries of the same id see exactly one `fresh`. */
export async function reserveOperation(
  operationId: string, fingerprint: string,
): Promise<ReserveOutcome> {
  const path = operationsFile();
  return withConfigLock(path, async (): Promise<ReserveOutcome> => {
    const doc = readOperations(path);
    if (doc === null) {
      // A damaged receipt file must not block creation: quarantine-by-rename
      // semantics as the queue store's malformed boot, but creation continues
      // with an empty ledger (reservations start from scratch).
      try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* gone between read and rename */ }
      const fresh: OperationFile = { version: 1, operations: {} };
      fresh.operations[operationId] = {
        fingerprint, state: 'pending', createdAt: Date.now(), updatedAt: Date.now(), pid: process.pid,
      };
      writeOperations(path, fresh);
      return { kind: 'fresh' };
    }
    const existing = doc.operations[operationId];
    if (existing === undefined) {
      doc.operations[operationId] = {
        fingerprint, state: 'pending', createdAt: Date.now(), updatedAt: Date.now(), pid: process.pid,
      };
      evict(doc);
      writeOperations(path, doc);
      return { kind: 'fresh' };
    }
    if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
    if (existing.state === 'settled') return { kind: 'settled', receipt: existing };
    return { kind: 'pending', live: existing.pid !== process.pid && processAlive(existing.pid) };
  });
}

/** Settles a reserved operation with its original outcome envelope. A pending
 *  reservation whose attempt failed BEFORE any native acceptance is released
 *  (the caller passes `release`), so the id may legitimately re-attempt. */
export async function settleOperation(
  operationId: string, response: Record<string, unknown> | null,
): Promise<void> {
  await withConfigLock(operationsFile(), async () => {
    const path = operationsFile();
    const doc = readOperations(path);
    if (doc === null) return;
    const existing = doc.operations[operationId];
    if (existing === undefined || existing.state === 'settled') return;
    if (response === null) {
      delete doc.operations[operationId];
    } else {
      doc.operations[operationId] = {
        ...existing, state: 'settled', response, updatedAt: Date.now(), pid: process.pid,
      };
    }
    evict(doc);
    writeOperations(path, doc);
  });
}

/** Read-side lookup for the receipt route (no lock: a torn read is possible
 *  only mid-rename, which the atomic rename makes impossible). */
export function readOperation(operationId: string): OperationReceipt | null {
  const doc = readOperations(operationsFile());
  return doc?.operations[operationId] ?? null;
}
