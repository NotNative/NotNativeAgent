// SPDX-License-Identifier: Apache-2.0
/** Tab-scoped handle only. NNA owns the durable operation receipt.
 * The gateway source is required to exist, so its expected revision is always a
 * digest rather than 'absent'. */
import { createPendingOperationStore, type PendingOperationRecord } from './pending-operation-store.ts';

const store = createPendingOperationStore('nnd.gateway.timeout.pending.v1',
  { revisionPattern: /^[a-f0-9]{64}$/u });
export type PendingNativeGatewayOperation = PendingOperationRecord;

export function pendingNativeGatewayOperation(identity: { installation_id: string; data_id: string }): PendingNativeGatewayOperation | null {
  return store.pending(identity);
}
export function reserveNativeGatewayOperation(identity: { installation_id: string; data_id: string },
  operationId: string, expectedRevision: string): PendingNativeGatewayOperation | null {
  return store.reserve(identity, operationId, expectedRevision);
}
export function clearNativeGatewayOperation(entry: PendingNativeGatewayOperation): void {
  store.clear(entry);
}
