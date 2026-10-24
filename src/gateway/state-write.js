// SPDX-License-Identifier: Apache-2.0
import { persistAtomicJson } from '../persistence/atomic-json.js';

export function gatewayStateSnapshot(gateway, overrides = {}) {
  return { version: 4, offset: gateway.offset, inbox: gateway.inbox,
    attachments: Object.fromEntries(gateway.attachments), routes: gateway.replay.routes,
    replies: gateway.replay.replies, operations: gateway.replay.operations,
    suppressed: gateway.replay.suppressed, ...overrides };
}

export function queueGatewayStateWrite(gateway) {
  const write = gateway.stateWrites.then(() => {
    if (gateway.stateWriteFailure) throw gateway.stateWriteFailure;
    return persistAtomicJson(gateway.statePath, gatewayStateSnapshot(gateway));
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
