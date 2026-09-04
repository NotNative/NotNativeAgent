// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runHook } from '../src/hook-runner.js';
import { StdioMcpTransport, HttpMcpTransport } from '../src/mcp-transport.js';
import { ConsoleSessionBroker, ConsoleSessionDirectory } from '../src/session-broker.js';

function child() {
  const value = new EventEmitter();
  Object.assign(value, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill() { this.exitCode = 1; } });
  return value;
}
test('cancelled hooks do not launch, and output pipe failures remain terminal-safe', async () => {
  const original = childProcess.spawn; let launched = 0; let current;
  childProcess.spawn = () => { launched += 1; current = child(); return current; }; syncBuiltinESMExports();
  try {
    const subscription = { command: 'node', timeoutMs: 1000 };
    const bundle = { name: 'test', directory: process.cwd() };
    const cancelled = await runHook(subscription, bundle, {}, AbortSignal.abort());
    assert.equal(cancelled.code, 'hook_cancelled'); assert.equal(launched, 0);
    const pending = runHook(subscription, bundle, {});
    assert.doesNotThrow(() => current.stdout.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' })));
    assert.equal((await pending).code, 'hook_failed');
    assert.doesNotThrow(() => current.stderr.emit('error', new Error('late pipe')));
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});
test('MCP output pipe errors settle requests and missing pipes fail explicitly', async () => {
  const proc = child(); const transport = new StdioMcpTransport({ id: 'test', command: 'node', args: [] }, () => proc);
  await transport.open(); const pending = transport.request('tools/list');
  const rejected = assert.rejects(pending, { code: 'EPIPE' });
  assert.doesNotThrow(() => proc.stdout.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' })));
  await rejected;
  assert.doesNotThrow(() => proc.stderr.emit('error', new Error('late pipe')));
  const missing = child(); missing.stdout = null;
  await assert.rejects(new StdioMcpTransport({ id: 'test', command: 'node', args: [] }, () => missing).open(), { code: 'mcp_closed' });
});
test('MCP HTTP errors cancel bodies and cancellation has a stable code', async () => {
  const original = globalThis.fetch; let cancelled = false;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 });
    const transport = new HttpMcpTransport({ id: 'test', endpoint: 'http://localhost/mcp' });
    await assert.rejects(transport.request('tools/list'), { code: 'mcp_http_error' }); assert.equal(cancelled, true);
    globalThis.fetch = async () => { throw new DOMException('cancelled', 'AbortError'); };
    await assert.rejects(transport.request('tools/list', {}, AbortSignal.abort()), { code: 'mcp_cancelled' });
  } finally { globalThis.fetch = original; }
});
test('broker handler contains errors even when the failure response cannot be sent', async () => {
  const broker = new ConsoleSessionBroker({}, { root: process.cwd(), token: 'test' });
  let destroyed = false;
  const response = { writeHead() { throw new Error('socket unavailable'); }, destroy() { destroyed = true; } };
  await assert.doesNotReject(broker.server.listeners('request')[0]({ headers: {} }, response));
  assert.equal(destroyed, true);
});
test('broker responses are streamed within a bound and non-JSON errors are typed', async () => {
  let cancelled = false; let pulls = 0;
  const directory = new ConsoleSessionDirectory('.', { fetch: async () => new Response(new ReadableStream({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1_048_576)); if (pulls === 10) controller.close(); },
    cancel() { cancelled = true; },
  })) });
  const target = { id: 'session', broker: { port: 1234, token: 'test' } };
  await assert.rejects(directory.cancel(target), { code: 'broker_response_too_large' });
  assert.equal(cancelled, true); assert.ok(pulls < 10);
  directory.fetch = async () => new Response('<html>unavailable</html>', { status: 502 });
  await assert.rejects(directory.cancel(target), { code: 'broker_unavailable' });
});
