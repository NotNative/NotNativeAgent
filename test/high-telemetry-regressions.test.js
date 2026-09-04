// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { sanitizeTelemetry } from '../src/forensic-telemetry-sanitize.js';
import { ForensicTelemetry } from '../src/forensic-telemetry.js';

test('telemetry sanitizer limits cannot be disabled by malformed options', () => {
  for (const limit of [NaN, Infinity, -1, '8', true]) {
    const value = sanitizeTelemetry({ text: 'x'.repeat(70000), children: [1, 2] },
      { maxStringBytes: limit, maxNodes: limit, maxKeys: limit, maxArray: limit, maxDepth: limit });
    assert.equal(value.text._nna_telemetry, 'text_truncated'); assert.deepEqual(value.children, [1, 2]);
  }
});

test('telemetry sanitizer retains reserved keys without prototype mutation', () => {
  const result = sanitizeTelemetry(JSON.parse('{"__proto__":{"inherited":true}}'));
  assert.equal(Object.hasOwn(result, '__proto__'), true); assert.equal(result.inherited, undefined);
  assert.equal(JSON.parse(JSON.stringify(result)).__proto__.inherited, true);
});

test('unknown lifecycle outcomes are not recorded as successes; explicit continuation is valid', () => {
  const telemetry = new ForensicTelemetry({ workspaceRoot: '.', sessionId: 's', runtimeId: 'r' });
  const rows = []; telemetry.record = (...args) => rows.push(args);
  telemetry.lifecycleObserver().lifecycleFinished({ id: 'x', kind: 'turn', outcome: 'typo' });
  assert.equal(rows.at(-1)[1], 'unknown');
  telemetry.eventObserver().dispatchFinished({}, { decision: 'continue' }, 1);
  assert.equal(rows.at(-1)[1], 'succeeded');
  telemetry.eventObserver().subscriberFinished({}, {}, 'span', undefined, 1);
  assert.equal(rows.at(-1)[1], 'succeeded');
});

async function telemetryClass(Worker) {
  const source = (await readFile(new URL('../src/forensic-telemetry.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\r?\n/gmu, '').replace(/\bexport /gu, '').replaceAll('import.meta.url', "'file:///fixture/forensic-telemetry.js'");
  return vm.runInNewContext(`${source}\nForensicTelemetry`, {
    Worker, URL, ContractError: Error, VERSION: 'fixture', join: (...parts) => parts.join('/'),
    userDataPaths: () => ({ projects: '/tmp' }), newId: () => 'id', sanitizeTelemetry,
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 30)), clearTimeout,
  });
}

test('telemetry cannot restart after close and readiness settles on clean early exit', async () => {
  let starts = 0;
  class Worker extends EventEmitter {
    constructor() { super(); starts += 1; setImmediate(() => this.emit('exit', 0)); }
    postMessage() {} async terminate() { return 0; }
  }
  const Telemetry = await telemetryClass(Worker);
  const options = { workspaceRoot: '.', sessionId: 's', runtimeId: 'r', dbPath: '/tmp/events.db' };
  const closed = new Telemetry(options); await closed.close();
  await Promise.race([closed.initialize(), new Promise((resolve) => setTimeout(resolve, 80))]);
  assert.equal(starts, 0);
  const early = new Telemetry(options);
  const result = await Promise.race([early.initialize(), new Promise((resolve) => setTimeout(() => resolve('hung'), 80))]);
  assert.notEqual(result, 'hung'); assert.equal(result.status, 'degraded'); await early.close();
});

test('telemetry startup timeout terminates an unresponsive worker', async () => {
  let terminated = false;
  class Worker extends EventEmitter { postMessage() {} async terminate() { terminated = true; this.emit('exit', 0); } }
  const Telemetry = await telemetryClass(Worker);
  const telemetry = new Telemetry({ workspaceRoot: '.', sessionId: 's', runtimeId: 'r', dbPath: '/tmp/events.db' });
  const result = await Promise.race([telemetry.initialize(), new Promise((resolve) => setTimeout(() => resolve('hung'), 80))]);
  assert.notEqual(result, 'hung'); assert.equal(result.status, 'degraded'); assert.equal(terminated, true); await telemetry.close();
});

test('worker schema startup failure closes the database and rejects later traffic', async () => {
  const source = (await readFile(new URL('../src/forensic-telemetry-worker.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gmu, '');
  const port = new EventEmitter(); const messages = []; port.postMessage = (message) => messages.push(message);
  let closed = false;
  class DatabaseSync { exec() { throw Object.assign(new Error('schema failure'), { errcode: 11 }); } close() { closed = true; } }
  vm.runInNewContext(source, { parentPort: port, workerData: { dbPath: '/tmp/events.db' }, DatabaseSync,
    mkdirSync() {}, dirname: () => '/tmp' });
  assert.equal(closed, true); assert.equal(messages[0].type, 'fatal');
  port.emit('message', { type: 'health', id: 'request' });
  assert.equal(messages.at(-1).error, 'telemetry_unavailable');
});
