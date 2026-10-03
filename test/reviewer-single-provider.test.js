// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEngine } from '../src/engine.js';
import { resolveManifest } from '../src/config.js';
import { ModelRouter } from '../src/provider/router.js';
import { OpenAICompatibleProvider } from '../src/provider.js';
import { RoutedSemanticReviewer } from '../src/provider/model-reviewer.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';

const decision = { outcome: 'approve', confidence: 1, reason_code: 'authorized', authority_anchors: [1] };
const request = {
  id: 'single-review', providerCallId: 'call-1', toolName: 'fs_write_text',
  args: { path: 'target.txt', content: 'after', expected_sha256: null },
  resolved: { path: 'D:/workspace/target.txt', exists: false },
  authorityId: 'authority-1', authorityVersion: 1, policyVersion: 1,
  definitionVersion: 1, caller: 'primary', expiresAt: Date.now() + 60_000,
};
const context = {
  authority: { id: 'authority-1', intent: [{ content: 'Change target.txt', sequence: 1 }] },
  definition: { name: 'fs_write_text', sideEffect: 'reversible', scope: 'workspace' }, surface: 'headless',
};
function stream(text, delta = null) {
  const chunk = { choices: [{ index: 0, delta: delta ?? { content: text }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
function rejection(status = 400, code = 'response_format_not_supported') {
  return new Response(JSON.stringify({ error: { code, message: code } }), { status });
}
function harness(respond, capabilities = {}) {
  const attempts = [];
  const config = resolveManifest({ providers: [{
    id: 'sole', endpoint: 'http://127.0.0.1:8080/v1', model: 'single-model',
    trust_zone: 'loopback', capabilities: { tools: true, images: false, ...capabilities },
  }] });
  const router = new ModelRouter(config, (profile) => new OpenAICompatibleProvider(profile, {}, {
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      attempts.push({ url, body });
      return respond(body, attempts.length);
    },
  }));
  const semantic = new RoutedSemanticReviewer(router);
  const mandatory = new MandatoryReviewer({
    semanticReviewer: semantic, ledger: new ReviewerLedger({ durable: false, sessionId: 'single-model' }),
  });
  return { router, semantic, mandatory, attempts };
}

test('sole Primary also supplies reviewer and subagent; constrained JSON rejection retries same route', async () => {
  const h = harness((body) => body.response_format ? rejection() : stream(JSON.stringify(decision)));
  const result = await h.mandatory.review(request, context);
  assert.equal(result.outcome, 'approve');
  assert.equal(h.attempts.length, 2);
  assert.equal(h.attempts[0].body.response_format.type, 'json_schema');
  assert.equal(h.attempts[1].body.response_format, undefined);
  assert.match(h.attempts[1].body.messages[0].content, /Required JSON schema/u);
  assert.deepEqual(h.attempts[0].body.messages[1], h.attempts[1].body.messages[1]);
  for (const attempt of h.attempts) {
    assert.equal(attempt.url, 'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(attempt.body.model, 'single-model');
    assert.equal(attempt.body.tools, undefined);
  }
  assert.equal(h.router.resolve('reviewer').model, 'single-model');
  assert.equal(h.router.resolve('subagent').model, 'single-model');
  assert.throws(() => h.router.resolve('vision', { requiredCapabilities: ['images'] }), { code: 'route_capability_unavailable' });
});

test('declared lack of structured output goes directly to validated JSON text', async () => {
  const h = harness(() => stream(JSON.stringify(decision)), { structured_output: false });
  assert.equal((await h.mandatory.review(request, context)).outcome, 'approve');
  assert.equal(h.attempts.length, 1);
  assert.equal(h.attempts[0].body.response_format, undefined);
});

test('compatibility retry and malformed-output repair are independently bounded', async () => {
  const h = harness((body) => body.response_format ? rejection() : stream('not JSON'));
  assert.equal((await h.mandatory.review(request, context)).reasonCode, 'semantic_review_unavailable');
  assert.equal(h.attempts.length, 3);
});

test('plain JSON still rejects unauthenticated authority anchors', async () => {
  const h = harness(() => stream(JSON.stringify({ ...decision, authority_anchors: [99] })), { structured_output: false });
  assert.equal((await h.mandatory.review(request, context)).reasonCode, 'authority_anchor_invalid');
});

for (const [status, code] of [[401, 'unauthorized'], [400, 'model_not_found'], [503, 'unavailable']]) {
  test(`unrelated provider rejection ${code} does not remove response format`, async () => {
    const h = harness(() => rejection(status, code));
    assert.equal((await h.mandatory.review(request, context)).reasonCode, 'semantic_review_unavailable');
    assert.equal(h.attempts.length, 1);
  });
}

test('operator cancellation during rejection prevents compatibility dispatch', async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return rejection(); });
  await assert.rejects(h.semantic.review(request, controller.signal));
  assert.equal(h.attempts.length, 1);
});

test('unconstrained reviewer cannot call tools or evade a policy denial', async () => {
  const h = harness(() => stream('', { tool_calls: [{ index: 0, id: 'bad', type: 'function',
    function: { name: 'shell_run', arguments: '{}' } }] }), { structured_output: false });
  assert.equal((await h.mandatory.review(request, context)).reasonCode, 'semantic_review_unavailable');
  const denied = harness(() => stream(JSON.stringify({ ...decision, outcome: 'hard_deny' })), { structured_output: false });
  assert.equal((await denied.mandatory.review(request, context)).outcome, 'hard_deny');
});

test('single-model engine executes a governed write after format negotiation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-single-review-'));
  const attempts = [];
  let primaryCalls = 0;
  const config = resolveManifest({ persistence: 'ephemeral', workspace_root: root,
    dream: { enabled: false }, providers: [{ id: 'sole', model: 'single-model',
      endpoint: 'http://127.0.0.1:8080/v1', trust_zone: 'loopback', capabilities: { tools: true } }] });
  const engine = new SessionEngine({ config, telemetry: false, hookRoot: join(root, 'hooks'), skillRoots: [],
    modelRuntime: { resolve: async () => ({ contextWindowTokens: 300000, outputLimitTokens: 32000, source: 'fixture' }) },
    providerFactory: (profile) => new OpenAICompatibleProvider(profile, {}, { fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      attempts.push(body);
      if (!body.tools) return body.response_format ? rejection() : stream(JSON.stringify(decision));
      primaryCalls += 1;
      if (primaryCalls > 1) return stream('Done.');
      const name = 'fs_write_text';
      const args = { path: 'target.txt', content: 'reviewed write' };
      return stream('', { tool_calls: [{ index: 0, id: `primary-${primaryCalls}`, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] });
    } }),
  });
  try {
    await engine.initialize();
    const result = await engine.submit({ request_id: 'single-provider-write', content: 'Write reviewed write into target.txt' }, 'operator');
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(await readFile(join(root, 'target.txt'), 'utf8'), 'reviewed write');
    const reviews = attempts.filter((body) => !body.tools);
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0].response_format.type, 'json_schema');
    assert.equal(reviews[1].response_format, undefined);
    assert.equal(attempts.every((body) => body.model === 'single-model'), true);
  } finally {
    await engine.shutdown({ type: 'shutdown', request_id: 'shutdown' });
    await rm(root, { recursive: true, force: true });
  }
});

test('JSON-text repair recovers once without changing the reviewed request', async () => {
  const h = harness((body, count) => body.response_format ? rejection()
    : stream(count === 2 ? 'invalid' : JSON.stringify(decision)));
  assert.equal((await h.mandatory.review(request, context)).outcome, 'approve');
  assert.equal(h.attempts.length, 3);
  assert.deepEqual(h.attempts[1].body.messages[1], h.attempts[2].body.messages[1]);
  assert.equal(h.attempts[2].body.response_format, undefined);
});

test('grammar compiler failure on a reviewer constraint uses JSON-text fallback', async () => {
  const h = harness((body) => body.response_format
    ? new Response(JSON.stringify({ error: { message: 'failed to compile grammar' } }), { status: 400 })
    : stream(JSON.stringify(decision)));
  assert.equal((await h.mandatory.review(request, context)).outcome, 'approve');
  assert.equal(h.attempts.length, 2);
});
