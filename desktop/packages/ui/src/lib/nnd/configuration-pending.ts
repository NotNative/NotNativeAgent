// SPDX-License-Identifier: Apache-2.0
/** Tab-scoped recovery handles. NNA's operation ledger remains authoritative. */
import { createPendingOperationStore, type PendingOperationRecord } from './pending-operation-store.ts';

const store = createPendingOperationStore('nnd.configuration.pending.v1',
  { operationPattern: /^[A-Za-z0-9_-]{1,128}$/u });
export type PendingNativeConfigurationOperation = PendingOperationRecord;

export function pendingNativeConfigurationOperation(identity: { installation_id: string; data_id: string }): PendingNativeConfigurationOperation | null {
  return store.pending(identity);
}
export function reserveNativeConfigurationOperation(identity: { installation_id: string; data_id: string },
  operationId: string, expectedRevision: string): boolean {
  return store.reserve(identity, operationId, expectedRevision) !== null;
}
export function clearNativeConfigurationOperation(entry: PendingNativeConfigurationOperation): void {
  store.clear(entry);
}
