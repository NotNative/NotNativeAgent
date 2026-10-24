// SPDX-License-Identifier: Apache-2.0
import { persistAtomicJson } from '../persistence/atomic-json.js';
import { ContractError } from '../ids.js';
import { gatewayStateBytes, MAX_GATEWAY_STATE_BYTES } from './attached-replay.js';

export function gatewayStateSnapshot(gateway, overrides = {}) {
  return { version: 4, offset: gateway.offset, inbox: gateway.inbox,
    attachments: Object.fromEntries(gateway.attachments), routes: gateway.replay.routes,
    replies: gateway.replay.replies, operations: gateway.replay.operations,
    suppressed: gateway.replay.suppressed, ...overrides };
}

export function queueGatewayStateWrite(gateway) {
  // Capture the exact requested revision before an earlier queued write can yield.
  let snapshot; let snapshotError;
  try { snapshot = structuredClone(gatewayStateSnapshot(gateway)); }
  catch (error) { snapshotError = error; }
  const write = gateway.stateWrites.then(() => {
    if (gateway.stateWriteFailure) throw gateway.stateWriteFailure;
    if (snapshotError) throw snapshotError;
    if (gatewayStateBytes(snapshot) > MAX_GATEWAY_STATE_BYTES) {
      throw new ContractError('gateway_state_full', 'Gateway state exceeds its durable file bound');
    }
    return persistAtomicJson(gateway.statePath, snapshot);
  }).catch((error) => {
    // Invariant: after a persistence failure, no further update can be acknowledged as durable.
    if (!gateway.stateWriteFailure) {
      gateway.stateWriteFailure = error;
      gateway.running = false;
      gateway.controller.abort();
    }
    throw gateway.stateWriteFailure;
  });
  gateway.stateWrites = write.catch(() => undefined);
  return write;
}
