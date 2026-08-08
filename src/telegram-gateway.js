// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanonicalIngress } from './ingress.js';
import { SessionEngine } from './engine.js';
import { newId } from './ids.js';
import { StructuredLog } from './structured-log.js';
import { FairScheduler } from './fair-scheduler.js';
import { ConsoleSessionDirectory } from './session-broker.js';
import { acknowledgeTelegramNotification, readTelegramOutbox } from './telegram-notifications.js';

export class TelegramGateway {
  constructor(options) {
    this.api = options.api;
    this.config = options.config;
    this.engineConfig = options.engineConfig;
    this.paths = options.paths;
    this.engineOptions = options.engineOptions ?? {};
    this.engineFactory = options.engineFactory ?? ((engineOptions) => new SessionEngine(engineOptions));
    this.sessions = new Map();
    this.attachments = new Map();
    this.pendingClears = new Map();
    this.catalogs = new Map();
    this.queues = new Map();
    this.offset = 0;
    this.running = false;
    this.controller = new AbortController();
    this.logger = options.logger ?? new StructuredLog({ path: join(this.paths.logs, 'gateway.ndjson') });
    this.scheduler = options.scheduler ?? new FairScheduler({
      limit: this.engineConfig.limits.providerConcurrency, maxQueued: this.engineConfig.limits.providerQueueLimit,
    });
    this.sessionDirectory = options.sessionDirectory ?? new ConsoleSessionDirectory(this.paths.sessionBrokers ?? join(this.paths.gateway, 'session-brokers'));
  }

  async initialize() {
    await mkdir(this.paths.gateway, { recursive: true, mode: 0o700 });
    await this.logger.initialize();
    this.offset = await loadOffset(join(this.paths.gateway, 'state.json'));
    const bot = await this.api.getMe(this.controller.signal);
    this.logger.record({ type: 'gateway_initialized', status: 'ready' });
    return { id: bot.id, username: bot.username ?? null };
  }

