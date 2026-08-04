// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';

const TELEGRAM_LIMIT = 4096;

export class TelegramApi {
  constructor(token, options = {}) {
    if (!token) throw new ContractError('telegram_token_missing', 'Telegram bot token is not configured');
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  getMe(signal) { return this.#call('getMe', {}, signal); }

  getUpdates(offset, timeout, signal) {
    return this.#call('getUpdates', {
      offset, timeout, limit: 20, allowed_updates: ['message'],
    }, signal, (timeout + 10) * 1000);
  }

  async sendMessage(chatId, text, signal) {
    const chunks = splitTelegramText(String(text));
    for (const chunk of chunks) await this.#call('sendMessage', { chat_id: chatId, text: chunk }, signal);
    return { chunks: chunks.length };
  }

  async #call(method, body, outerSignal, timeoutMs = 30_000) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      });
    } catch (error) {
      throw new ContractError('telegram_unavailable', `Telegram ${method} request failed`, { cause: error });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 1_048_576) throw new ContractError('telegram_response_too_large', 'Telegram response exceeded its size bound');
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

export function splitTelegramText(text, limit = TELEGRAM_LIMIT) {
  if (!text) return ['(NNA returned no text.)'];
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
