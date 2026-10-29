// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runDesktopAssist } from '../src/desktop-assist.js';

const body = { prompt: 'summarize this session in one line' };

function fixture(events = [{ type: 'text', text: 'One line summary.' }, { type: 'terminal' }], outputLimit = 1_024) {
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

test('assist uses the configured primary route and never offers tools', async () => {
  const state = fixture(undefined, 128);
  assert.deepEqual(await runDesktopAssist(state.context, body), {
    text: 'One line summary.', providerID: 'local', modelID: 'small',
  });
  assert.deepEqual(state.calls[0], ['resolve', 'primary']);
  const request = state.calls.find(([kind]) => kind === 'stream')[1];
  assert.deepEqual(request.tools, []);
  assert.equal(request.temperature, 0);
  assert.equal(request.maxOutputTokens, 128);
  assert.match(request.messages[1].content, /summarize this session/u);
  assert.match(request.messages[0].content, /untrusted data/u);
  assert.equal(state.releases, 1);
});

test('assist rejects unbounded prompts, control characters, and bad token bounds before a provider call', async () => {
  const state = fixture();
  await assert.rejects(runDesktopAssist(state.context, { prompt: '' }), { code: 'desktop_assist_invalid' });
  await assert.rejects(runDesktopAssist(state.context, { prompt: 'a\u0007b' }), { code: 'desktop_assist_invalid' });
  await assert.rejects(runDesktopAssist(state.context, { prompt: 'x'.repeat(8_193) }), { code: 'desktop_assist_invalid' });
  await assert.rejects(runDesktopAssist(state.context, { prompt: 'ok', max_output_tokens: 100 }), { code: 'desktop_assist_invalid' });
  await assert.rejects(runDesktopAssist(state.context, { prompt: 'ok', max_output_tokens: 4_096 }), { code: 'desktop_assist_invalid' });
  await assert.rejects(runDesktopAssist(state.context, { prompt: 'ok', extra: 1 }), { code: 'desktop_assist_invalid' });
  assert.deepEqual(state.calls, []);
});

test('assist rejects tool calls and releases scheduler capacity', async () => {
  const state = fixture([{ type: 'tool_fragment' }, { type: 'terminal' }]);
  await assert.rejects(runDesktopAssist(state.context, body), { code: 'desktop_assist_tool_violation' });
  assert.equal(state.releases, 1);
});

test('assist refuses an active turn, double generation, and turn-start race', async () => {
  const busy = fixture();
  busy.context.liveTurn = { id: 'turn' };
  await assert.rejects(runDesktopAssist(busy.context, body), { code: 'desktop_assist_busy' });
  assert.deepEqual(busy.calls, []);
  const state = fixture();
  state.context.engine.router.provider = () => ({ async *stream() {
    state.context.liveTurn = { id: 'turn' };
    yield { type: 'text', text: 'started' };
    yield { type: 'terminal' };
  } });
  await assert.rejects(runDesktopAssist(state.context, body), { code: 'desktop_assist_busy' });
  assert.equal(state.releases, 1);
});

test('assist allows a second generation only after the first settles', async () => {
  const state = fixture();
  let releaseStream;
  state.context.engine.router.provider = () => ({ async *stream() {
    await new Promise((resolve) => { releaseStream = resolve; });
    yield { type: 'text', text: 'later' };
    yield { type: 'terminal' };
  } });
  const first = runDesktopAssist(state.context, body);
  await assert.rejects(runDesktopAssist(state.context, body), { code: 'desktop_assist_busy' });
  releaseStream();
  assert.equal((await first).text, 'later');
  assert.equal(state.context.assistInFlight, null);
});
