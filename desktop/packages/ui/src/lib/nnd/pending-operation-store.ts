// SPDX-License-Identifier: Apache-2.0
/** Tab-scoped recovery handles for native settings operations. NNA's operation
 *  ledger remains authoritative; this store only tells this tab what it asked
 *  for, so a reload can reconcile a pending receipt. */
import { getRuntimeKey, isTransientRuntimeKey } from '../runtime-switch.ts';

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION = /^[A-Za-z0-9_-]{1,64}$/u;
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 65536;

export interface PendingOperationRecord {
  runtime_key: string;
  installation_id: string;
  data_id: string;
  operation_id: string;
  expected_revision: string;
}

export interface PendingOperationStoreOptions {
  operationPattern?: RegExp;
  revisionPattern?: RegExp;
  maxEntries?: number;
  maxBytes?: number;
}

export interface PendingOperationStore {
  pending(identity: { installation_id: string; data_id: string }): PendingOperationRecord | null;
  reserve(identity: { installation_id: string; data_id: string },
    operationId: string, expectedRevision: string): PendingOperationRecord | null;
  clear(entry: PendingOperationRecord): void;
}

export function createPendingOperationStore(storageKey: string,
  options: PendingOperationStoreOptions = {}): PendingOperationStore {
  const operationPattern = options.operationPattern ?? OPERATION;
  const revisionPattern = options.revisionPattern ?? REVISION;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  function valid(value: unknown): value is PendingOperationRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.runtime_key === 'string' && entry.runtime_key.length <= 512
      && !isTransientRuntimeKey(entry.runtime_key)
      && typeof entry.installation_id === 'string' && ID.test(entry.installation_id)
      && typeof entry.data_id === 'string' && ID.test(entry.data_id)
      && typeof entry.operation_id === 'string' && operationPattern.test(entry.operation_id)
      && typeof entry.expected_revision === 'string' && revisionPattern.test(entry.expected_revision);
  }

  function read(): PendingOperationRecord[] | null {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw === null) return [];
      if (raw.length > maxBytes) return null;
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length <= maxEntries && parsed.every(valid) ? parsed : null;
    } catch { return null; }
  }

  function write(entries: PendingOperationRecord[]): boolean {
    try {
      const encoded = JSON.stringify(entries);
      if (encoded.length > maxBytes) return false;
      sessionStorage.setItem(storageKey, encoded);
      return true;
    } catch { return false; }
  }

  function pending(identity: { installation_id: string; data_id: string }): PendingOperationRecord | null {
    const runtimeKey = getRuntimeKey();
    if (isTransientRuntimeKey(runtimeKey)) return null;
    return read()?.find((entry) => entry.runtime_key === runtimeKey
      && entry.installation_id === identity.installation_id
      && entry.data_id === identity.data_id) ?? null;
  }

  function reserve(identity: { installation_id: string; data_id: string },
    operationId: string, expectedRevision: string): PendingOperationRecord | null {
    const entry = { runtime_key: getRuntimeKey(), installation_id: identity.installation_id,
      data_id: identity.data_id, operation_id: operationId, expected_revision: expectedRevision };
    if (!valid(entry)) return null;
    const entries = read();
    if (!entries || entries.length >= maxEntries || entries.some((item) =>
      item.runtime_key === entry.runtime_key && item.installation_id === entry.installation_id
      && item.data_id === entry.data_id)) return null;
    return write([...entries, entry]) ? entry : null;
  }

  function clear(entry: PendingOperationRecord): void {
    const entries = read();
    if (!entries) return;
    write(entries.filter((item) => item.runtime_key !== entry.runtime_key
      || item.installation_id !== entry.installation_id || item.data_id !== entry.data_id
      || item.operation_id !== entry.operation_id));
  }

  return Object.freeze({ pending, reserve, clear });
}
