// SPDX-License-Identifier: Apache-2.0
/** Tab-scoped handle only. NNA owns the durable receipt; upsert and delete are
 * idempotent by construction, so the handle only tells this tab what it just asked
 * for (receipt persistence 'absent' means nothing was stored — an honest no-op). */
import { getRuntimeKey, isTransientRuntimeKey } from '../runtime-switch.ts';

const KEY = 'nnd.mcp-credentials.pending.v1';
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATION = /^[A-Za-z0-9_-]{1,64}$/u;
const REFERENCE = /^NNA_MCP_MANAGED_[A-Z0-9_]+_[0-9A-F]{12}_TOKEN$/u;
export interface PendingNativeMcpCredentialOperation { runtime_key: string; installation_id: string;
  data_id: string; operation_id: string; reference?: string }
function valid(value: unknown): value is PendingNativeMcpCredentialOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.runtime_key === 'string' && entry.runtime_key.length <= 512 && !isTransientRuntimeKey(entry.runtime_key)
    && typeof entry.installation_id === 'string' && ID.test(entry.installation_id)
    && typeof entry.data_id === 'string' && ID.test(entry.data_id)
    && typeof entry.operation_id === 'string' && OPERATION.test(entry.operation_id)
    && (entry.reference === undefined || typeof entry.reference === 'string' && REFERENCE.test(entry.reference));
}
function read(): PendingNativeMcpCredentialOperation[] | null {
  try { const raw = sessionStorage.getItem(KEY); if (raw === null) return [];
    if (raw.length > 65536) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length <= 128 && parsed.every(valid) ? parsed : null;
  } catch { return null; }
}
function write(entries: PendingNativeMcpCredentialOperation[]): boolean {
  try { const encoded = JSON.stringify(entries); if (encoded.length > 65536) return false;
    sessionStorage.setItem(KEY, encoded); return true; } catch { return false; }
}
export function pendingNativeMcpCredentialOperation(identity: { installation_id: string; data_id: string }): PendingNativeMcpCredentialOperation | null {
  const runtime = getRuntimeKey(); if (isTransientRuntimeKey(runtime)) return null;
  return read()?.find(item => item.runtime_key === runtime && item.installation_id === identity.installation_id
    && item.data_id === identity.data_id) ?? null;
}
export function reserveNativeMcpCredentialOperation(identity: { installation_id: string; data_id: string },
  operationId: string, reference?: string): PendingNativeMcpCredentialOperation | null {
  const entry = { runtime_key: getRuntimeKey(), installation_id: identity.installation_id,
    data_id: identity.data_id, operation_id: operationId, ...(reference ? { reference } : {}) };
  if (!valid(entry)) return null;
  const entries = read();
  if (!entries || entries.length >= 128 || entries.some(item => item.runtime_key === entry.runtime_key
    && item.installation_id === entry.installation_id && item.data_id === entry.data_id
    && (item.operation_id === entry.operation_id
      || item.reference !== undefined && item.reference === entry.reference))) return null;
  return write([...entries, entry]) ? entry : null;
}
export function clearNativeMcpCredentialOperation(entry: PendingNativeMcpCredentialOperation): void {
  const entries = read(); if (!entries) return;
  write(entries.filter(item => item.runtime_key !== entry.runtime_key || item.installation_id !== entry.installation_id
    || item.data_id !== entry.data_id || item.operation_id !== entry.operation_id));
}
