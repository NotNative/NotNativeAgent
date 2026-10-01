// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runNndNotification } from '../src/nnd-notification.js';

const body = { kind: 'completion', title: 'Finished', body: 'Turn completed.', assistantText: 'The checks passed.' };
function fixture(events = [{ type: 'text', text: '{"title":"Checks passed","body":"The build passed."}' }, { type: 'terminal' }]) {
  const calls = []; let releases = 0;
  const context = { liveTurn: { pending: true }, engine: { sessionId: 'ses_test', router: {
    resolve(role) { calls.push(['resolve', role]); return { profile: { id: 'configured-profile' }, model: 'configured-model', maxOutputTokens: 128 }; },
    provider() { return { async *stream(request) { calls.push(['stream', request]); yield* events; } }; },
  }, scheduler: { async acquire() { return () => { releases += 1; }; } } } };
  return { context, calls, get releases() { return releases; } };
}
test('native notifications use configured routes and never offer tools or mutate a live turn', async () => {
  const state = fixture(); const turn = state.context.liveTurn;
  assert.deepEqual(await runNndNotification(state.context, body), { text: '{"title":"Checks passed","body":"The build passed."}', providerID: 'configured-profile', modelID: 'configured-model' });
  assert.deepEqual(state.calls[0], ['resolve', 'primary']);
  const request = state.calls.find(([kind]) => kind === 'stream')[1];
  assert.deepEqual(request.tools, []); assert.equal(request.maxOutputTokens, 128);
  assert.match(request.messages[0].content, /untrusted content/u);
  assert.equal(state.context.liveTurn, turn); assert.equal(state.releases, 1);
});
test('native notifications reject malformed context before acquiring a route', async () => {
  const state = fixture();
  for (const value of [null, { ...body, permission: 'approve' }, { ...body, kind: 'approval' }, { ...body, assistantText: 'x'.repeat(6001) }]) {
    await assert.rejects(runNndNotification(state.context, value), { code: 'nnd_notification_invalid' });
  }
  assert.deepEqual(state.calls, []);
});
test('native notification overrides select configured models and cannot widen egress', async () => {
  const state = fixture(); const router = state.context.engine.router;
  router.resolve = () => ({ profile: { id: 'private', trustZone: 'private_network' }, model: 'default', maxOutputTokens: 128 });
  router.config = { providerProfiles: { local: { id: 'local', trustZone: 'loopback', outputLimitTokens: 64 },
    public: { id: 'public', trustZone: 'public_network' } } };
  let selected; const provider = router.provider;
  router.provider = (route) => { selected = route; return provider(); };
  const result = await runNndNotification(state.context, { ...body, model: 'local/vendor/small-model' });
  assert.equal(result.providerID, 'local'); assert.equal(result.modelID, 'vendor/small-model');
  assert.equal(selected.profile, router.config.providerProfiles.local);
  assert.equal(state.calls.find(([kind]) => kind === 'stream')[1].maxOutputTokens, 64);
  for (const model of ['public/small', 'missing/small', 'local/', 'local/ padded ', 'local']) {
    await assert.rejects(runNndNotification(state.context, { ...body, model }), { code: 'nnd_notification_unavailable' });
  }
  assert.equal(state.releases, 1);
});
test('native notifications reject tools, incomplete terminals, and output authority fields and release capacity', async () => {
  for (const events of [[{ type: 'tool_fragment' }], [{ type: 'text', text: '{"title":"T","body":"B"}' }],
    [{ type: 'text', text: '{"title":"T","body":"B","permission":"approve"}' }, { type: 'terminal' }], [{ type: 'text', text: 'x'.repeat(4097) }]]) {
    const state = fixture(events); await assert.rejects(runNndNotification(state.context, body)); assert.equal(state.releases, 1);
    assert.equal(state.context.notificationInFlight, null);
  }
});
test('native notifications bound scheduler waits and reject closing or overlapping sessions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const state = fixture();
  state.context.engine.scheduler.acquire = (_profile, _session, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  const pending = runNndNotification(state.context, body);
  await assert.rejects(runNndNotification(state.context, body), { code: 'nnd_notification_busy' });
  t.mock.timers.tick(5000); await assert.rejects(pending, { code: 'nnd_notification_timeout' });
  state.context.closing = true;
  await assert.rejects(runNndNotification(state.context, body), { code: 'nnd_notification_unavailable' });
});
