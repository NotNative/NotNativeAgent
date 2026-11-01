// SPDX-License-Identifier: Apache-2.0
/** Tab-scoped handle only. NNA owns the durable operation receipt.
 * Compatibility-service variant of the native-gateway pending handle; the expected
 * revision may be 'absent' because a first save can bootstrap over an absent source
 * file. */
import { createPendingOperationStore, type PendingOperationRecord } from './pending-operation-store.ts';

const store = createPendingOperationStore('nnd.compatibility.settings.pending.v1');
export type PendingNativeCompatibilityOperation = PendingOperationRecord;

export function pendingNativeCompatibilityOperation(identity: { installation_id: string; data_id: string }): PendingNativeCompatibilityOperation | null {
  return store.pending(identity);
}
export function reserveNativeCompatibilityOperation(identity: { installation_id: string; data_id: string },
  operationId: string, expectedRevision: string): PendingNativeCompatibilityOperation | null {
  return store.reserve(identity, operationId, expectedRevision);
}
export function clearNativeCompatibilityOperation(entry: PendingNativeCompatibilityOperation): void {
  store.clear(entry);
}
