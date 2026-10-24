// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { MAX_GATEWAY_STATE_BYTES } from './attached-replay.js';

const MAX_DURABLE_UPDATES = 256;

/** Admit only updates that can be durably retained; signal temporary backpressure. */
export async function acceptGatewayUpdates(gateway, updates, stateBytes, saveState) {
  const known = new Set(gateway.inbox.map((item) => Number(item.update_id)));
  let blocked = false;
  for (const update of updates) {
    const updateId = Number(update?.update_id);
    if (!Number.isSafeInteger(updateId) || updateId < gateway.offset) continue;
    if (gateway.inbox.length >= MAX_DURABLE_UPDATES) { blocked = true; break; }
    if (!known.has(updateId)) {
      const candidate = [...gateway.inbox, update];
      if (stateBytes({ offset: updateId + 1, inbox: candidate }) > MAX_GATEWAY_STATE_BYTES) {
        // No pending inbound work or reply can make room: fail visibly instead of polling forever.
        if (gateway.inbox.length === 0 && gateway.replay.replies.length === 0) {
          throw new ContractError('gateway_state_full', 'Telegram update cannot fit in durable gateway state');
        }
        blocked = true; break;
      }
      gateway.inbox = candidate; known.add(updateId);
    }
    gateway.offset = updateId + 1;
  }
  await saveState();
  return blocked;
}
