// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runNndWalkthrough } from '../src/nnd-walkthrough.js';

const revision = 'a'.repeat(64);
const digest = [{ alias: 'h1', scope: 'working', path: 'src/main.js', header: '@@ -1 +1 @@', patch: '-old\n+new' }];
const body = { revision, digest };

function fixture(events = [{ type: 'text', text: '{"chapters":[]}' }, { type: 'terminal' }], outputLimit = 1_024) {
  const calls = [];
  let releases = 0;
  const route = { profile: { id: 'local' }, model: 'small', maxOutputTokens: outputLimit };
  const context = { engine: { sessionId: 'ses_test', router: {
    resolve(role) { calls.push(['resolve', role]); return route; },
    provider(value) { calls.push(['provider', value]); return { async *stream(request) {
      calls.push(['stream', request]); yield* events;
    } }; },
  }, scheduler: { async acquire(id) { calls.push(['acquire', id]); return () => { releases += 1; }; } } } };
  return { context, calls, get releases() { return releases; } };
}

test('walkthrough uses the configured primary route and never offers tools', async () => {
  const state = fixture(undefined, 128);
  assert.deepEqual(await runNndWalkthrough(state.context, body), {
    text: '{"chapters":[]}', providerID: 'local', modelID: 'small', revision,
  });
  assert.deepEqual(state.calls[0], ['resolve', 'primary']);
  const request = state.calls.find(([kind]) => kind === 'stream')[1];
  assert.deepEqual(request.tools, []);
  assert.equal(request.temperature, 0);
  assert.equal(request.maxOutputTokens, 128);
  assert.match(request.messages[1].content, /src\/main\.js/u);
  assert.match(request.messages[0].content, /untrusted data/u);
  assert.equal(state.releases, 1);
});

test('walkthrough rejects malformed aliases, extra fields, and oversized input before a provider call', async () => {
  const state = fixture();
  await assert.rejects(runNndWalkthrough(state.context, { ...body, extra: true }), { code: 'nnd_walkthrough_invalid' });
  await assert.rejects(runNndWalkthrough(state.context, { ...body, digest: [digest[0], digest[0]] }), { code: 'nnd_walkthrough_invalid' });
  await assert.rejects(runNndWalkthrough(state.context, { ...body, digest: [{ ...digest[0], patch: 'x'.repeat(64_000) }] }),
    { code: 'nnd_walkthrough_context_large' });
  assert.deepEqual(state.calls, []);
});

test('walkthrough rejects tool calls and releases scheduler capacity', async () => {
  const state = fixture([{ type: 'tool_fragment' }, { type: 'terminal' }]);
  await assert.rejects(runNndWalkthrough(state.context, body), { code: 'nnd_walkthrough_tool_violation' });
  assert.equal(state.releases, 1);
});

test('walkthrough maps a cancelled scheduler wait to its deadline error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = fixture();
  state.context.engine.scheduler.acquire = (_id, _owner, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('scheduler cancelled')), { once: true });
  });
  const pending = runNndWalkthrough(state.context, body);
  t.mock.timers.tick(45_000);
  await assert.rejects(pending, { code: 'nnd_walkthrough_timeout' });
  assert.equal(state.context.walkthroughInFlight, null);
});

test('walkthrough maps provider abort to timeout and releases its slot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const state = fixture();
  state.context.engine.router.provider = () => ({ async *stream(_request, signal) {
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('provider cancelled')), { once: true });
    });
  } });
  const pending = runNndWalkthrough(state.context, body);
  await Promise.resolve();
  t.mock.timers.tick(45_000);
  await assert.rejects(pending, { code: 'nnd_walkthrough_timeout' });
  assert.equal(state.releases, 1);
});

test('walkthrough refuses an active turn and drops output when a turn starts during generation', async () => {
  const busy = fixture();
  busy.context.liveTurn = { id: 'turn' };
  await assert.rejects(runNndWalkthrough(busy.context, body), { code: 'nnd_walkthrough_busy' });
  assert.deepEqual(busy.calls, []);
  const state = fixture();
  state.context.engine.router.provider = () => ({ async *stream() {
    state.context.liveTurn = { id: 'turn' };
    yield { type: 'text', text: '{"chapters":[]}' };
    yield { type: 'terminal' };
  } });
  await assert.rejects(runNndWalkthrough(state.context, body), { code: 'nnd_walkthrough_busy' });
  assert.equal(state.releases, 1);
});
