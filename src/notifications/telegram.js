// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from '../ids.js';

const NOTIFICATION_TIMEOUT_MS = 2_000;
const MAX_NOTIFICATION_LENGTH = 1_000;
const MAX_OUTBOX_BATCH = 128;
const MAX_OUTBOX_FILE_BYTES = 16_384;

export class TelegramNotificationQueue {
  constructor(root, sessionId) { this.root = root; this.sessionId = sessionId; this.pending = new Map(); }
  schedule(turnId, message) {
    if (!turnId) throw new ContractError('notification_turn_missing', 'Telegram notification requires an active turn');
    if (typeof message !== 'string' || !message.trim()) throw new ContractError('notification_invalid', 'Telegram notification requires a message');
    if (this.pending.has(turnId)) throw new ContractError('notification_duplicate', 'a Telegram notification is already scheduled for this turn');
    this.pending.set(turnId, message.trim());
  }
  async terminal(record) {
    const message = this.pending.get(record.turn_id);
    if (!message) return false;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID(); const path = join(this.root, `${id}.json`); const temporary = `${path}.tmp-${process.pid}`;
    try {
      await writeFile(temporary, `${JSON.stringify({
        version: 1, id, session_id: this.sessionId, message,
        outcome: record.outcome, created_at: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
      await rename(temporary, path);
      this.pending.delete(record.turn_id);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return true;
  }
}

export function telegramNotificationDefinition(control, activeTurnId) {
  return {
    name: 'notification.telegram', version: 1,
    purpose: 'Ask the NNA gateway to notify the operator on Telegram after the current turn reaches a terminal outcome.',
    sideEffect: 'external_communication', scope: 'operator_notification', cancellation: true, timeoutMs: NOTIFICATION_TIMEOUT_MS,
    inputSchema: {
      type: 'object', properties: {
        message: { type: 'string', minLength: 1, maxLength: MAX_NOTIFICATION_LENGTH, description: 'Required message to send to the configured operator after this turn finishes.' },
      },
      required: ['message'], additionalProperties: false,
    },
    validate: async (args) => {
      if (!args || typeof args.message !== 'string' || !args.message.trim() || args.message.length > MAX_NOTIFICATION_LENGTH
        || Object.keys(args).some((key) => key !== 'message')) {
        throw new ContractError('notification_invalid', 'Telegram notification requires one bounded message');
      }
      return { args: { message: args.message.trim() }, resolved: { destination: 'configured_telegram_operator' } };
    },
    executor: async (request, signal) => {
      if (signal.aborted) throw new ContractError('tool_cancelled', 'Telegram notification was cancelled');
      control.schedule(activeTurnId(), request.args.message);
      return { content: 'Telegram notification scheduled for turn completion', metadata: { delivery: 'turn_terminal' } };
    },
  };
}

export async function readTelegramOutbox(root) {
  let names;
  try { names = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const selected = names.filter((item) => /^[a-f0-9-]+\.json$/iu.test(item)).slice(0, MAX_OUTBOX_BATCH);
  const settled = await Promise.all(selected.map(async (name) => {
    const path = join(root, name);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_OUTBOX_FILE_BYTES) { await unlink(path); return null; }
      const bytes = await readFile(path);
      const value = JSON.parse(bytes.toString('utf8'));
      if (typeof value.message === 'string' && typeof value.session_id === 'string') return { ...value, path };
      await unlink(path); return null;
    } catch { await unlink(path).catch(() => undefined); return null; }
  }));
  return settled.filter(Boolean);
}

export async function acknowledgeTelegramNotification(item) {
  try { await unlink(item.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
