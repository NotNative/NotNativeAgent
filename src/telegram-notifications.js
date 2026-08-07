// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';

export class TelegramNotificationQueue {
  constructor(root, sessionId) { this.root = root; this.sessionId = sessionId; this.pending = new Map(); }
  schedule(turnId, message) {
    if (!turnId) throw new ContractError('notification_turn_missing', 'Telegram notification requires an active turn');
    this.pending.set(turnId, String(message).trim());
  }
  async terminal(record) {
    const message = this.pending.get(record.turn_id);
    if (!message) return false;
    this.pending.delete(record.turn_id);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const id = randomUUID(); const path = join(this.root, `${id}.json`); const temporary = `${path}.tmp-${process.pid}`;
    await writeFile(temporary, `${JSON.stringify({
      version: 1, id, session_id: this.sessionId, message,
      outcome: record.outcome, created_at: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    await rename(temporary, path);
    return true;
  }
}

export function telegramNotificationDefinition(control, activeTurnId) {
  return {
    name: 'notification.telegram', version: 1,
    purpose: 'Ask the NNA gateway to notify the operator on Telegram after the current turn reaches a terminal outcome.',
    sideEffect: 'external_communication', scope: 'operator_notification', cancellation: true, timeoutMs: 2_000,
    inputSchema: {
      type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 1000 } },
      required: ['message'], additionalProperties: false,
    },
    validate: async (args) => {
      if (!args || typeof args.message !== 'string' || !args.message.trim() || args.message.length > 1000
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
  const items = [];
  for (const name of names.filter((item) => /^[a-f0-9-]+\.json$/iu.test(item)).slice(0, 128)) {
    const path = join(root, name);
    try {
      const bytes = await readFile(path);
      if (bytes.length > 16_384) { await unlink(path); continue; }
      const value = JSON.parse(bytes.toString('utf8'));
      if (typeof value.message === 'string' && typeof value.session_id === 'string') items.push({ ...value, path });
      else await unlink(path);
    } catch { await unlink(path).catch(() => undefined); }
  }
  return items;
}

export function acknowledgeTelegramNotification(item) { return unlink(item.path).catch(() => undefined); }
