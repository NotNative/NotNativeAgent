// SPDX-License-Identifier: Apache-2.0
import { open } from 'node:fs/promises';
import { ContractError } from '../ids.js';
import { telegramRetryDelayMs } from './telegram-api.js';

export const MAX_GATEWAY_STATE_BYTES = 1_048_576;
const MAX_DURABLE_UPDATES = 256;
const MAX_DURABLE_REPLY_BYTES = 8_192;
const MAX_STANDALONE_REPLY_BYTES = 65_536;

export class AttachedReplayState {
  constructor({ api, controller, config, logger, inbox, save, stop, controls, bytes }) {
    Object.assign(this, { api, controller, config, logger, inbox, save, stop, controls, bytes });
    this.routes = {};
    this.replies = [];
    this.operations = {};
    this.suppressed = {};
  }

  load(state) { this.routes = state.routes; this.replies = state.replies;
    this.operations = state.operations; this.suppressed = state.suppressed; }

  async beginControl(updateId, action, targetId, suppressedIds = []) {
    if (this.operations[updateId]) return;
    this.operations[updateId] = { action, targetId };
    for (const id of suppressedIds) this.suppressed[id] = updateId;
    if (this.bytes() > MAX_GATEWAY_STATE_BYTES) {
      delete this.operations[updateId];
      for (const id of suppressedIds) delete this.suppressed[id];
      throw retainedUpdateError('gateway_state_full');
    }
    try { await this.save(); }
    catch { delete this.operations[updateId];
      for (const id of suppressedIds) delete this.suppressed[id];
      throw retainedUpdateError('gateway_state_write_failed'); }
  }

  async pinRoute(updateId, attachment) {
    if (this.routes[updateId]) return this.routes[updateId];
    const route = { targetId: attachment.targetId, alias: attachment.alias };
    this.routes[updateId] = route;
    if (this.bytes() > MAX_GATEWAY_STATE_BYTES) {
      delete this.routes[updateId];
      throw retainedUpdateError('gateway_state_full');
    }
    try { await this.save(); }
    catch { delete this.routes[updateId]; throw retainedUpdateError('gateway_state_write_failed'); }
    return route;
  }

  async queueReply(updateId, chatId, userId, text, alias) {
    if (this.replies.some((item) => item.updateId === updateId)) return;
    const prior = this.replies;
    this.replies = [...prior, { updateId, chatId, userId, text: boundedReply(text, alias), alias }];
    if (this.replies.length > MAX_DURABLE_UPDATES || this.bytes() > MAX_GATEWAY_STATE_BYTES) {
      this.replies = prior;
      throw retainedUpdateError('gateway_reply_queue_full');
    }
    try { await this.save(); }
    catch { this.replies = prior; throw retainedUpdateError('gateway_state_write_failed'); }
  }

  async drain() {
    if (this.draining) return this.draining;
    if (Date.now() < (this.retryAt ?? 0)) return;
    this.draining = (async () => {
      for (const item of this.replies) {
        // Invariant: delivery follows durable inbound acknowledgment, so a rejected submission cannot replay after its failure reply arrives.
        if (this.inbox().some((update) => Number(update.update_id) === item.updateId)) continue;
        if (this.config.authorized_user_ids.includes(item.userId)) {
          try { await this.api.sendMessage(item.chatId, item.text, this.controller.signal, this.controls(item.alias)); }
          catch (error) {
            this.logger.record({ type: 'gateway_reply_delivery_failed', code: error.code ?? 'telegram_unavailable', outcome: 'failed' });
            this.retryAt = Date.now() + telegramRetryDelayMs(error);
            break;
          }
        }
        this.replies = this.replies.filter((reply) => reply.updateId !== item.updateId);
        try { await this.save(); }
        catch (error) {
          this.logger.record({ type: 'gateway_state_failed', code: error.code ?? 'gateway_state_write_failed', outcome: 'failed' });
          this.stop();
          break;
        }
      }
    })().finally(() => { this.draining = null; });
    return this.draining;
  }
}

export function gatewayStateBytes(state) { return Buffer.byteLength(JSON.stringify(state)); }
export function retainedUpdateError(code) { return Object.assign(new Error(code), { code, retainUpdate: true }); }

