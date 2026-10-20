// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CanonicalIngress } from '../ingress.js';
import { SessionEngine } from '../engine.js';
import { newId } from '../ids.js';
import { StructuredLog } from '../structured-log.js';
import { FairScheduler } from '../provider/fair-scheduler.js';
import { ConsoleSessionDirectory } from '../session-broker.js';
import { acknowledgeTelegramNotification, readTelegramOutbox } from '../notifications/telegram.js';
import { persistAtomicJson } from '../persistence/atomic-json.js';
import { attachedSubmissionReply, turnFallback } from './attached-submission.js';
import { AttachedReplayState, gatewayStateBytes, loadGatewayState, MAX_GATEWAY_STATE_BYTES, retainedUpdateError } from './attached-replay.js';
import { gatewayCompactionMessage } from './compaction-notice.js';
import { attachedControls, clearConfirmationControls, pendingSubmissionUpdate } from './controls.js';
import { runGatewayContextAction } from './context-actions.js';
export { gatewayCompactionMessage } from './compaction-notice.js';

const MAX_PENDING_CHAT_UPDATES = 16; const MAX_PENDING_COMPACTION_NOTICES = 4; const MAX_DURABLE_UPDATES = 256;
const GATEWAY_HELP = 'NNA gateway ready. Send a request, use /sessions to attach to a Console conversation, /compact to reduce older context, /handoff for a terse continuation, /clear to start fresh, or /cancel to stop active work.';

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
    this.queues = new Map();
    this.compactionNotices = new Map();
    this.offset = 0;
    this.inbox = [];
    this.activeUpdates = new Set();
    this.updateOperations = new Set();
    this.stateWrites = Promise.resolve();
    this.running = false;
    this.controller = new AbortController();
    this.logger = options.logger ?? new StructuredLog({ path: join(this.paths.logs, 'gateway.ndjson') });
    this.scheduler = options.scheduler ?? new FairScheduler({
      limit: this.engineConfig.limits.providerConcurrency, maxQueued: this.engineConfig.limits.providerQueueLimit,
    });
    this.sessionDirectory = options.sessionDirectory ?? new ConsoleSessionDirectory(this.paths.sessionBrokers ?? join(this.paths.gateway, 'session-brokers'));
    this.replay = new AttachedReplayState({
      api: this.api, controller: this.controller, config: this.config, logger: this.logger,
      inbox: () => this.inbox, save: () => this.#saveState(), bytes: () => this.#stateBytes(),
      stop: () => { this.running = false; this.controller.abort(); },
      controls: (alias) => alias ? attachedControls(alias) : {},
    });
  }

  async initialize() {
    await mkdir(this.paths.gateway, { recursive: true, mode: 0o700 });
    await this.logger.initialize();
    this.statePath = join(this.paths.gateway, 'state.json');
    const state = await loadGatewayState(this.statePath);
    this.offset = state.offset;
    this.inbox = state.inbox;
    this.attachments = new Map(Object.entries(state.attachments));
    this.replay.load(state);
    const bot = await this.api.getMe(this.controller.signal);
    this.logger.record({ type: 'gateway_initialized', status: 'ready' });
    return { id: bot.id, username: bot.username ?? null };
  }

  async run() {
    const bot = await this.initialize();
    this.running = true;
    while (this.running && !this.controller.signal.aborted) {
      this.#dispatchPending();
      await this.replay.drain();
      let updates;
      try {
        updates = await this.api.getUpdates(this.offset, this.config.polling_timeout_seconds, this.controller.signal);
      } catch (error) {
        if (this.controller.signal.aborted) break;
        this.logger.record({ type: 'gateway_poll_failed', code: error.code ?? 'telegram_unavailable', outcome: 'failed' });
        await delay(1_000, this.controller.signal).catch(() => undefined);
        continue;
      }
      await this.#acceptUpdates(updates);
      this.#dispatchPending();
      await this.replay.drain();
      await this.#drainNotifications().catch((error) => this.logger.record({
        type: 'gateway_notification_failed', code: error.code ?? 'notification_delivery_failed', outcome: 'failed',
      }));
    }
    await this.shutdown();
    return bot;
  }

  async shutdown() {
    this.shutdownOperation ??= (async () => {
      this.running = false;
      this.controller.abort();
      await Promise.allSettled([...this.sessions.values()].map((item) => item.ingress.submit({
        version: '1.0', type: 'cancel', request_id: newId('gateway_shutdown_cancel'),
      }, 'authenticated-gateway-runtime')));
      await Promise.allSettled([...this.queues.values()].map((item) => item.operation));
      await Promise.allSettled([...this.updateOperations]);
      await Promise.allSettled([...this.compactionNotices.values()].map((item) => item.tail));
      await this.stateWrites;
      await Promise.allSettled([...this.sessions.values()].map((item) => item.engine.shutdown({
        version: '1.0', type: 'shutdown', request_id: newId('gateway_shutdown'),
      })));
      this.sessions.clear();
      this.attachments.clear();
      this.pendingClears.clear();
      this.queues.clear();
      this.compactionNotices.clear();
      this.logger.record({ type: 'gateway_stopped', status: 'completed' });
      await this.logger.flush();
    })();
    return this.shutdownOperation;
  }

  #dispatch(update) {
    const updateId = Number(update?.update_id);
    if (!Number.isSafeInteger(updateId) || this.activeUpdates.has(updateId)) return false;
    const message = update?.message ?? update?.callback_query?.message;
    const chatId = message?.chat ? String(message.chat.id) : null;
    if (!chatId || message?.text?.trim() === '/cancel') {
      this.activeUpdates.add(updateId);
      this.#track(this.#handle(update).then(() => this.#settleUpdate(updateId),
        (error) => this.#failUpdate(updateId, error)));
      return true;
    }
    const queue = this.queues.get(chatId) ?? { operation: Promise.resolve(), pending: 0 };
    if (queue.pending >= MAX_PENDING_CHAT_UPDATES) {
      this.logger.record({ type: 'gateway_queue_full', code: 'gateway_chat_queue_full', outcome: 'failed' });
      return false;
    }
    this.activeUpdates.add(updateId);
    queue.pending += 1;
    queue.operation = queue.operation.then(() => this.#handle(update)).then(() => this.#settleUpdate(updateId),
      (error) => this.#failUpdate(updateId, error)).finally(() => {
      queue.pending -= 1;
      if (queue.pending === 0) this.queues.delete(chatId);
    });
    this.queues.set(chatId, queue);
    this.#track(queue.operation);
    return true;
  }

  #dispatchPending() { for (const update of this.inbox) this.#dispatch(update); }

  async #acceptUpdates(updates) {
    const known = new Set(this.inbox.map((item) => Number(item.update_id)));
    for (const update of updates) {
      const updateId = Number(update?.update_id);
      if (!Number.isSafeInteger(updateId) || updateId < this.offset) continue;
      if (this.inbox.length >= MAX_DURABLE_UPDATES) break;
      if (!known.has(updateId)) {
        const candidate = [...this.inbox, update];
        if (this.#stateBytes({ offset: updateId + 1, inbox: candidate }) > MAX_GATEWAY_STATE_BYTES) break;
        this.inbox = candidate; known.add(updateId);
      }
      this.offset = updateId + 1;
    }
    await this.#saveState();
  }

  async #ackUpdate(updateId) {
    const prior = this.inbox;
    this.inbox = prior.filter((item) => Number(item.update_id) !== updateId);
    const route = this.replay.routes[updateId];
    const operation = this.replay.operations[updateId];
    const suppressedBy = this.replay.suppressed[updateId];
    delete this.replay.routes[updateId];
    delete this.replay.operations[updateId];
    delete this.replay.suppressed[updateId];
    try { await this.#saveState(); }
    catch (error) { this.inbox = prior; if (route) this.replay.routes[updateId] = route;
      if (operation) this.replay.operations[updateId] = operation;
      if (suppressedBy) this.replay.suppressed[updateId] = suppressedBy; throw error; }
    this.activeUpdates.delete(updateId);
    if (this.running) this.#dispatchPending();
    await this.replay.drain();
  }

  async #settleUpdate(updateId) {
    try { await this.#ackUpdate(updateId); }
    catch (error) {
      this.logger.record({ type: 'gateway_state_failed', code: error.code ?? 'gateway_state_write_failed', outcome: 'failed' });
      this.running = false; this.controller.abort();
    }
  }

  #saveState() {
    this.stateWrites = this.stateWrites.then(() => persistAtomicJson(this.statePath, {
      version: 4, offset: this.offset, inbox: this.inbox, attachments: Object.fromEntries(this.attachments),
      routes: this.replay.routes, replies: this.replay.replies, operations: this.replay.operations,
      suppressed: this.replay.suppressed,
    }));
    return this.stateWrites;
  }

  #stateBytes(overrides = {}) {
    return gatewayStateBytes({ version: 4, offset: this.offset, inbox: this.inbox,
      attachments: Object.fromEntries(this.attachments),
      routes: this.replay.routes, replies: this.replay.replies, operations: this.replay.operations,
      suppressed: this.replay.suppressed, ...overrides });
  }
  async #failUpdate(updateId, error) {
    this.#recordUpdateFailure(error);
    if (error.retainUpdate || this.replay.operations[updateId]
      && !this.replay.replies.some((item) => item.updateId === updateId)) {
      this.activeUpdates.delete(updateId);
      this.running = false; this.controller.abort();
      return;
    }
    await this.#settleUpdate(updateId);
  }

  #track(operation) {
    this.updateOperations.add(operation);
    operation.then(() => this.updateOperations.delete(operation), () => this.updateOperations.delete(operation));
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
    const updateId = Number(update.update_id);
    if (!this.config.authorized_user_ids.includes(userId)) {
      this.logger.record({ type: 'gateway_access_denied', reason_code: 'telegram_user_not_authorized', outcome: 'denied' });
      return;
    }
    if (this.replay.replies.some((item) => item.updateId === updateId)) return;
    if (this.replay.suppressed[updateId]) return this.#suppressUpdate(updateId, chatId, userId);
    const uncertain = this.replay.operations[updateId];
    if (uncertain) {
      await this.replay.queueReply(updateId, chatId, userId,
        `NNA could not confirm whether ${uncertain.action} took effect. Inspect the original conversation before retrying.`, '');
      return;
    }
    const receipt = { updateId, userId };
    if (callback) return this.#callback(callback, chatId, receipt);
    if (typeof message.text !== 'string') return;
    const text = message.text.trim();
    if (!text) return;
    if (text === '/cancel') return this.#contextAction('cancel', chatId, receipt);
    if (text === '/start' || text === '/help') {
      await this.api.sendMessage(chatId, GATEWAY_HELP, this.controller.signal);
      return;
    }
    if (text === '/sessions') return this.#showSessions(chatId);
    if (text === '/detach') return this.#detach(chatId, receipt);
    if (/^\/compact(?:@\w+)?$/iu.test(text)) return this.#compact(chatId, receipt);
    if (/^\/handoff(?:@\w+)?$/iu.test(text)) return this.#handoff(chatId, receipt);
    if (/^\/clear(?:@\w+)?$/iu.test(text)) return this.#requestClear(chatId);
    if (/^\/clear(?:@\w+)?\s+confirm$/iu.test(text)) return this.#confirmClear(chatId, receipt);
    if (/^\/clear(?:@\w+)?\s+cancel$/iu.test(text)) return this.#cancelClear(chatId);
    const attach = /^\/attach(?:\s+(.+))?$/u.exec(text);
    if (attach) return this.#attachFromText(chatId, attach[1], receipt);
    const attachment = this.attachments.get(chatId);
    const route = this.replay.routes[updateId] ?? (attachment ? await this.replay.pinRoute(updateId, attachment) : null);
    if (route) {
      // Invariant: a replay either reaches its original Console target or reports that target unavailable.
      const attached = (await this.sessionDirectory.list()).find((item) => item.targetId === route.targetId);
      if (this.replay.suppressed[updateId]) return this.#suppressUpdate(updateId, chatId, userId);
      const reply = attached
        ? await attachedSubmissionReply(this.sessionDirectory, attached, text, update.update_id)
        : `The attached conversation ${route.alias} is no longer available. This message was not sent elsewhere.`;
      await this.replay.queueReply(updateId, chatId, userId, reply, route.alias);
      return;
    }
    const session = await this.#session(chatId);
    if (this.replay.suppressed[updateId]) return this.#suppressUpdate(updateId, chatId, userId);
    const result = await session.ingress.submit({
      version: '1.0', type: 'submit', request_id: `gateway_update_${update.update_id}`, content: text,
    }, gatewayPrincipal(userId));
    const response = result.text || turnFallback(result);
    await this.replay.queueReply(updateId, chatId, userId, response, '');
  }

  async #showSessions(chatId) {
    const catalog = await this.sessionDirectory.list();
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

  async #attachFromText(chatId, selector, receipt) {
    if (!selector?.trim()) return this.#showSessions(chatId);
    const catalog = await this.sessionDirectory.list();
    const number = Number(selector);
    const target = Number.isSafeInteger(number) && number > 0 ? catalog[number - 1]
      : catalog.find((item) => item.alias.toLowerCase() === selector.trim().toLowerCase());
    if (!target) {
      await this.api.sendMessage(chatId, 'Conversation not found. Use /sessions to refresh the list.', this.controller.signal);
      return;
    }
    await this.#attach(chatId, target, receipt);
  }

  async #attach(chatId, target, receipt) {
    this.pendingClears.delete(chatId);
    await this.replay.beginControl(receipt.updateId, 'attach', target.targetId);
    const prior = this.attachments.get(chatId);
    this.attachments.set(chatId, { targetId: target.targetId, brokerId: target.brokerId, sessionId: target.id, alias: target.alias });
    if (this.#stateBytes() > MAX_GATEWAY_STATE_BYTES) {
      if (prior) this.attachments.set(chatId, prior); else this.attachments.delete(chatId);
      throw retainedUpdateError('gateway_state_full');
    }
    try { await this.#saveState(); }
    catch { if (prior) this.attachments.set(chatId, prior); else this.attachments.delete(chatId); throw retainedUpdateError('gateway_state_write_failed'); }
    await this.replay.queueReply(receipt.updateId, chatId, receipt.userId,
      `Attached to ${target.alias}. Messages now continue that Console conversation.`, target.alias);
  }

  async #detach(chatId, receipt) {
    this.pendingClears.delete(chatId);
    const prior = this.attachments.get(chatId);
    await this.replay.beginControl(receipt.updateId, 'detach', prior?.targetId ?? null);
    this.attachments.delete(chatId);
    try { await this.#saveState(); }
    catch { if (prior) this.attachments.set(chatId, prior); throw retainedUpdateError('gateway_state_write_failed'); }
    await this.replay.queueReply(receipt.updateId, chatId, receipt.userId, prior
      ? `Detached from ${prior.alias}. The standalone Telegram conversation is active again.`
      : 'Telegram is already using its standalone conversation.', '');
  }

  async #callback(callback, chatId, receipt) {
    const data = String(callback.data ?? '');
    try {
      if (data === 'nna:d') await this.#detach(chatId, receipt);
      else if (data === 'nna:s') await this.#showSessions(chatId);
      else if (data === 'nna:clear:y') await this.#confirmClear(chatId, receipt);
      else if (data === 'nna:clear:n') await this.#cancelClear(chatId);
      else if (data.startsWith('nna:a:')) {
        const targetId = data.slice(6);
        const catalog = await this.sessionDirectory.list();
        const target = catalog.find((item) => item.targetId === targetId);
        if (!target) await this.api.sendMessage(chatId, 'That conversation is no longer available. Use /sessions to refresh.', this.controller.signal);
        else await this.#attach(chatId, target, receipt);
      }
    } finally {
      try { await this.api.answerCallbackQuery?.(callback.id, null, this.controller.signal); }
      catch (error) { this.logger.record({ type: 'gateway_callback_ack_failed',
        code: error?.code ?? 'telegram_unavailable', outcome: 'failed' }); }
    }
  }

  async #contextAction(action, chatId, receipt) {
    const selection = this.attachments.get(chatId);
    const expectedTurnId = action === 'cancel' && !selection
      ? this.sessions.get(chatId)?.engine.active?.turnId ?? null : null;
    const pending = action === 'cancel' ? this.inbox
      .filter((item) => pendingSubmissionUpdate(item, chatId, receipt.updateId)).map((item) => item.update_id) : [];
    if (action === 'cancel') await this.replay.beginControl(receipt.updateId, action, selection?.targetId ?? null, pending);
    return runGatewayContextAction({ action, chatId, ...receipt, replay: this.replay,
      prestarted: action === 'cancel',
      selection, directory: this.sessionDirectory, fenceRequestIds: pending.map((id) => `gateway_update_${id}`),
      standalone: async () => action === 'cancel' ? expectedTurnId
        ? this.sessions.get(chatId)?.ingress.submit({ version: '1.0', type: 'cancel',
          request_id: `gateway_cancel_${receipt.updateId}`, expected_turn_id: expectedTurnId },
        gatewayPrincipal(receipt.userId)) ?? { accepted: true, already_terminal: true }
        : { accepted: true, already_terminal: true }
        : (await this.#session(chatId)).engine, logger: this.logger });
  }
  #suppressUpdate(updateId, chatId, userId) {
    return this.replay.queueReply(updateId, chatId, userId, 'Message cancelled before starting.', '');
  }
  async #compact(chatId, receipt) { return this.#contextAction('compact', chatId, receipt); }
  async #handoff(chatId, receipt) { return this.#contextAction('handoff', chatId, receipt); }

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

  async #confirmClear(chatId, receipt) {
    const pending = this.pendingClears.get(chatId);
    if (!pending || Date.now() - pending.requestedAt > 60_000) {
      this.pendingClears.delete(chatId);
      await this.api.sendMessage(chatId, 'Clear confirmation expired. Send /clear to try again.', this.controller.signal);
      return;
    }
    if ((this.attachments.get(chatId)?.targetId ?? null) !== pending.targetId) {
      this.pendingClears.delete(chatId);
      await this.api.sendMessage(chatId, 'The active conversation changed, so nothing was cleared. Send /clear again.', this.controller.signal);
      return;
    }
    this.pendingClears.delete(chatId);
    await this.#contextAction('clear', chatId, receipt);
  }

  async #cancelClear(chatId) {
    const existed = this.pendingClears.delete(chatId);
    await this.api.sendMessage(chatId, existed ? 'Clear cancelled.' : 'No clear confirmation is pending.', this.controller.signal);
  }

  async #attachedTarget(chatId) {
    const attachment = this.attachments.get(chatId);
    if (!attachment) return null;
    const catalog = await this.sessionDirectory.list();
    const target = catalog.find((item) => item.targetId === attachment.targetId);
    if (target) return target;
    this.attachments.delete(chatId);
    await this.#saveState();
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
    const output = async (record) => {
      this.logger.record(record, { sessionId });
      const message = gatewayCompactionMessage(record);
      if (message) this.#queueCompactionNotice(chatId, sessionId, message);
    };
    const engine = this.engineFactory({
      ...this.engineOptions, config: this.engineConfig, sessionId, surface: 'telegram_gateway', output, scheduler: this.scheduler,
      storeRoot: this.paths.sessions, reviewerRoot: this.paths.reviewerLedger,
    });
    await engine.initialize();
    const session = { engine, ingress: new CanonicalIngress(engine) };
    this.sessions.set(chatId, session);
    return session;
  }

  #queueCompactionNotice(chatId, sessionId, message) {
    const pending = this.compactionNotices.get(chatId) ?? { tail: Promise.resolve(), count: 0 };
    if (pending.count >= MAX_PENDING_COMPACTION_NOTICES) {
      this.logger.record({ type: 'gateway_compaction_notice_dropped', reason_code: 'notice_queue_full', session_id: sessionId });
      return;
    }
    pending.count += 1;
    // Why: a slow Telegram request cannot hold the engine's compaction lifecycle open.
    pending.tail = pending.tail.then(() => this.api.sendMessage(chatId, message, this.controller.signal))
      .catch((error) => this.logger.record({ type: 'gateway_compaction_notice_failed',
        reason_code: error?.code ?? 'gateway_send_failed', session_id: sessionId }))
      .finally(() => {
        pending.count -= 1;
        if (pending.count === 0 && this.compactionNotices.get(chatId) === pending) this.compactionNotices.delete(chatId);
      });
    this.compactionNotices.set(chatId, pending);
  }
}

export function gatewaySessionId(chatId) {
  return `telegram_${createHash('sha256').update(`telegram-chat:${chatId}`).digest('hex').slice(0, 32)}`;
}

function gatewayPrincipal(userId) { return `authenticated-telegram-user:${userId}`; }
function delay(ms, signal) { return new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
}); }
