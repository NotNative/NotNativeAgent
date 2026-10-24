// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';
import { MAX_GATEWAY_STATE_BYTES } from './attached-replay.js';

const MAX_DURABLE_UPDATES = 256;

/** Admit only updates that can be durably retained; signal temporary backpressure. */
export async function acceptGatewayUpdates(gateway, updates, stateBytes, saveState) {
  const received = Array.isArray(updates) ? updates : [...updates];
  const known = new Set(gateway.inbox.map((item) => Number(item.update_id)));
  // Most Telegram batches fit. Check their complete ordered projection once,
  // then use the per-update path only when capacity actually becomes tight.
  const batch = [...gateway.inbox];
  let batchOffset = gateway.offset;
  let batchWithinCount = true;
  for (const update of received) {
    const updateId = Number(update?.update_id);
    if (!Number.isSafeInteger(updateId) || updateId < batchOffset) continue;
    if (batch.length >= MAX_DURABLE_UPDATES) { batchWithinCount = false; break; }
    if (!known.has(updateId)) { batch.push(update); known.add(updateId); }
    batchOffset = updateId + 1;
  }
  if (batchWithinCount && (batch.length === gateway.inbox.length
    || stateBytes({ offset: batchOffset, inbox: batch }) <= MAX_GATEWAY_STATE_BYTES)) {
    gateway.inbox = batch;
    gateway.offset = batchOffset;
    await saveState();
    return false;
  }
  known.clear();
  for (const item of gateway.inbox) known.add(Number(item.update_id));
  let blocked = false;
  for (const update of received) {
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