export async function loadGatewayState(path) {
  let content;
  try {
    content = await readBoundedState(path);
  } catch (error) {
    if (error.code === 'ENOENT') return { offset: 0, inbox: [], routes: {}, replies: [], operations: {}, suppressed: {}, attachments: {} };
    throw error;
  }
  let value;
  try { value = JSON.parse(content); }
  catch { throw new ContractError('gateway_state_invalid', 'Gateway state is malformed; startup stopped to preserve replay evidence'); }
  if (![2, 3, 4].includes(value?.version) || !Number.isSafeInteger(value.offset) || value.offset < 0
    || !Array.isArray(value.inbox) || value.inbox.length > MAX_DURABLE_UPDATES
    || value.inbox.some((item) => !Number.isSafeInteger(item?.update_id) || item.update_id < 0 || item.update_id >= value.offset)) {
    throw new ContractError('gateway_state_invalid', 'Gateway state contract is invalid; startup stopped to preserve replay evidence');
  }
  const offset = value.offset;
  const inbox = value.inbox;
  // Compatibility: v2 never saved attachment selection, so a pending update has no recoverable route.
  if (value.version === 2 && inbox.length > 0)
    throw new ContractError('gateway_route_unrecoverable', 'Gateway v2 has pending updates without durable route evidence; resolve them before upgrading');
  if (value.version === 3 && inbox.length > 0)
    throw new ContractError('gateway_control_replay_unrecoverable', 'Gateway v3 has pending updates without durable command-attempt evidence; resolve them before upgrading');
  const known = new Set(inbox.map((item) => Number(item.update_id)));
  const routes = {};
  if (value.version >= 3 && value.routes && typeof value.routes === 'object' && !Array.isArray(value.routes)) {
    for (const [id, route] of Object.entries(value.routes)) {
      if (!known.has(Number(id)) || typeof route?.targetId !== 'string' || typeof route?.alias !== 'string')
        throw new ContractError('gateway_state_invalid', 'Gateway route evidence is invalid');
      routes[id] = { targetId: route.targetId, alias: route.alias };
    }
  }
  const replies = value.version >= 3 ? value.replies : [];
  const operations = value.version === 4 ? value.operations : {};
  const suppressed = value.version === 4 ? value.suppressed ?? {} : {};
  const attachments = {};
  if (value.version >= 3 && value.attachments && typeof value.attachments === 'object' && !Array.isArray(value.attachments)) {
    for (const [chatId, target] of Object.entries(value.attachments)) {
      if (typeof target?.targetId !== 'string' || typeof target?.alias !== 'string')
        throw new ContractError('gateway_state_invalid', 'Gateway attachment evidence is invalid');
      attachments[chatId] = target;
    }
  }
  if (value.version >= 3 && (!Array.isArray(replies) || replies.length > MAX_DURABLE_UPDATES
    || replies.some((item) => !Number.isSafeInteger(item?.updateId)
      || typeof item.chatId !== 'string' || typeof item.userId !== 'string'
      || typeof item.text !== 'string' || typeof item.alias !== 'string')
    || !value.routes || typeof value.routes !== 'object' || Array.isArray(value.routes)
    || !value.attachments || typeof value.attachments !== 'object' || Array.isArray(value.attachments)
    || !operations || typeof operations !== 'object' || Array.isArray(operations)
    || value.version === 4 && !Object.hasOwn(value, 'operations')
    || Object.entries(operations).some(([id, item]) => !known.has(Number(id)) || String(Number(id)) !== id
      || !['compact', 'handoff', 'clear', 'cancel', 'attach', 'detach'].includes(item?.action)
      || !(item.targetId === null || typeof item.targetId === 'string'))
    || !suppressed || typeof suppressed !== 'object' || Array.isArray(suppressed)
    || Object.entries(suppressed).some(([id, cancelId]) => !known.has(Number(id)) || String(Number(id)) !== id
      || !Number.isSafeInteger(cancelId) || cancelId <= Number(id) || cancelId >= offset)))
    throw new ContractError('gateway_state_invalid', 'Gateway delivery evidence is invalid');
  return { offset, inbox, routes, replies, operations, suppressed, attachments };
}

async function readBoundedState(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_GATEWAY_STATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_GATEWAY_STATE_BYTES) {
      throw new ContractError('gateway_state_invalid', 'Gateway state exceeds its bound; startup stopped to preserve replay evidence');
    }
    return buffer.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
}

function boundedReply(text, alias) {
  const content = String(text);
  const limit = alias ? MAX_DURABLE_REPLY_BYTES : MAX_STANDALONE_REPLY_BYTES;
  if (Buffer.byteLength(content) <= limit) return content;
  const suffix = alias ? '\n\nReply shortened for Telegram. Open the attached Console conversation for the full result.'
    : '\n\nReply shortened for Telegram. Ask NNA to restate the missing details.';
  return `${Buffer.from(content).subarray(0, limit - Buffer.byteLength(suffix)).toString('utf8')}${suffix}`;
}
