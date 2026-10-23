// SPDX-License-Identifier: Apache-2.0
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from '../ids.js';
import { acknowledgeTelegramNotification, MAX_OUTBOX_BATCH, readTelegramOutbox, reconcileTelegramNotifications } from '../notifications/telegram.js';
import { persistAtomicJson, persistAtomicJsonIfAbsent } from '../persistence/atomic-json.js';
import { loadGatewayConfig, normalizeUserId } from './config.js';
import { attachedControls } from './controls.js';

const MAX_DELIVERY_STATE_BYTES = 65_536;
const MAX_DELIVERY_RECIPIENTS = 1_024;
const MAX_DELIVERY_ATTEMPTS = 32;
const MAX_ATTEMPTS_PER_ITEM = 4;
const MAX_ORPHAN_CHECKS = 32;
const DELIVERY_FILE = /^[a-f0-9-]+\.json$/iu;

export async function drainGatewayNotifications(gateway, options = {}) {
  const journalCache = new Map();
  const report = (key, type, code) => {
    if (gateway.invalidNotificationIntents.has(key)) return;
    if (gateway.invalidNotificationIntents.size >= 1_024) {
      gateway.invalidNotificationIntents.delete(gateway.invalidNotificationIntents.values().next().value);
    }
    gateway.invalidNotificationIntents.add(key);
    gateway.logger.record({ type, code, outcome: 'failed' });
  };
  const onSourceError = (sessionId, code) => report(`source:${sessionId}:${code}`,
    'gateway_notification_source_failed', code);
  const onFileError = (name, code) => report(`file:${name}:${code}`, 'gateway_notification_file_failed', code);
  await reconcileTelegramNotifications(gateway.paths.telegramOutbox, gateway.paths.sessions, {
    journalCache, offset: gateway.notificationIntentCursor, signal: gateway.controller.signal,
    onInvalid: (name) => report(`intent:${name}`, 'gateway_notification_intent_invalid', 'notification_intent_invalid'),
    onSourceError, onFileError,
  });
  gateway.notificationIntentCursor = (gateway.notificationIntentCursor + MAX_OUTBOX_BATCH) % Number.MAX_SAFE_INTEGER;
  await cleanupDeliveryStates(gateway, report);
  const items = await readTelegramOutbox(gateway.paths.telegramOutbox, gateway.paths.sessions, {
    journalCache, offset: gateway.notificationCursor, signal: gateway.controller.signal, onSourceError, onFileError,
  });
  if (items.length === 0) {
    gateway.notificationCursor = (gateway.notificationCursor + MAX_DELIVERY_ATTEMPTS) % Number.MAX_SAFE_INTEGER;
    return;
  }
  const catalog = await gateway.sessionDirectory.list();
  let operations = 0; let visited = 0;
  for (const item of items) {
    if (operations >= MAX_DELIVERY_ATTEMPTS) break;
    visited += 1;
    try {
      const result = await deliverItem(gateway, item, catalog, MAX_DELIVERY_ATTEMPTS - operations, options);
      operations += result.operations;
    } catch (error) {
      if (gateway.controller.signal.aborted) throw error;
      report(`delivery:${item.id}:${error?.code ?? 'internal_failure'}`,
        'gateway_notification_delivery_failed', error?.code ?? 'notification_delivery_failed');
    }
  }
  // Why: a bounded drain must advance past the items it actually examined, including failures.
  gateway.notificationCursor = (gateway.notificationCursor + Math.max(1, visited)) % Number.MAX_SAFE_INTEGER;
}

async function deliverItem(gateway, item, catalog, budget, options) {
  const config = await currentConfig(gateway);
  if (config.enabled === false) return { operations: 0 };
  const recipients = config.authorized_user_ids.map(normalizeUserId);
  const state = await deliveryState(gateway.paths.telegramOutbox, item.id, recipients);
  if (!state) return { operations: 0 };
  const source = catalog.find((target) => target.id === item.session_id);
  let operations = 0;
  const entries = Object.entries(state.recipients);
  const start = entries.length ? state.next_recipient % entries.length : 0;
  const ordered = [...entries.slice(start), ...entries.slice(0, start)];
  for (const [chatId, status] of ordered) {
    if (status !== 'pending' || operations >= Math.min(budget, MAX_ATTEMPTS_PER_ITEM)) continue;
    const nextRecipient = entries.length ? (entries.findIndex(([id]) => id === chatId) + 1) % entries.length : 0;
    const current = await currentConfig(gateway);
    if (current.enabled === false) break;
    if (!current.authorized_user_ids.includes(chatId)) {
      operations += 1;
      await checkpoint(state, chatId, 'revoked', nextRecipient, gateway.paths.telegramOutbox, options);
      continue;
    }
    const attached = gateway.attachments.get(chatId);
    const sendOptions = source && attached && attached.targetId === source.targetId ? attachedControls(source.alias)
      : source ? { replyMarkup: { inline_keyboard: [[
        { text: `Attach ${source.alias}`, callback_data: `nna:a:${source.targetId}` },
        { text: 'Sessions', callback_data: 'nna:s' },
      ]] } } : {};
    operations += 1;
    try {
      await gateway.api.sendMessage(chatId, `NNA notification (${item.outcome}):\n${item.message}`,
        gateway.controller.signal, sendOptions);
    } catch (error) {
      if (gateway.controller.signal.aborted) throw error;
      gateway.logger.record({ type: 'gateway_notification_recipient_failed',
        code: error?.code ?? 'telegram_unavailable', outcome: 'failed', session_id: item.session_id });
      await checkpoint(state, chatId, 'pending', nextRecipient, gateway.paths.telegramOutbox, options);
      continue;
    }
    // Invariant: never attempt another recipient after an unrecorded success.
    await checkpoint(state, chatId, 'delivered', nextRecipient, gateway.paths.telegramOutbox, options);
  }
  if (Object.values(state.recipients).every((status) => status !== 'pending')) {
    const statuses = Object.values(state.recipients);
    await acknowledgeTelegramNotification(item);
    await unlink(deliveryPath(gateway.paths.telegramOutbox, item.id)).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    const delivered = statuses.filter((status) => status === 'delivered').length;
    gateway.logger.record({ type: delivered ? 'gateway_notification_delivered' : 'gateway_notification_skipped',
      outcome: 'completed', session_id: item.session_id, delivered_count: delivered,
      revoked_count: statuses.length - delivered });
  }
  return { operations };
}

