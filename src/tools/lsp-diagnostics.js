// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContractError } from '../ids.js';

const MAX_MESSAGE_BYTES = 2_097_152;

export function lspDiagnosticsDefinition(paths, options = {}) {
  const configPath = options.configPath;
  const spawnProcess = options.spawnProcess ?? spawn;
  const ledger = new DiagnosticLedger();
  return {
    name: 'code.diagnostics', version: 1,
    purpose: 'Ask an explicitly configured local language server for bounded diagnostics on one accessible file.',
    sideEffect: 'unknown', scope: 'workspace', cancellation: true, timeoutMs: 15_000, maxOutputBytes: 262_144,
    inputSchema: {
      type: 'object', properties: {
        path: { type: 'string', maxLength: 4096, description: 'Required path to one source file handled by a configured language server.' },
      },
      required: ['path'], additionalProperties: false,
    },
    validate: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.path !== 'string'
        || Object.keys(args).some((key) => key !== 'path')) {
        throw new ContractError('tool_schema_invalid', 'code diagnostics requires one file path');
      }
      const resolved = await paths.resolveRead(args.path);
      const config = await matchingServer(configPath, extname(resolved.path).toLowerCase());
      return { args: { path: args.path }, resolved: { ...resolved, lsp: config } };
    },
    executor: async (request, signal) => {
      const text = await readFile(request.resolved.path, 'utf8');
      const diagnostics = await runLspDiagnostics({
        server: request.resolved.lsp, workspaceRoot: paths.root,
        path: request.resolved.path, text, signal, spawnProcess,
      });
      const delta = ledger.observe(request.resolved.path, diagnostics);
      return {
        content: JSON.stringify(delta),
        metadata: {
          path: request.args.path, server: request.resolved.lsp.id, count: diagnostics.length,
          new_count: delta.new.length, resolved_count: delta.resolved.length,
          unchanged_count: delta.unchanged_count,
        },
      };
    },
  };
}

export class DiagnosticLedger {
  #files = new Map();

  observe(path, diagnostics) {
    const prior = this.#files.get(path) ?? new Map();
    const current = new Map(diagnostics.map((item) => [diagnosticFingerprint(item), item]));
    const fresh = [...current].filter(([key]) => !prior.has(key)).map(([, item]) => item);
    const resolved = [...prior].filter(([key]) => !current.has(key)).map(([, item]) => item);
    const unchanged = [...current.keys()].filter((key) => prior.has(key)).length;
    this.#files.set(path, current);
    if (this.#files.size > 1024) this.#files.delete(this.#files.keys().next().value);
    return Object.freeze({
      new: Object.freeze(fresh), resolved: Object.freeze(resolved),
      unchanged_count: unchanged, total_count: current.size,
    });
  }
}

function diagnosticFingerprint(item) {
  return createHash('sha256').update(JSON.stringify({
    message: item.message, severity: item.severity, code: item.code,
    range: item.range, source: item.source,
  })).digest('hex');
}

export async function runLspDiagnostics(options) {
  const child = options.spawnProcess(options.server.command, options.server.args, {
    cwd: options.workspaceRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const uri = pathToFileURL(resolve(options.path)).href;
  const responses = new Map();
  let diagnostics = null; let buffer = Buffer.alloc(0); let stderrBytes = 0;
  const done = deferred();
  done.promise.catch(() => undefined);
  const fail = (error) => done.reject(error instanceof ContractError ? error
    : new ContractError('lsp_transport_failed', 'language server transport failed', true));
  child.on('error', fail);
  child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderrBytes > MAX_MESSAGE_BYTES) fail(new ContractError('lsp_stderr_too_large', 'language server error output exceeded its bound')); });
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_MESSAGE_BYTES * 2) return fail(new ContractError('lsp_output_too_large', 'language server output exceeded its bound'));
    try {
      const parsed = parseFrames(buffer); buffer = parsed.rest;
      for (const message of parsed.messages) {
        if (message.id !== undefined) responses.set(message.id, message);
        if (message.method === 'textDocument/publishDiagnostics' && message.params?.uri === uri) {
          diagnostics = normalizeDiagnostics(message.params.diagnostics);
          done.resolve(diagnostics);
        }
      }
    } catch (error) { fail(error); }
  });
  const abort = () => fail(new ContractError('lsp_cancelled', 'language diagnostics were cancelled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      processId: process.pid, rootUri: pathToFileURL(options.workspaceRoot).href,
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
    } });
    await waitFor(() => responses.get(1), 5_000, options.signal, 'lsp_initialize_timeout');
    send(child, { jsonrpc: '2.0', method: 'initialized', params: {} });
    send(child, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri, languageId: options.server.language_id, version: 1, text: options.text },
    } });
    return await Promise.race([
      done.promise,
      waitFor(() => diagnostics, 7_500, options.signal, 'lsp_diagnostics_timeout'),
    ]);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try { send(child, { jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }); } catch { /* already closed */ }
    child.kill();
  }
}

