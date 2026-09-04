// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { ContractError } from './ids.js';
import { VERSION } from './product.js';
import { CredentialResolver, normalizeCredentialBinding } from './credential-bindings.js';

export const MCP_CURRENT_VERSION = '2026-07-28';
const MAX_MCP_MESSAGE_BYTES = 2_097_152;
const MAX_MCP_DIAGNOSTIC_CHARS = 4_096;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 250;
const FORCE_KILL_TIMEOUT_MS = 500;

export class StdioMcpTransport {
  #nextId = 1;
  #pending = new Map();
  #buffer = '';
  #closed = false;

  constructor(config, spawnProcess = spawn, onDiagnostic = null, options = {}) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : null;
    this.protocolVersion = config.protocolVersion ?? MCP_CURRENT_VERSION;
    this.credentialResolver = options.credentialResolver ?? new CredentialResolver();
    this.sessionId = options.sessionId;
    this.credential = normalizeCredentialBinding(config.credential, config.credentialEnv);
  }

  async open() {
    if (this.#closed) throw new ContractError('mcp_closed', 'MCP transport is closed');
    await this.credentialResolver.withCredential(this.credential, this.#credentialContext('Launch MCP process'), async (secret) => {
      const target = this.config.credentialTarget
        ?? (this.credential?.source === 'environment' ? this.credential.name : null);
      const environment = minimalEnvironment(this.config.headerEnv);
      if (secret && target) environment[target] = secret;
      this.child = this.spawnProcess(this.config.command, this.config.args, {
        cwd: this.config.cwd, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'], env: environment,
      });
    });
    this.child.on('error', (error) => this.#failAll(error, true));
    this.child.on('exit', () => this.#failAll(new ContractError('mcp_closed', 'MCP subprocess closed'), true));
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream?.on?.('error', (error) => this.#protocolFailure(error));
    }
    if (!this.child.stdin || !this.child.stdout || !this.child.stderr) {
      const error = new ContractError('mcp_closed', 'MCP subprocess did not provide the required pipes');
      this.#protocolFailure(error);
      throw error;
    }
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#consume(chunk));
    this.child.stderr.setEncoding?.('utf8');
    this.child.stderr.on('data', (chunk) => this.onDiagnostic?.({
      type: 'stderr', text: String(chunk).slice(0, MAX_MCP_DIAGNOSTIC_CHARS),
    }));
  }

  #credentialContext(purpose) {
    return {
      consumer: `mcp:${this.config.id}`, destination: this.config.command, purpose,
      authorityRef: `mcp-configuration:${this.config.id}`, sessionId: this.sessionId,
    };
  }

  request(method, params = {}, signal) {
    if (signal?.aborted) return Promise.reject(new ContractError('mcp_cancelled', 'MCP request was cancelled'));
    if (this.#closed || !this.child || this.child.exitCode !== null || !this.child.stdin?.writable) {
      return Promise.reject(new ContractError('mcp_closed', 'MCP subprocess is unavailable', true));
    }
    const id = this.#nextId++;
    const message = withMetadata({ jsonrpc: '2.0', id, method, params }, this.protocolVersion);
    return new Promise((resolve, reject) => {
      const cancel = () => {
        if (!this.#pending.delete(id)) return;
        signal?.removeEventListener('abort', cancel);
        this.notify('notifications/cancelled', { requestId: id, reason: 'client cancellation' });
        reject(new ContractError('mcp_cancelled', 'MCP request was cancelled'));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.#pending.set(id, { resolve, reject, cancel, signal });
      this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (error) => {
        if (error) this.#settle(id, error);
      });
    });
  }

  notify(method, params = {}) {
    if (this.#closed || !this.child?.stdin?.writable) return false;
    const message = withMetadata({ jsonrpc: '2.0', method, params }, this.protocolVersion);
    this.child?.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
    return true;
  }

  onNotification(handler) { this.notificationHandler = handler; }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new ContractError('mcp_closed', 'MCP transport closed'));
    this.child?.stdin.end();
    if (!this.child || await waitForExit(this.child, GRACEFUL_SHUTDOWN_TIMEOUT_MS)) return;
    this.child.kill('SIGTERM');
    if (await waitForExit(this.child, FORCE_KILL_TIMEOUT_MS)) return;
    this.child.kill('SIGKILL');
  }

  #consume(chunk) {
    let offset = 0;
    let newline = chunk.indexOf('\n', offset);
    while (newline >= 0) {
      const segment = chunk.slice(offset, newline);
      const segmentBytes = Buffer.byteLength(segment, 'utf8');
      const bufferedBytes = Buffer.byteLength(this.#buffer, 'utf8');
      if (segmentBytes > MAX_MCP_MESSAGE_BYTES || bufferedBytes > MAX_MCP_MESSAGE_BYTES - segmentBytes) {
        this.#protocolFailure(new ContractError('mcp_output_too_large', 'MCP output exceeded bound'));
        return;
      }
      const line = this.#buffer + segment;
      this.#buffer = '';
      if (line.trim()) this.#message(line);
      if (this.#closed) return;
      offset = newline + 1;
      newline = chunk.indexOf('\n', offset);
    }
    const tail = chunk.slice(offset);
    const tailBytes = Buffer.byteLength(tail, 'utf8');
    const bufferedBytes = Buffer.byteLength(this.#buffer, 'utf8');
    if (tailBytes > MAX_MCP_MESSAGE_BYTES || bufferedBytes > MAX_MCP_MESSAGE_BYTES - tailBytes) {
      this.#protocolFailure(new ContractError('mcp_output_too_large', 'MCP output exceeded bound'));
      return;
    }
    this.#buffer += tail;
  }

  #message(line) {
    let value;
    try { value = JSON.parse(line); } catch {
      this.#protocolFailure(new ContractError('mcp_malformed', 'MCP emitted malformed JSON'));
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || (!Object.hasOwn(value, 'id') && typeof value.method !== 'string')) {
      this.#protocolFailure(new ContractError('mcp_malformed', 'MCP emitted an invalid message'));
      return;
    }
    const pending = this.#pending.get(value.id);
    if (!pending && typeof value.method === 'string') {
      // The notification owner records capability-refresh failure; transport stays isolated.
      Promise.resolve(this.notificationHandler?.(value)).catch(() => undefined);
      return;
    }
    if (!pending) {
      this.onDiagnostic?.({ type: 'unmatched_response', id: value.id ?? null });
      return;
    }
    this.#settle(value.id, value.error
      ? new ContractError('mcp_remote_error', 'MCP server returned an error')
      : null, value.result);
  }

  #protocolFailure(error) {
    if (this.#closed) return;
    this.#buffer = '';
    this.#failAll(error, true);
    this.child?.stdin?.end();
    this.child?.kill('SIGTERM');
  }

  #settle(id, error, result) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.signal?.removeEventListener('abort', pending.cancel);
    if (error) pending.reject(error);
    else pending.resolve(result);
  }

  #failAll(error, close = false) {
    if (close) this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.signal?.removeEventListener('abort', pending.cancel);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export class HttpMcpTransport {
  constructor(config, options = {}) {
    this.config = config;
    this.protocolVersion = config.protocolVersion ?? MCP_CURRENT_VERSION;
    this.credentialResolver = options.credentialResolver ?? new CredentialResolver();
    this.consoleSessionId = options.sessionId;
    this.credential = normalizeCredentialBinding(config.credential, config.credentialEnv);
  }

  async open() {}

  async request(method, params = {}, signal) {
    const message = withMetadata({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }, this.protocolVersion);
    const response = await this.#fetch({ method: 'POST', signal, body: JSON.stringify(message) }, method, params);
    try {
    if (!response.ok) throw new ContractError('mcp_http_error', `MCP HTTP request failed (${response.status})`, response.status >= 500);
    // The current protocol is deliberately stateless; legacy negotiated versions
    // may still establish a server-owned session that must be echoed and closed.
    if (this.protocolVersion !== MCP_CURRENT_VERSION) {
      this.sessionId ??= response.headers.get('mcp-session-id');
    }
    const value = response.headers.get('content-type')?.includes('text/event-stream')
      ? await readSseResult(response) : parseJson(await readBounded(response));
    if (!value || typeof value !== 'object') throw new ContractError('mcp_malformed', 'MCP response was malformed');
    if (value.error) throw new ContractError('mcp_remote_error', 'MCP server returned an error');
    return value.result;
    } catch (error) {
      if (signal?.aborted) throw new ContractError('mcp_cancelled', 'MCP request was cancelled');
      throw error;
    } finally { await cancelBody(response); }
  }

  async close(signal) {
    if (!this.sessionId) return;
    try {
      const response = await this.#fetch({ method: 'DELETE', signal }, 'session/close', {});
      await cancelBody(response);
      if (!response.ok) {
        throw new ContractError('mcp_http_close_error', `MCP HTTP session close failed (${response.status})`, response.status >= 500);
      }
    } finally {
      this.sessionId = null;
    }
  }

  async notify(method, params = {}, signal) {
    const message = withMetadata({ jsonrpc: '2.0', method, params }, this.protocolVersion);
    const response = await this.#fetch({ method: 'POST', signal, body: JSON.stringify(message) }, method, params);
    try {
    if (!response.ok) throw new ContractError('mcp_http_error', `MCP HTTP notification failed (${response.status})`);
    if (response.body) await readBounded(response);
    } catch (error) {
      if (signal?.aborted) throw new ContractError('mcp_cancelled', 'MCP notification was cancelled');
      throw error;
    } finally { await cancelBody(response); }
  }

  async #fetch(init, method, params) {
    if (init.signal?.aborted) throw new ContractError('mcp_cancelled', 'MCP request was cancelled');
    try {
    return await this.credentialResolver.withCredential(this.credential, {
      consumer: `mcp:${this.config.id}`, destination: this.config.endpoint,
      purpose: `Authenticate MCP ${method}`, authorityRef: `mcp-configuration:${this.config.id}`,
      sessionId: this.consoleSessionId,
    }, (secret) => this.#withHeaderCredentials(Object.entries(this.config.headerCredentials ?? {}), 0, {}, method,
      (credentialHeaders) => fetch(this.config.endpoint, {
        ...init, headers: this.#headers(method, params, secret, credentialHeaders),
      })));
    } catch (error) {
      if (init.signal?.aborted) throw new ContractError('mcp_cancelled', 'MCP request was cancelled');
      throw error;
    }
  }

  #withHeaderCredentials(entries, index, values, method, consumer) {
    if (index >= entries.length) return consumer(values);
    const [header, binding] = entries[index];
    return this.credentialResolver.withCredential(binding, {
      consumer: `mcp:${this.config.id}`, destination: this.config.endpoint,
      purpose: `Supply MCP ${header} header for ${method}`, authorityRef: `mcp-configuration:${this.config.id}`,
      sessionId: this.consoleSessionId,
    }, (secret) => this.#withHeaderCredentials(entries, index + 1, { ...values, [header]: secret }, method, consumer));
  }

  #headers(method, params, credential, credentialHeaders = {}) {
    const headers = {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      'mcp-protocol-version': this.protocolVersion, 'mcp-method': method,
    };
    if (['tools/call', 'resources/read', 'prompts/get'].includes(method)) {
      headers['mcp-name'] = String(params.name ?? params.uri);
    }
    if (credential) headers.authorization = `Bearer ${credential}`;
    for (const [header, environmentName] of Object.entries(this.config.headerEnv ?? {})) {
      const secret = process.env[environmentName];
      if (!secret) throw new ContractError('missing_credential', `configured MCP header credential ${environmentName} is unavailable`);
      headers[header] = secret;
    }
    Object.assign(headers, credentialHeaders);
    if (this.sessionId && this.protocolVersion !== MCP_CURRENT_VERSION) {
      headers['mcp-session-id'] = this.sessionId;
    }
    return headers;
  }
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* Invariant: cleanup must not replace the transport failure. */ }
}

