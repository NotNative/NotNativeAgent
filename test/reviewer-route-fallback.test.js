// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { ModelRouter } from '../src/provider/router.js';
import { FairScheduler } from '../src/provider/fair-scheduler.js';
import { RoutedSemanticReviewer } from '../src/provider/model-reviewer.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';
import { MandatoryReviewer } from '../src/reviewer.js';

function mutationRequest(id) {
  return Object.freeze({
    id, providerCallId: `provider-${id}`, toolName: 'fs_write_text',
    args: { path: 'target.txt', content: 'after', expected_sha256: null },
    resolved: { path: 'D:/workspace/target.txt', exists: false },
    authorityId: 'authority-1', authorityVersion: 1, policyVersion: 1,
    definitionVersion: 1, caller: 'primary', expiresAt: Date.now() + 60_000,
  });
}

function reviewProvider(profileId, attempted) {
  return {
    async *stream() {
      attempted.push(profileId);
      if (profileId === 'primary') {
        throw Object.assign(new Error('transport failed'), { code: 'provider_transport_error', retryable: true });
      }
      yield { type: 'text', text: JSON.stringify({
        outcome: 'approve', confidence: 1, reason_code: 'intent_match', authority_anchors: [1],
      }) };
      yield { type: 'terminal' };
    },
  };
}

function configuration() {
  const providers = [
    { id: 'primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'same-model', trust_zone: 'loopback', capabilities: { structured_output: true } },
    { id: 'backup', endpoint: 'http://127.0.0.1:1235/v1', model: 'review-model', trust_zone: 'loopback', capabilities: { structured_output: true } },
  ];
  return resolveManifest({ providers, routes: {
    reviewer: { provider_id: 'primary', fallbacks: ['vision'] },
    vision: { provider_id: 'backup', fallbacks: [] },
  } });
}

const context = {
  authority: { id: 'authority-1', intent: [{ content: 'Change target.txt', sequence: 1 }] },
  definition: { sideEffect: 'reversible' }, surface: 'headless',
};

test('reviewer transport failure advances through the route graph', async () => {
  const config = configuration();
  const attempted = [];
  const semanticReviewer = new RoutedSemanticReviewer(new ModelRouter(config, (profile) => reviewProvider(profile.id, attempted)));
  const decision = await semanticReviewer.review(mutationRequest('route-fallback'), new AbortController().signal, context);
  assert.deepEqual(attempted, ['primary', 'backup']);
  assert.equal(decision.outcome, 'approve');
});

test('a fallback decision is recorded once and retains the same logical request', async () => {
  const config = configuration();
  const attempted = [];
  const receipts = [];
  const semanticReviewer = new RoutedSemanticReviewer(new ModelRouter(config, (profile) => reviewProvider(profile.id, attempted)), {
    recordTokenReceipt: async (receipt) => {
      receipts.push({ logicalRequestId: receipt.logicalRequestId, route: receipt.route, outcome: receipt.outcome });
    },
  });
  const ledger = new ReviewerLedger({ durable: false, sessionId: 'reviewer-route-fallback' });
  const reviewer = new MandatoryReviewer({ ledger, semanticReviewer });
  const result = await reviewer.review(mutationRequest('route-fallback-recorded'), {
    ...context, definition: { name: 'fs_write_text', sideEffect: 'reversible', scope: 'workspace' },
  });
  assert.equal(result.outcome, 'approve');
  assert.deepEqual(attempted, ['primary', 'backup']);
  assert.equal(receipts.length, 2);
  assert.equal(new Set(receipts.map((receipt) => receipt.logicalRequestId)).size, 1);
  assert.deepEqual(receipts.map((receipt) => receipt.route?.profile?.id), ['primary', 'backup'], JSON.stringify(receipts));
  const summary = ledger.summary(mutationRequest('route-fallback-recorded'))[0];
  assert.equal(summary.decision, 'approve');
});

test('non-retryable reviewer failures fail closed without route fallback', async () => {
  const config = configuration();
  const attempted = [];
  const semanticReviewer = new RoutedSemanticReviewer(new ModelRouter(config, () => ({
    async *stream() {
      attempted.push('primary');
      throw Object.assign(new Error('reject'), { code: 'reviewer_reasoning_invalid' });
    },
  })));
  await assert.rejects(semanticReviewer.review(mutationRequest('route-no-fallback'), new AbortController().signal, context), {
    code: 'reviewer_reasoning_invalid',
  });
  assert.deepEqual(attempted, ['primary']);
});

test('provider construction failure advances through the route graph', async () => {
  const config = configuration();
  const attempted = [];
  const provider = reviewProvider('backup', attempted);
  const semanticReviewer = new RoutedSemanticReviewer(new ModelRouter(config, (profile) => {
    if (profile.id === 'backup') return provider;
    throw Object.assign(new Error('adapter constructor failed'), { code: 'route_provider_invalid' });
  }));
  const decision = await semanticReviewer.review(mutationRequest('provider-invalid'), new AbortController().signal, context);
  assert.deepEqual(attempted, ['backup']);
  assert.equal(decision.outcome, 'approve');
});

test('cancellation during route setup does not acquire reviewer work', async () => {
  const config = configuration();
  const attempted = [];
  const scheduler = new FairScheduler({ limit: 1 });
  let continueSetup;
  const modelRuntime = {
    resolve: () => new Promise((resolve) => { continueSetup = resolve; }),
  };
  const reviewer = new RoutedSemanticReviewer(new ModelRouter(config, () => reviewProvider('primary', attempted)), {
    scheduler, modelRuntime,
  });
  const heldAttempt = await scheduler.acquire('primary', 'held', new AbortController().signal);
  const signalController = new AbortController();
  signalController.abort();
  const cancelledReview = Promise.resolve(reviewer.review(mutationRequest('scheduler-cancel'), signalController.signal, context));
  continueSetup(null);
  heldAttempt();
  await assert.rejects(
    cancelledReview,
    { code: 'scheduler_cancelled' },
  );
  assert.deepEqual(attempted, [], 'cancelled work must not be dispatched');
});