async function matchingServer(path, extension) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new ContractError('lsp_not_configured', 'configure a local language server before requesting diagnostics');
    throw new ContractError('lsp_config_invalid', 'language server configuration is invalid');
  }
  const servers = Array.isArray(value?.servers) ? value.servers.slice(0, 32).map(validateServer) : [];
  const match = servers.find((server) => server.extensions.includes(extension));
  if (!match) throw new ContractError('lsp_not_configured', `no language server is configured for ${extension || 'this file type'}`);
  return match;
}

function validateServer(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.command !== 'string'
    || !Array.isArray(value.args) || value.args.some((item) => typeof item !== 'string' || item.length > 4096)
    || !Array.isArray(value.extensions) || value.extensions.some((item) => !/^\.[a-z0-9.+-]{1,16}$/u.test(item))
    || typeof value.language_id !== 'string') throw new ContractError('lsp_config_invalid', 'language server entry is malformed');
  return Object.freeze({
    id: value.id.slice(0, 128), command: value.command.slice(0, 4096), args: value.args.slice(0, 64),
    extensions: value.extensions.map((item) => item.toLowerCase()), language_id: value.language_id.slice(0, 128),
  });
}

function send(child, message) {
  const body = Buffer.from(JSON.stringify(message));
  child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); child.stdin.write(body);
}

function parseFrames(input) {
  const messages = []; let offset = 0;
  while (offset < input.length) {
    const end = input.indexOf('\r\n\r\n', offset, 'ascii');
    if (end === -1) break;
    const header = input.subarray(offset, end).toString('ascii');
    const match = /(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/iu.exec(header);
    if (!match) throw new ContractError('lsp_protocol_invalid', 'language server frame omitted Content-Length');
    const length = Number(match[1]);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) throw new ContractError('lsp_output_too_large', 'language server frame exceeded its bound');
    const start = end + 4; if (input.length < start + length) break;
    try { messages.push(JSON.parse(input.subarray(start, start + length).toString('utf8'))); }
    catch { throw new ContractError('lsp_protocol_invalid', 'language server returned malformed JSON'); }
    offset = start + length;
  }
  return { messages, rest: input.subarray(offset) };
}

function normalizeDiagnostics(value) {
  if (!Array.isArray(value)) throw new ContractError('lsp_protocol_invalid', 'language server diagnostics were malformed');
  return value.slice(0, 1000).map((item) => ({
    message: String(item?.message ?? '').slice(0, 4096), severity: Number.isSafeInteger(item?.severity) ? item.severity : null,
    code: typeof item?.code === 'string' || typeof item?.code === 'number' ? item.code : null,
    range: item?.range ?? null, source: typeof item?.source === 'string' ? item.source.slice(0, 128) : null,
  }));
}

async function waitFor(probe, timeoutMs, signal, code) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = probe(); if (value) return value;
    if (signal?.aborted) throw new ContractError('lsp_cancelled', 'language diagnostics were cancelled');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new ContractError(code, 'language server operation timed out', true);
}

function deferred() {
  let resolvePromise; let rejectPromise;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
