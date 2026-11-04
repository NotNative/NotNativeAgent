// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { sweepWorkspaceModels } from '../src/experience/model-sweep.js';

function workspace(providers, capabilityHandler) {
  const config = resolveManifest({ providers, routes: { primary: { provider_id: providers[0].id } } });
  return {
    options: { providerCapabilityDeadlineMs: 1_000 },
    activeConfig: () => config,
    activeEngine: () => ({ providerFactory: (profile) => ({
      async capabilities(signal) { return capabilityHandler(profile, signal); },
    }) }),
  };
}

const providers = [
  { id: 'big', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', trust_zone: 'loopback' },
  { id: 'fast', endpoint: 'http://127.0.0.1:2/v1', model: 'qwen', trust_zone: 'loopback' },
];

test('a sweep reports every configured selection and every observed model per connection', async () => {
  const model = workspace(providers, (profile) => ({
    models: profile.id === 'big' ? ['glm-5.3', 'glm', 'extra'] : ['qwen3.8', 'qwen3.8-next'],
    contextLimitTokens: profile.id === 'big' ? 131_072 : 'unknown',
  }));
  const rows = await sweepWorkspaceModels(model);
  const byStatus = (status) => rows.filter((row) => row.status === status).map((row) => `${row.connection_id}/${row.model}`);
  assert.deepEqual(byStatus('configured').sort(), ['big/glm', 'fast/qwen']);
  assert.deepEqual(byStatus('observed').sort(), ['big/extra', 'big/glm-5.3', 'fast/qwen3.8', 'fast/qwen3.8-next']);
  // Why: a configured model that discovery also reports appears once, as its configured row.
  assert.equal(rows.filter((row) => row.connection_id === 'big' && row.model === 'glm').length, 1);
  const observed = rows.find((row) => row.connection_id === 'big' && row.model === 'glm-5.3');
  assert.equal(observed.context_limit_tokens, 131_072);
  assert.equal(rows.find((row) => row.connection_id === 'fast' && row.model === 'qwen3.8').context_limit_tokens, null);
});

test('an unreachable connection degrades to one unavailable row and leaves the others intact', async () => {
  const model = workspace(providers, (profile) => {
    if (profile.id === 'fast') throw Object.assign(new Error('down'), { code: 'provider_transport_error' });
    return { models: ['glm-5.3'] };
  });
  const rows = await sweepWorkspaceModels(model);
  const unavailable = rows.filter((row) => row.status === 'unavailable');
  assert.equal(unavailable.length, 1);
  assert.equal(unavailable[0].connection_id, 'fast');
  assert.equal(unavailable[0].reason_code, 'provider_transport_error');
  // Why: the reachable connection still answers, so one failed probe never hides the whole catalog.
  assert.equal(rows.some((row) => row.connection_id === 'big' && row.model === 'glm-5.3'), true);
});

test('two models on one connection probe the endpoint once', async () => {
  const shared = [
    { id: 'a', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', trust_zone: 'loopback' },
    { id: 'b', endpoint: 'http://127.0.0.1:1/v1', model: 'qwen', trust_zone: 'loopback' },
  ];
  const probes = [];
  const model = workspace(shared, (profile) => { probes.push(profile.id); return { models: ['glm'] }; });
  await sweepWorkspaceModels(model);
  // Why: both selections share one connection identity, so the sweep probes that endpoint once.
  assert.equal(probes.length, 1);
});

test('rows stream as connections answer and a cancelled sweep stops', async () => {
  const seen = [];
  const controller = new AbortController();
  const model = workspace(providers, (profile) => {
    if (profile.id === 'fast') controller.abort();
    return { models: [`${profile.id}-model`] };
  });
  const rows = await sweepWorkspaceModels(model, { signal: controller.signal, onRow: (row) => seen.push(row) });
  assert.ok(seen.length > 0);
  assert.equal(seen.length, rows.length);
  // Why: the configured rows are always reported, even when the sweep stops before probing.
  assert.equal(rows.some((row) => row.status === 'configured'), true);
});

test('a sweep bounds the rows it reports', async () => {
  // Why: the manifest already bounds connections at sixteen, so the sweep bound that matters is the
  // reported row count; several models per connection fill it.
  const many = Array.from({ length: 16 }, (_, index) => ({
    id: `p${index}`, endpoint: `http://127.0.0.1:${index + 1}/v1`, model: `m${index}`, trust_zone: 'loopback',
  }));
  const models = Array.from({ length: 300 }, (_, index) => `discovered-${index}`);
  const model = workspace(many, () => ({ models }));
  const rows = await sweepWorkspaceModels(model);
  assert.equal(rows.length <= 4096, true);
  assert.equal(new Set(rows.map((row) => row.connection_id)).size, 16);
});
