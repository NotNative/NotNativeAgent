// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ProcessFatalBoundary, fatalMarker } from '../src/process-fatal-boundary.js';

test('fatal process boundary records one sanitized marker, drains cleanup, and exits nonzero', async () => {
  const host = new EventEmitter();
  const markers = []; const exits = []; let cleaned = false;
  const boundary = new ProcessFatalBoundary({
    process: host, version: 'test-version', timeoutMs: 50,
    writeMarker: (marker) => markers.push(marker), exit: (code) => exits.push(code),
  }).install();
  boundary.registerCleanup(async () => { cleaned = true; });

  host.emit('unhandledRejection', Object.assign(new Error('private secret detail'), { code: 'fixture_failure' }));
  await boundary.completion;
  host.emit('uncaughtException', new Error('second private detail'));

  assert.equal(cleaned, true);
  assert.deepEqual(exits, [1]);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].error_code, 'fixture_failure');
  assert.equal(JSON.stringify(markers).includes('private secret'), false);
  assert.equal(host.exitCode, 1);
  boundary.dispose();
  assert.equal(host.listenerCount('unhandledRejection'), 0);
  assert.equal(host.listenerCount('uncaughtException'), 0);
});

test('fatal process cleanup has an independent deadline', async () => {
  const host = new EventEmitter(); const exits = [];
  const boundary = new ProcessFatalBoundary({
    process: host, timeoutMs: 5, writeMarker: () => undefined, exit: (code) => exits.push(code),
  }).install();
  boundary.registerCleanup(() => new Promise(() => undefined));

  host.emit('uncaughtException', new Error('fatal'));
  await boundary.completion;

  assert.deepEqual(exits, [1]);
  boundary.dispose();
});

test('fatal marker contains only stable bounded classifications', () => {
  const marker = fatalMarker('uncaught_exception', { name: 'Odd Error', code: 'bad code', message: 'credential=secret' }, 'v1');
  assert.equal(marker.error_name, 'Odd_Error');
  assert.equal(marker.error_code, 'bad_code');
  assert.equal(marker.product_version, 'v1');
  assert.equal(JSON.stringify(marker).includes('credential'), false);
  assert.match(marker.fingerprint, /^[a-f0-9]{64}$/u);
});
