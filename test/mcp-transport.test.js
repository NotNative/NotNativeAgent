// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { StdioMcpTransport } from '../src/mcp-transport.js';

test('AC-MCP-02 stdio rejects pre-cancelled work before protocol output', async () => {
  const child = fakeChild();
  const transport = new StdioMcpTransport(stdioConfig(), () => child);
  await transport.open();
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(transport.request('tools/list', {}, controller.signal), { code: 'mcp_cancelled' });
  assert.equal(child.writes.length, 0);
  await transport.close();
});

test('AC-MCP-02 stdio failure settles pending work and removes cancellation listeners', async () => {
  const child = fakeChild();
  const transport = new StdioMcpTransport(stdioConfig(), () => child);
  await transport.open();
  const signal = trackedSignal();
  const request = transport.request('tools/list', {}, signal);

  child.emit('error', Object.assign(new Error('subprocess failed'), { code: 'EPIPE' }));
  await assert.rejects(request, { code: 'EPIPE' });
  assert.equal(signal.added, 1);
  assert.equal(signal.removed, 1);
  await assert.rejects(transport.request('tools/list'), { code: 'mcp_closed' });
});

test('AC-MCP-02 stdio child exit settles every pending request', async () => {
  const child = fakeChild();
  const transport = new StdioMcpTransport(stdioConfig(), () => child);
  await transport.open();
  const firstSignal = trackedSignal(); const secondSignal = trackedSignal();
  const first = transport.request('tools/list', {}, firstSignal);
  const second = transport.request('resources/list', {}, secondSignal);

  child.exitCode = 23; child.emit('exit', 23);

  await assert.rejects(first, { code: 'mcp_closed' });
  await assert.rejects(second, { code: 'mcp_closed' });
  assert.equal(firstSignal.removed, 1);
  assert.equal(secondSignal.removed, 1);
  await assert.rejects(transport.request('tools/list'), { code: 'mcp_closed' });
});

test('AC-MCP-02 stdio input-pipe failure degrades the transport instead of escaping', async () => {
  const child = fakeChild();
  child.stdin = new PassThrough();
  const transport = new StdioMcpTransport(stdioConfig(), () => child);
  await transport.open();
  assert.equal(transport.notify('notifications/initialized'), true);

  assert.doesNotThrow(() => child.stdin.emit(
    'error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }),
  ));
  await assert.rejects(transport.request('tools/list'), { code: 'mcp_closed' });
});

test('AC-MCP-02 stdio close immediately settles owned requests', async () => {
  const child = fakeChild();
  const transport = new StdioMcpTransport(stdioConfig(), () => child);
  await transport.open();
  const signal = trackedSignal();
  const request = transport.request('tools/list', {}, signal);

  await transport.close();
  await assert.rejects(request, { code: 'mcp_closed' });
  assert.equal(signal.removed, 1);
  assert.equal(child.ended, true);
});

test('AC-MCP-02 stdio rejects an oversized complete line before JSON parsing', async () => {
  const child = fakeChild();
  const transport = new StdioMcpTransport(stdioConfig(), () => child);
  await transport.open();
  const request = transport.request('tools/list');
  child.stdout.write(`${'x'.repeat(2_097_153)}\n`);

  await assert.rejects(request, { code: 'mcp_output_too_large' });
  await assert.rejects(transport.request('tools/list'), { code: 'mcp_closed' });
  assert.equal(child.ended, true);
});

test('AC-MCP-02 stdio bounds an oversized line before its newline arrives', async () => {
  const child = fakeChild();
  const transport = new StdioMcpTransport(stdioConfig(), () => child);
  await transport.open();
  const request = transport.request('tools/list');
  child.stdout.write('x'.repeat(1_048_577));
  child.stdout.write('x'.repeat(1_048_577));

  await assert.rejects(request, { code: 'mcp_output_too_large' });
  await assert.rejects(transport.request('tools/list'), { code: 'mcp_closed' });
  assert.equal(child.ended, true);
});

test('AC-MCP-04 remote error text is not surfaced across the MCP boundary', async () => {
  const child = fakeChild();
  const transport = new StdioMcpTransport(stdioConfig(), () => child);
  await transport.open();
  const request = transport.request('tools/list');
  child.stdout.write('{"jsonrpc":"2.0","id":1,"error":{"message":"secret remote detail"}}\n');

  await assert.rejects(request, (error) => error.code === 'mcp_remote_error'
    && error.message === 'MCP server returned an error');
  await transport.close();
});

function stdioConfig() {
  return { command: 'fixture-mcp', args: [], cwd: process.cwd() };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.writes = [];
  child.ended = false;
  child.stdin = {
    writable: true,
    write(value, _encoding, callback) {
      child.writes.push(value);
      callback?.();
      return true;
    },
    end() {
      child.ended = true;
      child.stdin.writable = false;
      child.exitCode = 0;
      queueMicrotask(() => child.emit('exit', 0));
    },
  };
  child.kill = () => true;
  return child;
}

function trackedSignal() {
  return {
    aborted: false,
    added: 0,
    removed: 0,
    addEventListener(_type, handler) { this.added += 1; this.handler = handler; },
    removeEventListener(_type, handler) {
      if (this.handler === handler) this.removed += 1;
    },
  };
}