  async run() {
    const bot = await this.initialize();
    this.running = true;
    while (this.running && !this.controller.signal.aborted) {
      let updates;
      try {
        updates = await this.api.getUpdates(this.offset, this.config.polling_timeout_seconds, this.controller.signal);
      } catch (error) {
        if (this.controller.signal.aborted) break;
        this.logger.record({ type: 'gateway_poll_failed', code: error.code ?? 'telegram_unavailable', outcome: 'failed' });
        await delay(1_000, this.controller.signal).catch(() => undefined);
        continue;
      }
      for (const update of updates) {
        this.offset = Math.max(this.offset, Number(update.update_id) + 1);
        this.#dispatch(update);
      }
      await this.#drainNotifications().catch((error) => this.logger.record({
        type: 'gateway_notification_failed', code: error.code ?? 'notification_delivery_failed', outcome: 'failed',
      }));
      await saveOffset(join(this.paths.gateway, 'state.json'), this.offset);
    }
    await this.shutdown();
    return bot;
  }

  async shutdown() {
    if (!this.running && this.sessions.size === 0) return;
    this.running = false;
    this.controller.abort();
    await Promise.allSettled([...this.sessions.values()].map((item) => item.ingress.submit({
      version: '1.0', type: 'cancel', request_id: newId('gateway_shutdown_cancel'),
    }, 'authenticated-gateway-runtime')));
    await Promise.allSettled([...this.queues.values()].map((item) => item.operation));
    await Promise.allSettled([...this.sessions.values()].map((item) => item.engine.shutdown({
      version: '1.0', type: 'shutdown', request_id: newId('gateway_shutdown'),
    })));
    this.sessions.clear();
    this.logger.record({ type: 'gateway_stopped', status: 'completed' });
    await this.logger.flush();
  }

  #dispatch(update) {
    const message = update?.message ?? update?.callback_query?.message;
    const chatId = message?.chat ? String(message.chat.id) : null;
    if (!chatId || message?.text?.trim() === '/cancel') {
      this.#handle(update).catch((error) => this.#recordUpdateFailure(error));
      return;
    }
    const queue = this.queues.get(chatId) ?? { operation: Promise.resolve(), pending: 0 };
    if (queue.pending >= 16) {
      this.logger.record({ type: 'gateway_queue_full', code: 'gateway_chat_queue_full', outcome: 'failed' });
      return;
    }
    queue.pending += 1;
    queue.operation = queue.operation.then(() => this.#handle(update)).catch((error) => this.#recordUpdateFailure(error)).finally(() => {
      queue.pending -= 1;
      if (queue.pending === 0) this.queues.delete(chatId);
    });
    this.queues.set(chatId, queue);
  }

  #recordUpdateFailure(error) {
    this.logger.record({ type: 'gateway_update_failed', code: error.code ?? 'internal_failure', outcome: 'failed' });
  }

  async #handle(update) {
    const callback = update?.callback_query;
    const message = update?.message ?? callback?.message;
    const actor = update?.message?.from ?? callback?.from;
    if (!message || !actor || !message.chat) return;
    const userId = String(actor.id);
    const chatId = String(message.chat.id);
    if (!this.config.authorized_user_ids.includes(userId)) {
      this.logger.record({ type: 'gateway_access_denied', reason_code: 'telegram_user_not_authorized', outcome: 'denied' });
      return;
    }
    if (callback) return this.#callback(callback, chatId, userId);
    if (typeof message.text !== 'string') return;
    const text = message.text.trim();
    if (!text) return;
    if (text === '/cancel') {
      const attached = await this.#attachedTarget(chatId);
      if (attached) {
        await this.sessionDirectory.cancel(attached);
        await this.api.sendMessage(chatId, `Cancellation requested for ${attached.alias}.`, this.controller.signal, attachedControls(attached.alias));
        return;
      }
      const session = this.sessions.get(chatId);
      if (session) await session.ingress.submit({ version: '1.0', type: 'cancel', request_id: newId('gateway_cancel') }, gatewayPrincipal(userId));
      await this.api.sendMessage(chatId, session ? 'Cancellation requested.' : 'No active turn.', this.controller.signal);
      return;
    }
    if (text === '/start' || text === '/help') {
      await this.api.sendMessage(chatId, 'NNA gateway ready. Send a request, use /sessions to attach to a Console conversation, /compact to reduce older context, /handoff for a terse continuation, /clear to start fresh, or /cancel to stop active work.', this.controller.signal);
      return;
    }
    if (text === '/sessions') return this.#showSessions(chatId);
    if (text === '/detach') return this.#detach(chatId);
    if (/^\/compact(?:@\w+)?$/iu.test(text)) return this.#compact(chatId);
    if (/^\/handoff(?:@\w+)?$/iu.test(text)) return this.#handoff(chatId);
    if (/^\/clear(?:@\w+)?$/iu.test(text)) return this.#requestClear(chatId);
    if (/^\/clear(?:@\w+)?\s+confirm$/iu.test(text)) return this.#confirmClear(chatId);
    if (/^\/clear(?:@\w+)?\s+cancel$/iu.test(text)) return this.#cancelClear(chatId);
    const attach = /^\/attach(?:\s+(.+))?$/u.exec(text);
    if (attach) return this.#attachFromText(chatId, attach[1]);
    const attached = await this.#attachedTarget(chatId);
    if (attached) {
      const result = await this.sessionDirectory.submit(attached, text);
      await this.api.sendMessage(chatId, result.text || turnFallback(result), this.controller.signal, attachedControls(attached.alias));
      return;
    }
    const session = await this.#session(chatId);
    const result = await session.ingress.submit({
      version: '1.0', type: 'submit', request_id: newId('gateway'), content: text,
    }, gatewayPrincipal(userId));
    const response = result.text || turnFallback(result);
    await this.api.sendMessage(chatId, response, this.controller.signal);
  }

  async #showSessions(chatId) {
    const catalog = await this.sessionDirectory.list();
    this.catalogs.set(chatId, catalog);
    if (catalog.length === 0) {
      await this.api.sendMessage(chatId, 'No active NNA Console conversations are available.', this.controller.signal);
      return;
    }
    const current = this.attachments.get(chatId)?.targetId;
    const lines = catalog.map((item, index) => `${index + 1}. ${item.alias}${item.targetId === current ? ' (attached)' : ''} - ${item.summary}`);
    const keyboard = catalog.slice(0, 20).map((item) => [{ text: `Attach ${item.alias}`, callback_data: `nna:a:${item.targetId}` }]);
    await this.api.sendMessage(chatId, `Active NNA conversations:\n\n${lines.join('\n')}\n\nUse /attach <number-or-name>.`, this.controller.signal, {
      replyMarkup: { inline_keyboard: keyboard },
    });
  }

  async #attachFromText(chatId, selector) {
    if (!selector?.trim()) return this.#showSessions(chatId);
    const catalog = await this.sessionDirectory.list();
    this.catalogs.set(chatId, catalog);
    const number = Number(selector);
    const target = Number.isSafeInteger(number) && number > 0 ? catalog[number - 1]
      : catalog.find((item) => item.alias.toLowerCase() === selector.trim().toLowerCase());
    if (!target) {
      await this.api.sendMessage(chatId, 'Conversation not found. Use /sessions to refresh the list.', this.controller.signal);
      return;
    }
    await this.#attach(chatId, target);
  }

  async #attach(chatId, target) {
    this.pendingClears.delete(chatId);
    this.attachments.set(chatId, { targetId: target.targetId, brokerId: target.brokerId, sessionId: target.id, alias: target.alias });
    await this.api.sendMessage(chatId, `Attached to ${target.alias}. Messages now continue that Console conversation.`, this.controller.signal, attachedControls(target.alias));
  }

  async #detach(chatId) {
    this.pendingClears.delete(chatId);
    const prior = this.attachments.get(chatId);
    this.attachments.delete(chatId);
    await this.api.sendMessage(chatId, prior
      ? `Detached from ${prior.alias}. The standalone Telegram conversation is active again.`
      : 'Telegram is already using its standalone conversation.', this.controller.signal);
  }

  async #callback(callback, chatId) {
    const data = String(callback.data ?? '');
    try {
      if (data === 'nna:d') await this.#detach(chatId);
      else if (data === 'nna:s') await this.#showSessions(chatId);
      else if (data === 'nna:clear:y') await this.#confirmClear(chatId);
      else if (data === 'nna:clear:n') await this.#cancelClear(chatId);
      else if (data.startsWith('nna:a:')) {
        const targetId = data.slice(6);
        const catalog = await this.sessionDirectory.list();
        const target = catalog.find((item) => item.targetId === targetId);
        if (!target) await this.api.sendMessage(chatId, 'That conversation is no longer available. Use /sessions to refresh.', this.controller.signal);
        else await this.#attach(chatId, target);
      }
    } finally { await this.api.answerCallbackQuery?.(callback.id, null, this.controller.signal); }
  }

  async #compact(chatId) {
    try {
      const attached = await this.#attachedTarget(chatId);
      const result = attached
        ? await this.sessionDirectory.compact(attached)
        : await (await this.#session(chatId)).engine.compactConversation();
      const reduced = result.reduced ? ` Reduced ${result.reduced} retained payloads.` : '';
      await this.api.sendMessage(chatId,
        `Context compacted. Omitted ${result.omitted} settled records and retained ${result.retained}.${reduced}`,
        this.controller.signal, attached ? attachedControls(attached.alias) : {});
      this.logger.record({ type: 'gateway_context_compacted', outcome: 'completed', attached: Boolean(attached) });
    } catch (error) { await this.#controlFailure(chatId, 'compact', error); }
  }

  async #handoff(chatId) {
    try {
      const attached = await this.#attachedTarget(chatId);
      const result = attached
        ? await this.sessionDirectory.handoff(attached)
        : await (await this.#session(chatId)).engine.handoffConversation();
      await this.api.sendMessage(chatId,
        `Terse self-handoff created from ${result.omitted} records. Future context starts from that handoff.`,
        this.controller.signal, attached ? attachedControls(attached.alias) : {});
      this.logger.record({ type: 'gateway_context_handoff', outcome: 'completed', attached: Boolean(attached) });
    } catch (error) { await this.#controlFailure(chatId, 'handoff', error); }
  }

  async #requestClear(chatId) {
    const attached = await this.#attachedTarget(chatId);
    this.pendingClears.set(chatId, {
      requestedAt: Date.now(), targetId: attached?.targetId ?? null,
      label: attached ? attached.alias : 'the standalone Telegram conversation',
    });
    await this.api.sendMessage(chatId,
      `Clear all context from ${attached ? attached.alias : 'this Telegram conversation'}? This cannot be undone.`,
      this.controller.signal, clearConfirmationControls());
  }

  async #confirmClear(chatId) {
    const pending = this.pendingClears.get(chatId);
    if (!pending || Date.now() - pending.requestedAt > 60_000) {
      this.pendingClears.delete(chatId);
      await this.api.sendMessage(chatId, 'Clear confirmation expired. Send /clear to try again.', this.controller.signal);
      return;
    }
    const attached = await this.#attachedTarget(chatId);
    if ((attached?.targetId ?? null) !== pending.targetId) {
      this.pendingClears.delete(chatId);
      await this.api.sendMessage(chatId, 'The active conversation changed, so nothing was cleared. Send /clear again.', this.controller.signal);
      return;
    }
    try {
      const result = attached
        ? await this.sessionDirectory.clear(attached)
        : await (await this.#session(chatId)).engine.clearConversation();
      this.pendingClears.delete(chatId);
      await this.api.sendMessage(chatId, `Conversation cleared. Removed ${result.removed} context records.`,
        this.controller.signal, attached ? attachedControls(attached.alias) : {});
      this.logger.record({ type: 'gateway_context_cleared', outcome: 'completed', attached: Boolean(attached) });
    } catch (error) { await this.#controlFailure(chatId, 'clear', error); }
  }

  async #cancelClear(chatId) {
    const existed = this.pendingClears.delete(chatId);
    await this.api.sendMessage(chatId, existed ? 'Clear cancelled.' : 'No clear confirmation is pending.', this.controller.signal);
  }

  async #controlFailure(chatId, operation, error) {
    const busy = ['compaction_busy', 'clear_busy'].includes(error.code);
    const message = busy ? `Cannot ${operation} while a turn is active. Wait for it to finish or use /cancel first.`
      : `Could not ${operation} this conversation (${error.code ?? 'context_control_failed'}).`;
    this.logger.record({ type: 'gateway_context_control_failed', operation, code: error.code ?? 'context_control_failed', outcome: 'failed' });
    await this.api.sendMessage(chatId, message, this.controller.signal);
  }

  async #attachedTarget(chatId) {
    const attachment = this.attachments.get(chatId);
    if (!attachment) return null;
    const catalog = await this.sessionDirectory.list();
    const target = catalog.find((item) => item.targetId === attachment.targetId);
    if (target) return target;
    this.attachments.delete(chatId);
    await this.api.sendMessage(chatId, `${attachment.alias} closed or became unavailable. Telegram returned to its standalone conversation.`, this.controller.signal);
    return null;
  }

  async #drainNotifications() {
    const items = await readTelegramOutbox(this.paths.telegramOutbox);
    if (items.length === 0) return;
    const catalog = await this.sessionDirectory.list();
    for (const item of items) {
      const source = catalog.find((target) => target.id === item.session_id);
      for (const chatId of this.config.authorized_user_ids) {
        const attached = this.attachments.get(String(chatId));
        const options = attached?.targetId === source?.targetId ? attachedControls(source.alias)
          : source ? { replyMarkup: { inline_keyboard: [[
            { text: `Attach ${source.alias}`, callback_data: `nna:a:${source.targetId}` },
            { text: 'Sessions', callback_data: 'nna:s' },
          ]] } } : {};
        await this.api.sendMessage(String(chatId), `NNA notification (${item.outcome}):\n${item.message}`, this.controller.signal, options);
      }
      await acknowledgeTelegramNotification(item);
      this.logger.record({ type: 'gateway_notification_delivered', outcome: 'completed', session_id: item.session_id });
    }
  }

  async #session(chatId) {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;
    const sessionId = gatewaySessionId(chatId);
    const output = async (record) => this.logger.record(record, { sessionId });
    const engine = this.engineFactory({
      ...this.engineOptions, config: this.engineConfig, sessionId, surface: 'telegram_gateway', output, scheduler: this.scheduler,
      storeRoot: this.paths.sessions, reviewerRoot: this.paths.reviewerLedger,
    });
    await engine.initialize();
    const session = { engine, ingress: new CanonicalIngress(engine) };
    this.sessions.set(chatId, session);
    return session;
  }
}

