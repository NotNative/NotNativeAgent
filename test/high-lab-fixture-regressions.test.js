// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as lab from '../scripts/forced-termination-lab.js';
import { typedTerminalProvider } from '../test/typed-provider-fixture.js';

function child() {
  const proc = new EventEmitter(); Object.assign(proc, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kills: 0 });
  proc.kill = () => { proc.kills += 1; queueMicrotask(() => { proc.signalCode = 'SIGKILL'; proc.emit('exit', null, 'SIGKILL'); }); return true; };
  return proc;
}
test('lab rejects clean early exit promptly and accepts unterminated final protocol records', async () => {
  const early = child();
  const rejected = assert.rejects(lab.runChild([], 'completed', { spawn: () => early, recordTimeoutMs: 50 }), { code: 'forced_termination_child_exit' });
  early.exitCode = 0; early.emit('exit', 0); early.emit('close', 0); await rejected; assert.equal(early.kills, 0);
  const final = child(); const pending = lab.runChild([], 'completed', { spawn: () => final, recordTimeoutMs: 50 });
  final.stdout.write('{"kind":"completed"}'); final.exitCode = 0; final.emit('exit', 0); final.emit('close', 0);
  assert.equal((await pending).kind, 'completed');
});
test('lab contains spawn errors instead of leaving an unhandled event', async () => {
  const proc = child(); const pending = lab.runChild([], 'completed', { spawn: () => proc, recordTimeoutMs: 10, cleanupTimeoutMs: 20 });
  let escaped;
  try { proc.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); } catch (error) { escaped = error; }
  await assert.rejects(pending, { code: 'forced_termination_child_failed' }); assert.equal(escaped, undefined);
});
test('forced boundary reaps once and never passes unexpected file contents', async () => {
  assert.equal(typeof lab.forceAt, 'function');
  const root = await mkdtemp(join(tmpdir(), 'nna-force-boundary-')); const proc = child();
  const options = { spawn: () => { setImmediate(() => proc.stdout.write('{"kind":"boundary","sequence":1,"type":"message"}\n')); return proc; },
    recoverJournal: async () => ({ records: [], lastSequence: 1, corruptTail: false }),
    resume: async () => ({ provider_calls: 0, recovery_notice_count: 0, target_state: 'unexpected' }) };
  const result = await lab.forceAt(root, { sequence: 1, type: 'message' }, options);
  assert.equal(result.passed, false); assert.equal(proc.kills, 1); assert.equal(proc.signalCode, 'SIGKILL');
});
test('failed boundary becomes a failed case only after child cleanup', async () => {
  assert.equal(typeof lab.forceAt, 'function');
  const root = await mkdtemp(join(tmpdir(), 'nna-force-failure-')); const proc = child();
  const result = await lab.forceAt(root, { sequence: 1, type: 'message' }, { spawn: () => proc, recordTimeoutMs: 1, cleanupTimeoutMs: 100 });
  assert.equal(result.passed, false); assert.equal(proc.kills, 1); assert.equal(proc.signalCode, 'SIGKILL');
});
const finishTool = [{ function: { name: 'turn.finish' } }];
test('fixture cleans abandoned declarations and preserves unreplayed remainder', async () => {
  const pending = new Map(); const provider = typedTerminalProvider({ async *stream() { yield { type: 'text', text: 'done' }; yield { type: 'terminal' }; } }, pending);
  const iterator = provider.stream({ messages: [{ role: 'user', content: 'one' }], tools: finishTool });
  await iterator.next(); assert.equal(pending.size, 1); await iterator.return(); assert.equal(pending.size, 0);
  pending.set('replay', [{ type: 'text', text: 'first' }, { type: 'terminal' }]);
  const request = { messages: [{ role: 'user' }, { role: 'assistant', tool_calls: [{ id: 'replay', function: { name: 'turn.finish' } }] }], tools: finishTool };
  const replay = provider.stream(request); assert.equal((await replay.next()).value.text, 'first'); await replay.return();
  assert.deepEqual(await Array.fromAsync(provider.stream(request)), [{ type: 'terminal' }]); assert.equal(pending.size, 0);
});
test('fixture cannot replay a previous turn and tolerates null transcript entries', async () => {
  const pending = new Map([['old', [{ type: 'text', text: 'STALE' }]]]);
  const provider = typedTerminalProvider({ async *stream() { yield { type: 'text', text: 'fresh' }; yield { type: 'terminal' }; } }, pending);
  const events = await Array.fromAsync(provider.stream({ messages: [{ role: 'assistant', tool_calls: [{ id: 'old', function: { name: 'turn.finish' } }] }, { role: 'user', content: 'new' }, null], tools: [] }));
  assert.equal(events[0].text, 'fresh');
});
