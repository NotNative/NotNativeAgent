// SPDX-License-Identifier: Apache-2.0
/** Tab-scoped handle only. NNA owns the durable operation receipt.
 * WebSearch variant of the native-gateway pending handle; the expected revision may be
 * 'absent' because a first profile save can bootstrap over an absent source file. */
import { createPendingOperationStore, type PendingOperationRecord } from './pending-operation-store.ts';

const store = createPendingOperationStore('nnd.websearch.settings.pending.v1');
export type PendingNativeWebSearchOperation = PendingOperationRecord;

export function pendingNativeWebSearchOperation(identity: { installation_id: string; data_id: string }): PendingNativeWebSearchOperation | null {
  return store.pending(identity);
}
export function reserveNativeWebSearchOperation(identity: { installation_id: string; data_id: string },
  operationId: string, expectedRevision: string): PendingNativeWebSearchOperation | null {
  return store.reserve(identity, operationId, expectedRevision);
}
export function clearNativeWebSearchOperation(entry: PendingNativeWebSearchOperation): void {
  store.clear(entry);
}
