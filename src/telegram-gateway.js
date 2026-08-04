// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CanonicalIngress } from './ingress.js';
import { SessionEngine } from './engine.js';
import { newId } from './ids.js';
import { StructuredLog } from './structured-log.js';
import { FairScheduler } from './fair-scheduler.js';

export class TelegramGateway {
  constructor(options) {
    this.api = options.api;
    this.config = options.config;
    this.engineConfig = options.engineConfig;
    this.paths = options.paths;
    this.engineOptions = options.engineOptions ?? {};
    this.engineFactory = options.engineFactory ?? ((engineOptions) => new SessionEngine(engineOptions));
    this.sessions = new Map();
    this.queues = new Map();
    this.offset = 0;
    this.running = false;
    this.controller = new AbortController();
    this.logger = options.logger ?? new StructuredLog({ path: join(this.paths.logs, 'gateway.ndjson') });
    this.scheduler = options.scheduler ?? new FairScheduler({
      limit: this.engineConfig.limits.providerConcurrency, maxQueued: this.engineConfig.limits.providerQueueLimit,
    });
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
    const message = update?.message;
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
    const message = update?.message;
    if (!message || typeof message.text !== 'string' || !message.from || !message.chat) return;
    const userId = String(message.from.id);
    const chatId = String(message.chat.id);
    if (!this.config.authorized_user_ids.includes(userId)) {
      this.logger.record({ type: 'gateway_access_denied', reason_code: 'telegram_user_not_authorized', outcome: 'denied' });
      return;
    }
    const text = message.text.trim();
    if (!text) return;
    if (text === '/cancel') {
      const session = this.sessions.get(chatId);
      if (session) await session.ingress.submit({ version: '1.0', type: 'cancel', request_id: newId('gateway_cancel') }, gatewayPrincipal(userId));
      await this.api.sendMessage(chatId, session ? 'Cancellation requested.' : 'No active turn.', this.controller.signal);
      return;
    }
    if (text === '/start' || text === '/help') {
      await this.api.sendMessage(chatId, 'NNA gateway ready. Send a request, or use /cancel to stop active work.', this.controller.signal);
      return;
    }
    const session = await this.#session(chatId);
    const result = await session.ingress.submit({
      version: '1.0', type: 'submit', request_id: newId('gateway'), content: text,
    }, gatewayPrincipal(userId));
    const response = result.text || turnFallback(result);
    await this.api.sendMessage(chatId, response, this.controller.signal);
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
