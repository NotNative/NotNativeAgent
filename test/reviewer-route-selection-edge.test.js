// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { ModelRouter } from '../src/provider/router.js';
import { RoutedSemanticReviewer } from '../src/provider/model-reviewer.js';

function configuration() {
  const providers = [
    { id: 'first', endpoint: 'http://127.0.0.1:1234/v1', model: 'reviewer', trust_zone: 'loopback', capabilities: { structured_output: true } },
    { id: 'second', endpoint: 'http://127.0.0.1:1235/v1', model: 'reviewer', trust_zone: 'loopback', capabilities: { structured_output: true } },
  ];
  // Compatibility: a stored fallback list is ignored, so the reviewer keeps its own selection.
  return resolveManifest({
    providers,
    routes: {
      primary: { provider_id: 'second' },
      reviewer: { provider_id: 'first', fallbacks: ['vision'] },
      vision: { provider_id: 'second', fallbacks: [] },
    },
  });
}

test('provider construction failure stops at the reviewer selection', async () => {
  const config = configuration();
  const attempts = [];
  const reviewer = new RoutedSemanticReviewer(new ModelRouter(config, (profile) => {
    if (profile.id === 'second') return { async *stream() { attempts.push(profile.id); yield { type: 'tool_fragment' }; } };
    throw Object.assign(new Error('adapter constructor failed'), { code: 'route_provider_invalid' });
  }));
  await assert.rejects(reviewer.review({ request: {}, authenticatedIntent: [] }, new AbortController().signal), { code: 'route_provider_unavailable' });
  assert.deepEqual(attempts, []);
});

test('model runtime construction failure stops at the reviewer selection', async () => {
  const config = configuration();
  const attempts = [];
  const calls = [];
  const reviewer = new RoutedSemanticReviewer(new ModelRouter(config, (profile) => ({ async *stream() { attempts.push(profile.id); yield { type: 'terminal' }; } })), {
    modelRuntime: { async resolve(router, route, signal) {
      calls.push(route.profile.id);
      if (route.profile.id === 'first') throw Object.assign(new Error('runtime unavailable'), { code: 'model_runtime_route_invalid', retryable: true });
    } },
  });
  await assert.rejects(reviewer.review({ request: {}, authenticatedIntent: [] }, new AbortController().signal), { code: 'route_provider_unavailable' });
  assert.deepEqual(calls, ['first']);
  assert.deepEqual(attempts, []);
});

test('bounded repairs apply to the one reviewer selection', async () => {
  const calls = [];
  const provider = { async *stream() { calls.push('reviewer'); throw Object.assign(new Error('bad JSON'), { code: 'reviewer_output_malformed', reviewerOutput: '{}' }); } };
  const routes = [
    { model: 'reviewer', profile: { id: 'one' } }, { model: 'reviewer', profile: { id: 'two' } },
  ];
  const reviewer = new RoutedSemanticReviewer({ candidates: () => routes, provider: () => provider });
  await assert.rejects(reviewer.review({ request: {}, authenticatedIntent: [] }, new AbortController().signal), { code: 'reviewer_output_malformed' });
  assert.equal(calls.length, 2);
});