function withMetadata(message, protocolVersion) {
  message.params ??= {};
  message.params._meta = {
    ...(message.params._meta ?? {}),
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': { name: 'NotNativeAgent', version: VERSION },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  return message;
}

async function readSseResult(response) {
  const text = await readBounded(response);
  const messages = text.split(/\r?\n\r?\n/u).map((event) => event.split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart()).join('\n').trim())
    .filter(Boolean).map(parseJson);
  const responseMessage = messages.findLast((message) => message
    && typeof message === 'object' && ('result' in message || 'error' in message));
  if (!responseMessage) throw new ContractError('mcp_malformed', 'MCP SSE response contained no result message');
  return responseMessage;
}

async function readBounded(response) {
  if (!response.body) throw new ContractError('mcp_malformed', 'MCP response had no body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let result = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_MCP_MESSAGE_BYTES) throw new ContractError('mcp_output_too_large', 'MCP response exceeded bound');
    result += decoder.decode(chunk, { stream: true });
  }
  return result + decoder.decode();
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {
    throw new ContractError('mcp_malformed', 'MCP response was malformed');
  }
}

function minimalEnvironment(headerEnv = {}) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'LANG'];
  allowed.push(...Object.values(headerEnv));
  return Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.removeListener('exit', exited); resolve(false); }, timeoutMs);
    const exited = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', exited);
  });
}
