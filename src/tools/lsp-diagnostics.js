// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContractError } from '../ids.js';

const MAX_MESSAGE_BYTES = 2_097_152;
const MAX_BUFFER_BYTES = MAX_MESSAGE_BYTES * 2;
const MAX_DIAGNOSTICS_PER_FILE = 1_000;
const MAX_LEDGER_FILES = 1_024;
const FORCE_KILL_DELAY_MS = 1_000;

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
    if (!Array.isArray(diagnostics)) {
      throw new ContractError('lsp_diagnostics_invalid', 'diagnostic ledger input must be an array');
    }
    const prior = this.#files.get(path) ?? new Map();
    const current = new Map(diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      .map((item) => [diagnosticFingerprint(item), item]));
    const fresh = [...current].filter(([key]) => !prior.has(key)).map(([, item]) => item);
    const resolved = [...prior].filter(([key]) => !current.has(key)).map(([, item]) => item);
    const unchanged = [...current.keys()].filter((key) => prior.has(key)).length;
    this.#files.delete(path);
    this.#files.set(path, current);
    if (this.#files.size > MAX_LEDGER_FILES) this.#files.delete(this.#files.keys().next().value);
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
  const transport = observeTransport(child, uri);
  const { done, fail, responses } = transport;
  const abort = () => fail(new ContractError('lsp_cancelled', 'language diagnostics were cancelled'));
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      processId: process.pid, rootUri: pathToFileURL(options.workspaceRoot).href,
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false } } },
    } }, fail);
    await waitFor(() => responses.get(1), 5_000, options.signal, 'lsp_initialize_timeout');
    send(child, { jsonrpc: '2.0', method: 'initialized', params: {} }, fail);
    send(child, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri, languageId: options.server.language_id, version: 1, text: options.text },
    } }, fail);
    return await Promise.race([
      done.promise,
      waitFor(transport.diagnostics, 7_500, options.signal, 'lsp_diagnostics_timeout'),
    ]);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    closeTransport(child, transport);
  }
}

function observeTransport(child, uri) {
  const responses = new Map();
  let diagnostics = null; let buffer = Buffer.alloc(0); let stderrBytes = 0;
  const done = deferred();
  const fail = (error) => done.reject(error instanceof ContractError ? error
    : new ContractError('lsp_transport_failed', 'language server transport failed', true));
  const onStderr = (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_MESSAGE_BYTES) fail(new ContractError('lsp_stderr_too_large', 'language server error output exceeded its bound'));
  };
  const onStdout = (chunk) => {
    if (chunk.length > MAX_BUFFER_BYTES || buffer.length > MAX_BUFFER_BYTES - chunk.length) {
      fail(new ContractError('lsp_output_too_large', 'language server output exceeded its bound')); return;
    }
    buffer = Buffer.concat([buffer, chunk], buffer.length + chunk.length);
    try {
      const parsed = parseFrames(buffer); buffer = parsed.rest;
      for (const message of parsed.messages) {
        if (message.id !== undefined) responses.set(message.id, message);
        if (message.method === 'textDocument/publishDiagnostics' && message.params?.uri === uri) {
          diagnostics = normalizeDiagnostics(message.params.diagnostics); done.resolve(diagnostics);
        }
      }
    } catch (error) { fail(error); }
  };
  child.on('error', fail); child.stdin.on('error', fail);
  child.stderr.on('data', onStderr); child.stdout.on('data', onStdout);
  return { responses, done, fail, onStderr, onStdout, diagnostics: () => diagnostics };
}

function closeTransport(child, transport) {
  child.stderr.removeListener('data', transport.onStderr);
  child.stdout.removeListener('data', transport.onStdout);
  const removeErrorListeners = () => {
    child.removeListener('error', transport.fail); child.stdin.removeListener('error', transport.fail);
  };
  child.once('exit', removeErrorListeners);
  try { send(child, { jsonrpc: '2.0', id: 2, method: 'shutdown', params: null }, transport.fail); }
  catch { /* already closed */ }
  terminateChild(child);
  if (child.exitCode !== null || child.signalCode !== null) removeErrorListeners();
}

async function matchingServer(path, extension) {
  let source;
  try { source = await readFile(path, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') throw new ContractError('lsp_not_configured', 'configure a local language server before requesting diagnostics');
    const failure = new ContractError('lsp_config_unreadable', 'language server configuration could not be read');
    failure.cause = error;
    throw failure;
  }
  let value;
  try { value = JSON.parse(source); } catch (error) {
    const failure = new ContractError('lsp_config_invalid', 'language server configuration is invalid');
    failure.cause = error;
    throw failure;
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

function send(child, message, onError = null) {
  if (!child.stdin.writable || child.stdin.destroyed || child.stdin.writableEnded) {
    throw new ContractError('lsp_transport_closed', 'language server input is closed', true);
  }
  const body = Buffer.from(JSON.stringify(message));
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  child.stdin.write(frame, (error) => { if (error) onError?.(error); });
}

function terminateChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const forceKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, FORCE_KILL_DELAY_MS);
  forceKill.unref();
  child.once('exit', () => clearTimeout(forceKill));
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
  return value.slice(0, MAX_DIAGNOSTICS_PER_FILE).map((item) => ({
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