function deliveryPath(root, id) {
  if (!/^[a-f0-9-]+$/iu.test(id)) throw new ContractError('notification_delivery_state_invalid', 'Invalid notification delivery ID');
  return join(root, 'delivery', `${id}.json`);
}

async function deliveryDirectory(root) {
  const directory = join(root, 'delivery');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ContractError('notification_delivery_path_unsafe', 'Telegram delivery state directory is unsafe');
  }
  return directory;
}

async function deliveryState(root, id, recipients) {
  await deliveryDirectory(root);
  const path = deliveryPath(root, id);
  try { await lstat(path); return readDeliveryState(path, id); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (recipients.length > MAX_DELIVERY_RECIPIENTS) {
    throw new ContractError('notification_delivery_recipients_full', 'Telegram notification recipient list exceeds its bound');
  }
  const snapshot = { version: 1, notification_id: id, next_recipient: 0,
    recipients: Object.fromEntries(recipients.map((recipient) => [recipient, 'pending'])) };
  try { await persistAtomicJsonIfAbsent(path, snapshot); return snapshot; }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  return readDeliveryState(path, id);
}

async function readDeliveryState(path, id) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DELIVERY_STATE_BYTES) {
    throw new ContractError('notification_delivery_state_invalid', 'Telegram delivery state is not a bounded regular file');
  }
  let state;
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_DELIVERY_STATE_BYTES
      || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new ContractError('notification_delivery_state_invalid', 'Telegram delivery state changed or exceeded its bound');
    }
    const bytes = Buffer.alloc(MAX_DELIVERY_STATE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_DELIVERY_STATE_BYTES) {
      throw new ContractError('notification_delivery_state_invalid', 'Telegram delivery state exceeded its bound');
    }
    state = JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ContractError('notification_delivery_state_invalid', 'Telegram delivery state is malformed');
    }
    throw error;
  } finally { await handle.close(); }
  const validRecipients = state?.recipients !== null && typeof state?.recipients === 'object'
    && !Array.isArray(state.recipients);
  const ids = validRecipients ? Object.keys(state.recipients) : [];
  if (state?.version !== 1 || state.notification_id !== id || !validRecipients
    || Object.keys(state).sort().join(',') !== 'next_recipient,notification_id,recipients,version'
    || !Number.isSafeInteger(state.next_recipient) || state.next_recipient < 0
    || (ids.length ? state.next_recipient >= ids.length : state.next_recipient !== 0)
    || ids.length > MAX_DELIVERY_RECIPIENTS
    || ids.some((recipient) => {
      try { return normalizeUserId(recipient) !== recipient
        || !['pending', 'delivered', 'revoked'].includes(state.recipients[recipient]); }
      catch { return true; }
    })) {
    throw new ContractError('notification_delivery_state_invalid', 'Telegram delivery state is invalid');
  }
  return state;
}

async function checkpoint(state, chatId, status, nextRecipient, root, options) {
  const updated = { ...state, next_recipient: nextRecipient,
    recipients: { ...state.recipients, [chatId]: status } };
  const persist = options.persistState ?? persistAtomicJson;
  await persist(deliveryPath(root, state.notification_id), updated);
  state.recipients[chatId] = status;
  state.next_recipient = nextRecipient;
}

async function cleanupDeliveryStates(gateway, report) {
  const root = gateway.paths.telegramOutbox;
  const directory = await deliveryDirectory(root);
  const names = (await readdir(directory)).filter((name) => DELIVERY_FILE.test(name)).sort();
  const start = names.length ? (gateway.notificationCleanupCursor ?? 0) % names.length : 0;
  const selected = [...names.slice(start), ...names.slice(0, start)].slice(0, MAX_ORPHAN_CHECKS);
  gateway.notificationCleanupCursor = ((gateway.notificationCleanupCursor ?? 0) + MAX_ORPHAN_CHECKS) % Number.MAX_SAFE_INTEGER;
  for (const name of selected) {
    const ready = join(root, name);
    try { await lstat(ready); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try { await unlink(join(directory, name)); }
      catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') report(`orphan:${name}:${unlinkError?.code}`,
          'gateway_notification_delivery_cleanup_failed', unlinkError?.code ?? 'notification_delivery_cleanup_failed');
      }
    }
  }
}

async function currentConfig(gateway) {
  return gateway.paths.gatewayConfig ? loadGatewayConfig(gateway.paths.gatewayConfig) : gateway.config;
}