function attachedControls(alias) {
  return { replyMarkup: { inline_keyboard: [[
    { text: `Detach from ${String(alias).slice(0, 30)}`, callback_data: 'nna:d' },
    { text: 'Sessions', callback_data: 'nna:s' },
  ]] } };
}

function clearConfirmationControls() {
  return { replyMarkup: { inline_keyboard: [[
    { text: 'Clear conversation', callback_data: 'nna:clear:y' },
    { text: 'Keep conversation', callback_data: 'nna:clear:n' },
  ]] } };
}

export function gatewaySessionId(chatId) {
  return `telegram_${createHash('sha256').update(`telegram-chat:${chatId}`).digest('hex').slice(0, 32)}`;
}

function gatewayPrincipal(userId) { return `authenticated-telegram-user:${userId}`; }
function turnFallback(result) {
  if (result.outcome === 'needs_input') return 'I need more information to continue.';
  if (result.outcome === 'cancelled') return 'Turn cancelled.';
  return `Turn ${result.outcome ?? 'failed'}.`;
}
function delay(ms, signal) { return new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
}); }
async function loadOffset(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return Number.isSafeInteger(value.offset) && value.offset >= 0 ? value.offset : 0;
  } catch (error) { if (error.code === 'ENOENT') return 0; return 0; }
}
async function saveOffset(path, offset) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, offset })}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
