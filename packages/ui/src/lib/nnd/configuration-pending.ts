// SPDX-License-Identifier: Apache-2.0
/** Tab-scoped recovery handles. NNA's operation ledger remains authoritative. */
import { getRuntimeKey, isTransientRuntimeKey } from '../runtime-switch.ts';

const STORAGE_KEY = 'nnd.configuration.pending.v1';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REVISION = /^(?:absent|[a-f0-9]{64})$/u;
const MAX_ENTRIES = 128;
const MAX_BYTES = 65536;
export interface PendingNativeConfigurationOperation {
  runtime_key: string;
  installation_id: string;
  data_id: string;
  operation_id: string;
  expected_revision: string;
}

function valid(value: unknown): value is PendingNativeConfigurationOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.runtime_key === 'string' && entry.runtime_key.length <= 512
    && !isTransientRuntimeKey(entry.runtime_key)
    && typeof entry.installation_id === 'string' && ID.test(entry.installation_id)
    && typeof entry.data_id === 'string' && ID.test(entry.data_id)
    && typeof entry.operation_id === 'string' && ID.test(entry.operation_id)
    && typeof entry.expected_revision === 'string' && REVISION.test(entry.expected_revision);
}

function read(): PendingNativeConfigurationOperation[] | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    if (raw.length > MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_ENTRIES || !parsed.every(valid)) return null;
    return parsed;
  } catch { return null; }
}

function write(entries: PendingNativeConfigurationOperation[]): boolean {
  try {
    const encoded = JSON.stringify(entries);
    if (encoded.length > MAX_BYTES) return false;
    sessionStorage.setItem(STORAGE_KEY, encoded);
    return true;
  } catch { return false; }
}

export function pendingNativeConfigurationOperation(identity: { installation_id: string; data_id: string }): PendingNativeConfigurationOperation | null {
  const runtimeKey = getRuntimeKey();
  if (isTransientRuntimeKey(runtimeKey)) return null;
  const entries = read();
  return entries?.find(entry => entry.runtime_key === runtimeKey && entry.installation_id === identity.installation_id
    && entry.data_id === identity.data_id) ?? null;
}

export function reserveNativeConfigurationOperation(identity: { installation_id: string; data_id: string },
  operationId: string, expectedRevision: string): boolean {
  const runtimeKey = getRuntimeKey();
  const next = { runtime_key: runtimeKey, installation_id: identity.installation_id,
    data_id: identity.data_id, operation_id: operationId, expected_revision: expectedRevision };
  if (!valid(next)) return false;
  const entries = read();
  if (!entries || entries.length >= MAX_ENTRIES || entries.some(entry => entry.runtime_key === runtimeKey && entry.installation_id === identity.installation_id
    && entry.data_id === identity.data_id)) return false;
  return write([...entries, next]);
}

export function clearNativeConfigurationOperation(entry: PendingNativeConfigurationOperation): void {
  const entries = read();
  if (!entries) return;
  write(entries.filter(item => item.runtime_key !== entry.runtime_key || item.installation_id !== entry.installation_id
    || item.data_id !== entry.data_id || item.operation_id !== entry.operation_id));
}
