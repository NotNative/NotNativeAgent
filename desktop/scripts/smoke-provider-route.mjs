// SPDX-License-Identifier: Apache-2.0
/** Cross-repo contract for saved versus effective provider route. */
import assert from 'node:assert/strict';

export async function probeProviderRoute(call, json) {
  const created = await json(call, '/api/v1/provider-profiles', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile_id: 'smoke', endpoint: 'http://127.0.0.1:9999/v1', model: 'test' }),
  }, 201);
  assert.equal(created.profile.profile_id, 'smoke');
  const edited = await json(call, '/api/v1/provider-profiles/smoke', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: 'Smoke profile' }),
  }, 200);
  assert.equal(edited.profile.display_name, 'Smoke profile');
  assert.equal((await json(call, '/api/v1/provider-profiles', 200)).profiles.some((profile) => profile.profile_id === 'smoke'), true);
  const routeBody = (providerId) => ({ method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider_id: providerId, model: 'test' }) });
  const changed = await json(call, '/api/v1/provider-route', routeBody('delegated'), 200);
  assert.deepEqual(changed.configured_primary_route, { providerID: 'delegated', modelID: 'test' });
  assert.deepEqual(changed.runtime_route, { providerID: 'primary', modelID: 'test' });
  const pending = await json(call, '/api/v1/provider-profiles', 200);
  assert.deepEqual(pending.configured_primary_route, { providerID: 'delegated', modelID: 'test' });
  assert.equal(pending.provider_routing_pending, true);
  const applied = await json(call, '/api/v1/provider-route/activate', { method: 'POST' }, 200);
  assert.deepEqual(applied.runtime_route, { providerID: 'delegated', modelID: 'test' });
  assert.equal(applied.existing_sessions_unchanged, true);
  assert.equal((await json(call, '/api/v1/provider-profiles', 200)).provider_routing_pending, false);
  const restored = await json(call, '/api/v1/provider-route', routeBody('primary'), 200);
  assert.deepEqual(restored.configured_primary_route, { providerID: 'primary', modelID: 'test' });
  assert.equal((await json(call, '/api/v1/provider-profiles', 200)).provider_routing_pending, true);
  const reapplied = await json(call, '/api/v1/provider-route/activate', { method: 'POST' }, 200);
  assert.deepEqual(reapplied.runtime_route, { providerID: 'primary', modelID: 'test' });
  assert.equal((await json(call, '/api/v1/provider-profiles', 200)).provider_routing_pending, false);
  const subagent = await json(call, '/api/v1/provider-route/subagent', 200);
  assert.deepEqual(subagent.configured_route, { providerID: 'delegated', modelID: 'test' });
  assert.deepEqual(subagent.runtime_route, { providerID: 'delegated', modelID: 'test' });
  const switchedSubagent = await json(call, '/api/v1/provider-route/subagent', routeBody('smoke'), 200);
  assert.deepEqual(switchedSubagent.configured_route, { providerID: 'smoke', modelID: 'test' });
  assert.deepEqual(switchedSubagent.runtime_route, { providerID: 'delegated', modelID: 'test' });
  assert.equal((await json(call, '/api/v1/provider-profiles', 200)).provider_routing_pending, true);
  await json(call, '/api/v1/provider-route/activate', { method: 'POST' }, 200);
  assert.deepEqual((await json(call, '/api/v1/nnd/agents', 200)).route, { providerID: 'smoke', modelID: 'test' });
  await json(call, '/api/v1/provider-route/subagent', routeBody('delegated'), 200);
  await json(call, '/api/v1/provider-route/activate', { method: 'POST' }, 200);
  assert.deepEqual((await json(call, '/api/v1/nnd/agents', 200)).route, { providerID: 'delegated', modelID: 'test' });
}
