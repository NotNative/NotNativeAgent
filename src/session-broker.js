// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ContractError } from './ids.js';

const MAX_BODY = 262_144;
const MAX_RECORD_FILES = 1_024;
const MAX_RECENT_BROKERS = 128;
const RECORD_READ_CONCURRENCY = 32;
const MAX_RESPONSE_BYTES = 4_194_304;
const BROKER_TIMEOUT_MS = 10_000;

export class ConsoleSessionBroker {
  constructor(workspace, options = {}) {
    this.workspace = workspace;
    this.root = options.root;
    this.id = options.id ?? randomUUID().replaceAll('-', '').slice(0, 16);
    this.token = options.token ?? randomBytes(32).toString('base64url');
    this.server = options.server ?? createServer((request, response) => this.#handle(request, response));
    this.recordPath = join(this.root, `${this.id}.json`);
  }
  async start() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    await atomicJson(this.recordPath, {
      version: 1, broker_id: this.id, pid: process.pid, port: address.port,
      token: this.token, started_at: new Date().toISOString(),
    });
    return this;
  }
  async close() {
    await unlink(this.recordPath).catch(() => undefined);
    if (!this.server.listening) return;
    await new Promise((resolve) => this.server.close(resolve));
  }
  async #handle(request, response) {
    try {
      if (request.headers.authorization !== `Bearer ${this.token}`) return reply(response, 401, { code: 'broker_unauthorized' });
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/sessions') {
        return reply(response, 200, { sessions: this.workspace.brokerSessions() });
      }
      const match = /^\/sessions\/([^/]+)\/(submit|cancel|compact|handoff|clear)$/u.exec(url.pathname);
      if (request.method !== 'POST' || !match) return reply(response, 404, { code: 'broker_route_missing' });
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) {
        throw new ContractError('broker_content_type_invalid', 'session broker requests require application/json');
      }
      const sessionId = decodeURIComponent(match[1]);
      const body = await readJsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => key !== 'content')
        || (match[2] === 'submit' && typeof body.content !== 'string')
        || (match[2] !== 'submit' && Object.keys(body).length > 0)) {
        throw new ContractError('broker_request_invalid', 'session broker request has an invalid shape');
      }
      const operations = {
        submit: () => this.workspace.submitSession(sessionId, body.content),
        cancel: () => this.workspace.cancelSession(sessionId),
        compact: () => this.workspace.compactSession(sessionId),
        handoff: () => this.workspace.handoffSession(sessionId),
        clear: () => this.workspace.clearSession(sessionId),
      };
      const result = await operations[match[2]]();
      return reply(response, 200, { result });
    } catch (error) {
      return reply(response, error.code === 'session_missing' ? 404 : 400, {
        code: error.code ?? 'broker_request_failed', message: error.message,
      });
    }
  }
}

export class ConsoleSessionDirectory {
  constructor(root, options = {}) { this.root = root; this.fetch = options.fetch ?? globalThis.fetch; }
  async list() {
    let names;
    try { names = await readdir(this.root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const recordPaths = names.filter((name) => name.endsWith('.json')).slice(0, MAX_RECORD_FILES)
      .map((name) => join(this.root, name));
    const records = await mapBatches(recordPaths, RECORD_READ_CONCURRENCY,
      (path) => this.#read(path));
    const discovered = [];
    const recent = records.filter(Boolean)
      .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))
      .slice(0, MAX_RECENT_BROKERS);
    for (const item of recent) {
      try {
        const envelope = await this.#call(item, '/sessions', { method: 'GET' });
        for (const session of envelope.sessions ?? []) discovered.push({
          ...session, brokerId: item.broker_id, broker: item,
          targetId: createHash('sha256').update(`${item.broker_id}:${session.id}`).digest('hex').slice(0, 16),
        });
      } catch { if (!processExists(item.pid)) await unlink(item.path).catch(() => undefined); }
    }
    return uniqueAliases(discovered);
  }
  async submit(target, content) {
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > MAX_BODY) {
      throw new ContractError('broker_content_invalid', 'attached message is empty or too large');
    }
    const envelope = await this.#call(target.broker, `/sessions/${encodeURIComponent(target.id)}/submit`, {
      method: 'POST', body: JSON.stringify({ content }),
    });
    return envelope.result;
  }
  async cancel(target) {
    const envelope = await this.#call(target.broker, `/sessions/${encodeURIComponent(target.id)}/cancel`, {
      method: 'POST', body: '{}',
    });
    return envelope.result;
  }
  async compact(target) { return this.#control(target, 'compact'); }
  async handoff(target) { return this.#control(target, 'handoff'); }
  async clear(target) { return this.#control(target, 'clear'); }
  async #control(target, operation) {
    const envelope = await this.#call(target.broker, `/sessions/${encodeURIComponent(target.id)}/${operation}`, {
      method: 'POST', body: '{}',
    });
    return envelope.result;
  }
  async #read(path) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.token !== 'string') return null;
      return { ...value, path };
    } catch { return null; }
  }
  async #call(record, path, init) {
    const response = await this.fetch(`http://127.0.0.1:${record.port}${path}`, {
      ...init, headers: { authorization: `Bearer ${record.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(BROKER_TIMEOUT_MS),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) {
      throw new ContractError('broker_response_too_large', 'session broker response is too large');
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!response.ok) throw new ContractError(value.code ?? 'broker_unavailable', value.message ?? 'session broker rejected the request');
    return value;
  }
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function uniqueAliases(items) {
  const used = new Map();
  return items.map((item) => {
    const base = String(item.alias || 'Conversation').replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 24) || 'Conversation';
    const count = (used.get(base.toLowerCase()) ?? 0) + 1; used.set(base.toLowerCase(), count);
    return { ...item, alias: count === 1 ? base : `${base}${count}` };
  });
}
async function mapBatches(items, batchSize, operation) {
  const results = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    results.push(...await Promise.all(items.slice(offset, offset + batchSize).map(operation)));
  }
  return results;
}
async function readJsonBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) throw new ContractError('broker_request_too_large', 'session broker request is too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new ContractError('broker_json_invalid', 'session broker request is invalid JSON'); }
}
function reply(response, status, body) {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
