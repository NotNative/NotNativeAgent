// SPDX-License-Identifier: Apache-2.0
/** Tab-scoped handle only. NNA owns the durable operation receipt.
 * WebFetch variant of the native-gateway pending handle; the expected revision may be
 * 'absent' because a first trust save can bootstrap over an absent source file. */
import { createPendingOperationStore, type PendingOperationRecord } from './pending-operation-store.ts';

const store = createPendingOperationStore('nnd.webfetch.trust.pending.v1');
export type PendingNativeWebFetchOperation = PendingOperationRecord;

export function pendingNativeWebFetchOperation(identity: { installation_id: string; data_id: string }): PendingNativeWebFetchOperation | null {
  return store.pending(identity);
}
export function reserveNativeWebFetchOperation(identity: { installation_id: string; data_id: string },
  operationId: string, expectedRevision: string): PendingNativeWebFetchOperation | null {
  return store.reserve(identity, operationId, expectedRevision);
}
export function clearNativeWebFetchOperation(entry: PendingNativeWebFetchOperation): void {
  store.clear(entry);
}
