// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/events.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';
import { nextReviewPosture } from '../src/review-posture.js';
import { TerminalInputDecoder } from '../src/tui/terminal-adapter.js';
import {
  denialResult, mandatoryReviewEventTimeout, MANDATORY_REVIEW_EVENT_TIMEOUT_MS, ToolGovernor,
} from '../src/tools/governor.js';
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
  const maximumSemanticReview = semanticReviewTimeout({ semantic_review_timeout_ms: 86_400_000 }, 86_400_000);
  const eventTimeout = mandatoryReviewEventTimeout(maximumSemanticReview);
  assert.equal(eventTimeout, MANDATORY_REVIEW_EVENT_TIMEOUT_MS);
  assert.ok(eventTimeout > maximumSemanticReview);
});

test('mandatory review event deadline follows the configured semantic reviewer with settlement grace', () => {
  assert.equal(mandatoryReviewEventTimeout(125_000), 130_000);
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
  assert.doesNotMatch(result.guidance, /explicitly authorized/u);
  const denied = denialResult(safeRequest(), result);
  assert.equal(denied.metadata.denial_kind, 'operator_unavailable');
  assert.equal(denied.metadata.continuation, 'continue_without_escalated_operation');
  assert.equal(denied.metadata.retry, 'never_this_turn');
  assert.equal(denied.metadata.user_clarification, false);
  assert.match(denied.content, /preserve it as blocked evidence/u);
});

test('governor preserves a returned failure without claiming its side effects completed', async () => {
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
  assert.equal(result.effect_certainty, 'unknown');
  assert.deepEqual(result.metadata, { passed: false });
});

test('governor accepts an executor-owned effect certainty for a returned failure', async () => {
  const definition = {
    name: 'project.verify', version: 1, timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'unknown',
    async executor() {
      return {
        status: 'failed', reasonCode: 'verification_failed', effectCertainty: 'none',
        content: '{"passed":false}', metadata: { passed: false },
      };
    },
  };
  const governor = new ToolGovernor({
    events: new EventHub(),
    reviewer: { ledger: { async executionStarted() {}, async settle() {} } },
    registry: { definition: () => definition },
  });
  const request = { id: 'verify-none', providerCallId: 'provider-none', toolName: 'project.verify', definitionVersion: 1 };
  const result = await governor.executePrepared(request, { id: 'decision-none' }, new AbortController().signal);
  assert.equal(result.effect_certainty, 'none');
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

test('governor converts platform error codes into stable tool reason identifiers', async () => {
  const definition = {
    name: 'fs.read', version: 1, timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'read_only',
    async executor() { throw Object.assign(new Error('platform detail'), { code: 'ENOENT' }); },
  };
  const governor = new ToolGovernor({
    events: new EventHub(),
    reviewer: { ledger: { async executionStarted() {}, async settle() {} } },
    registry: { definition: () => definition },
  });
  const request = { id: 'read-missing', providerCallId: 'provider-missing', toolName: 'fs.read', definitionVersion: 1 };
  const result = await governor.executePrepared(request, { id: 'decision-missing' }, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason_code, 'tool_target_not_found');
  assert.doesNotMatch(JSON.stringify(result), /ENOENT/u);
});

test('governor normalizes platform codes reported by a failed tool result', async () => {
  const definition = {
    name: 'fs.read', version: 1, timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'read_only',
    async executor() { return { status: 'failed', reasonCode: 'EACCES', content: 'target could not be read' }; },
  };
  const governor = new ToolGovernor({
    events: new EventHub(),
    reviewer: { ledger: { async executionStarted() {}, async settle() {} } },
    registry: { definition: () => definition },
  });
  const request = { id: 'read-denied', providerCallId: 'provider-denied', toolName: 'fs.read', definitionVersion: 1 };
  const result = await governor.executePrepared(request, { id: 'decision-denied' }, new AbortController().signal);
  assert.equal(result.reason_code, 'tool_access_denied');
});
