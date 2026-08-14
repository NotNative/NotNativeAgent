// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/events.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { ReviewerLedger } from '../src/reviewer-ledger.js';
import { nextReviewPosture } from '../src/review-posture.js';
import { TerminalInputDecoder } from '../src/tui/terminal-adapter.js';
import { MANDATORY_REVIEW_EVENT_TIMEOUT_MS, ToolGovernor } from '../src/tools/governor.js';
import { semanticReviewTimeout } from '../src/config-bounds.js';

function safeRequest(id = 'safe-1') {
  return Object.freeze({
    id, providerCallId: `provider-${id}`, toolName: 'fs.read_text', args: { path: 'README.md' },
    resolved: { path: 'D:/workspace/README.md' }, authorityId: 'authority-1', authorityVersion: 1,
    policyVersion: 1, definitionVersion: 1, caller: 'primary', expiresAt: Date.now() + 60_000,
  });
}

test('review postures cycle in the documented order and Shift+Tab is decoded', () => {
  assert.equal(nextReviewPosture('auto-review'), 'unattended');
  assert.equal(nextReviewPosture('unattended'), 'prompt');
  assert.equal(nextReviewPosture('prompt'), 'auto-review');
  assert.deepEqual(new TerminalInputDecoder().push(Buffer.from('\u001b[Z')), [{ action: 'cycle_review' }]);
});

test('mandatory review event ceiling exceeds the slowest configurable semantic review', () => {
  const maximumSemanticReview = semanticReviewTimeout({ semantic_review_timeout_ms: 3_600_000 }, 3_600_000);
  assert.ok(MANDATORY_REVIEW_EVENT_TIMEOUT_MS > maximumSemanticReview);
});

test('Prompt posture escalates a deterministically safe reviewed request', async () => {
  const ledger = new ReviewerLedger({ durable: false, sessionId: 'prompt-posture' });
  const reviewer = new MandatoryReviewer({ ledger });
  const result = await reviewer.review(safeRequest(), {
    authority: { id: 'authority-1', intent: [{ content: 'Read README.md', sequence: 1 }], mission: null },
    definition: { name: 'fs.read_text', sideEffect: 'read_only', scope: 'workspace' },
    surface: 'interactive_tui', reviewPosture: 'prompt', justification: '',
  });
  assert.equal(result.outcome, 'escalate_to_operator');
  assert.equal(result.reasonCode, 'prompt_posture_operator_decision');
});

test('Unattended posture converts unresolved escalation into actionable denial', async () => {
  const events = new EventHub();
  const reviewer = {
    ledger: { async executionStarted() {}, async settle() {} },
    async review() {
      return { outcome: 'escalate_to_operator', reasonCode: 'ambiguous', requestId: 'safe-1' };
    },
  };
  const governor = new ToolGovernor({ events, reviewer, registry: {} });
  const result = await governor.review(safeRequest(), {
    surface: 'interactive_tui', reviewPosture: 'unattended', signal: new AbortController().signal,
  }, { category: 'permission', phase: 'pre', payload: { request_id: 'safe-1' } });
  assert.equal(result.outcome, 'deny_with_guidance');
  assert.equal(result.reasonCode, 'unattended_escalation_denied');
});

test('governor preserves a completed verification failure and its reason code', async () => {
  const events = new EventHub();
  const definition = {
    name: 'project.verify', version: 1, timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'unknown',
    async executor() {
      return { status: 'failed', reasonCode: 'verification_failed', content: '{"passed":false}', metadata: { passed: false } };
    },
  };
  const governor = new ToolGovernor({
    events,
    reviewer: { ledger: { async executionStarted() {}, async settle() {} } },
    registry: { definition: () => definition },
  });
  const request = { id: 'verify-1', providerCallId: 'provider-1', toolName: 'project.verify', definitionVersion: 1 };
  const result = await governor.executePrepared(request, { id: 'decision-1' }, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason_code, 'verification_failed');
  assert.equal(result.effect_certainty, 'completed');
  assert.deepEqual(result.metadata, { passed: false });
});

test('governor converts numeric executor error codes into governance-safe reason identifiers', async () => {
  const events = new EventHub();
  const definition = {
    name: 'web.fetch', version: 1, timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'read_only',
    async executor() {
      throw Object.assign(new Error('proxy connection failed'), { code: 23 });
    },
  };
  const governor = new ToolGovernor({
    events,
    reviewer: { ledger: { async executionStarted() {}, async settle() {} } },
    registry: { definition: () => definition },
  });
  const request = { id: 'fetch-1', providerCallId: 'provider-1', toolName: 'web.fetch', definitionVersion: 1 };
  const result = await governor.executePrepared(request, { id: 'decision-1' }, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason_code, 'executor_failure_code_23');
});
