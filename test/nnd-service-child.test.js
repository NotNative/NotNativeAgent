// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { launchNndServiceChild } from '../src/nnd-service-child.js';

function fixture() {
  const process = new EventEmitter(); process.pid = 123;
  process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kill = () => { process.emit('exit', 0); return true; };
  const bootstrap = { type: 'bootstrap', protocol: '1.0', generation: 'generation', installation_id: 'install',
    data_id: 'data', ui_origin: 'http://127.0.0.1:2345', engine: { endpoint: 'http://127.0.0.1:2346', token: 'secret' } };
  const child = launchNndServiceChild({ node: 'node', install_root: 'root', data_root: 'data' }, 'entry', bootstrap,
    { spawn: () => process, version: '20261002-1' });
  const ready = { type: 'ready', protocol: '1.0', generation: 'generation', installation_id: 'install',
    data_id: 'data', endpoint: bootstrap.ui_origin, version: '20261002-1' };
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  return { process, child, ready, emit };
}
test('post-ready duplicate or malformed frames terminate protocol ownership', async () => {
  const f = fixture(); f.emit(f.ready); await f.child.ready;
  f.emit(f.ready);
  assert.equal((await f.child.fatal).code, 'nnd_service_protocol_invalid');
  await assert.rejects(f.child.command('issue_ui_ticket'), { code: 'nnd_service_crashed' });
  f.process.emit('exit', 0); await f.child.close();
});
test('child process error after spawn never proves process termination', async () => {
  const f = fixture(); f.emit(f.ready); await f.child.ready;
  let exited = false; f.child.exited.then(() => { exited = true; });
  f.process.emit('error', new Error('kill denied'));
  await Promise.resolve(); assert.equal(exited, false);
  assert.equal((await f.child.fatal).code, 'nnd_service_crashed');
  f.process.emit('exit', 1); await f.child.close(); assert.equal(exited, true);
});
test('oversized child frame fails within a bounded buffer before readiness', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.child.ready, { code: 'nnd_service_protocol_invalid' });
  f.process.stdout.write('x'.repeat(65537)); await rejected;
  f.process.emit('exit', 1); await f.child.close();
});
