// SPDX-License-Identifier: Apache-2.0
import { VERSION } from './product.js';
import { appendFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const SAFE_KEYS = new Set([
  'type', 'code', 'operation', 'outcome', 'status', 'reason_code', 'retryable',
  'session_id', 'request_id', 'turn_id', 'step_id', 'tool_request_id', 'provider_call_id',
  'attempt_id', 'logical_request_id',
  'decision_id', 'attachment_id', 'state', 'sequence', 'command_type',
  'configuration_key', 'configuration_source',
]);

export class StructuredLog {
  #records = [];
  #sequence = 0;
  #dropped = 0;
  #writes = Promise.resolve();

  constructor(options = {}) {
    if (typeof options === 'number') options = { limit: options };
    this.limit = options.limit ?? 4096;
    this.path = options.path ?? null;
    this.maxBytes = options.maxBytes ?? 4_194_304;
  }

  async initialize() {
    if (!this.path) return this;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const records = [...await readRecords(`${this.path}.1`, this.maxBytes), ...await readRecords(this.path, this.maxBytes)];
    this.#records = records.slice(-this.limit);
    this.#dropped = Math.max(0, records.length - this.#records.length);
    this.#sequence = this.#records.reduce((maximum, item) => Math.max(maximum, item.monotonic_sequence ?? 0), 0);
    return this;
  }

  record(event, context = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(event)) {
      if (SAFE_KEYS.has(key) && ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
    }
    const record = Object.freeze({
      timestamp: new Date().toISOString(), monotonic_sequence: ++this.#sequence,
      product_version: VERSION,
      severity: severity(event), category: category(event),
      code: event.code ?? event.reason_code ?? event.type ?? 'runtime_event',
      session_id: context.sessionId ?? event.session_id ?? null, ...safe,
    });
    if (this.#records.length >= this.limit) {
      this.#records.shift(); this.#dropped += 1;
    }
    this.#records.push(record);
    if (this.path) this.#writes = this.#writes.then(() => this.#append(record)).catch(() => { this.#dropped += 1; });
    return record;
  }

  async flush() {
    await this.#writes;
  }

  snapshot() {
    return Object.freeze({
      product: Object.freeze({ name: 'NotNativeAgent', version: VERSION }),
      records: Object.freeze([...this.#records]), dropped: this.#dropped,
    });
  }

  async #append(record) {
    const size = await stat(this.path).then((item) => item.size, (error) => error.code === 'ENOENT' ? 0 : Promise.reject(error));
    const line = `${JSON.stringify(record)}\n`;
    if (size + Buffer.byteLength(line) > this.maxBytes) {
      await unlink(`${this.path}.1`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await rename(this.path, `${this.path}.1`).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
    await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 });
  }
}

async function readRecords(path, maximum) {
  let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (bytes.length > maximum) bytes = bytes.subarray(bytes.length - maximum);
  return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && value.product_version ? [Object.freeze(value)] : [];
    } catch { return []; }
  });
}

function severity(event) {
  if (event.type === 'error' || event.outcome === 'failed') return 'error';
  if (event.status === 'degraded' || ['incomplete', 'needs_input'].includes(event.outcome)) return 'warning';
  return 'info';
}

function category(event) {
  if (event.type?.includes('tool') || event.type === 'review_status') return 'governance';
  if (event.type?.includes('mcp') || event.type?.includes('memory')) return 'dependency';
  if (event.type?.includes('turn') || event.type === 'stream_delta') return 'turn';
  return 'runtime';
}
