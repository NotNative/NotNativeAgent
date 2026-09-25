// SPDX-License-Identifier: Apache-2.0
/** Cross-repo contract for saved versus effective provider route. */
import assert from 'node:assert/strict';

export async function probeProviderRoute(call, json) {
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
}
