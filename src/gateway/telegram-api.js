// SPDX-License-Identifier: Apache-2.0
import { ContractError } from '../ids.js';

const TELEGRAM_LIMIT = 4096;
const DEFAULT_LONG_POLL_SECONDS = 30;
const LONG_POLL_GRACE_SECONDS = 10;
const EMPTY_MESSAGE_FALLBACK = '(NNA returned no text.)';
const MAX_RESPONSE_BYTES = 1_048_576;

export class TelegramApi {
  #baseUrl;

  constructor(token, options = {}) {
    if (!token) throw new ContractError('telegram_token_missing', 'Telegram bot token is not configured');
    this.#baseUrl = `https://api.telegram.org/bot${token}`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  getMe(signal) { return this.#call('getMe', {}, signal); }

  getUpdates(offset, timeout = DEFAULT_LONG_POLL_SECONDS, signal) {
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 50) {
      throw new ContractError('telegram_timeout_invalid', 'Telegram long-poll timeout must be an integer from 0 to 50 seconds');
    }
    return this.#call('getUpdates', {
      offset, timeout, limit: 20, allowed_updates: ['message', 'callback_query'],
    }, signal, (timeout + LONG_POLL_GRACE_SECONDS) * 1000);
  }

  async sendMessage(chatId, text, signal, options = {}) {
    const chunks = splitTelegramText(String(text));
    let sentChunks = 0;
    try {
      for (const [index, chunk] of chunks.entries()) {
        const body = { chat_id: chatId, text: chunk };
        if (index === chunks.length - 1 && options.replyMarkup) body.reply_markup = options.replyMarkup;
        await this.#call('sendMessage', body, signal);
        sentChunks += 1;
      }
    } catch (error) {
      error.sentChunks = sentChunks;
      error.totalChunks = chunks.length;
      throw error;
    }
    return { chunks: chunks.length };
  }

  answerCallbackQuery(id, text, signal) {
    return this.#call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }, signal);
  }

  async #call(method, body, outerSignal, timeoutMs = 30_000) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
    let response; let bytes;
    try {
      response = await this.fetch(`${this.#baseUrl}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      });
      bytes = await boundedResponseBody(response, signal);
    } catch (error) {
      if (error instanceof ContractError) throw error;
      if (outerSignal?.aborted) throw new ContractError('telegram_cancelled', `Telegram ${method} request was cancelled`);
      if (timeout.aborted || ['AbortError', 'TimeoutError'].includes(error?.name)) {
        throw new ContractError('telegram_timeout', `Telegram ${method} request timed out`);
      }
      // Fetch errors can embed the credential-bearing request URL in message, cause, and stack.
      throw new ContractError('telegram_unavailable', `Telegram ${method} request failed`);
    }
    let envelope;
    try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
      throw new ContractError('telegram_response_invalid', 'Telegram returned invalid JSON');
    }
    if (!response.ok || envelope.ok !== true) {
      const description = typeof envelope.description === 'string' ? envelope.description.slice(0, 256) : `HTTP ${response.status}`;
      throw new ContractError('telegram_api_error', `Telegram ${method}: ${description}`);
    }
    return envelope.result;
  }
}

async function boundedResponseBody(response, signal) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => undefined);
    throw new ContractError('telegram_response_too_large', 'Telegram response exceeded its size bound');
  }
  if (typeof response.body?.getReader !== 'function') {
    throw new ContractError('telegram_response_invalid', 'Telegram returned no readable response body');
  }
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await readWithSignal(reader, signal);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      length += chunk.length;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ContractError('telegram_response_too_large', 'Telegram response exceeded its size bound');
      }
      chunks.push(chunk);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function readWithSignal(reader, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const aborted = () => { reader.cancel().catch(() => undefined); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value); },
      (error) => { signal.removeEventListener('abort', aborted); reject(error); },
    );
  });
}

export function splitTelegramText(text, limit = TELEGRAM_LIMIT) {
  if (!text) return [EMPTY_MESSAGE_FALLBACK];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let split = rest.lastIndexOf('\n', limit);
    if (split < Math.floor(limit * 0.6)) split = rest.lastIndexOf(' ', limit);
    if (split < 1) split = limit;
    chunks.push(rest.slice(0, split));
    rest = rest.slice(split).replace(/^\s+/u, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
