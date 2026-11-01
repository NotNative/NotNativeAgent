// SPDX-License-Identifier: Apache-2.0
/** Tab-scoped native MCP operation handle; NNA remains the receipt authority.
 * MCP operations use the 128-character installation id grammar for their
 * operation id and require a persisted digest revision. */
import { createPendingOperationStore, type PendingOperationRecord } from './pending-operation-store.ts';

const store = createPendingOperationStore('nnd.mcp.pending.v1', {
  operationPattern: /^[A-Za-z0-9_-]{1,128}$/u,
  revisionPattern: /^[a-f0-9]{64}$/u,
});
export type PendingNativeMcpOperation = PendingOperationRecord;

export function pendingNativeMcpOperation(identity: { installation_id: string; data_id: string }): PendingNativeMcpOperation | null {
  return store.pending(identity);
}
export function reserveNativeMcpOperation(identity: { installation_id: string; data_id: string },
  operationId: string, expectedRevision: string): PendingNativeMcpOperation | null {
  return store.reserve(identity, operationId, expectedRevision);
}
export function clearNativeMcpOperation(entry: PendingNativeMcpOperation): void {
  store.clear(entry);
}
