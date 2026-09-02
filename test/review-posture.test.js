// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../src/events.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { requestDigest, ReviewerLedger } from '../src/persistence/reviewer-ledger.js';
import { nextReviewPosture } from '../src/review-posture.js';
import { TerminalInputDecoder } from '../src/tui/terminal-adapter.js';
import {
  denialResult, mandatoryReviewEventTimeout, MANDATORY_REVIEW_EVENT_TIMEOUT_MS, ToolGovernor,
} from '../src/tools/governor.js';
import { semanticReviewTimeout } from '../src/config-bounds.js';
import { ContractError } from '../src/ids.js';

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

test('execution revalidation rejects an approval without a finite expiry', async () => {
  const request = safeRequest('missing-expiry');
  const governor = new ToolGovernor({
    events: new EventHub(),
    reviewer: { ledger: { async executionStarted() { assert.fail('invalid approval reached execution'); } } },
    registry: {},
  });
  const decision = {
    id: 'decision-missing-expiry', outcome: 'approve', requestId: request.id,
    requestDigest: requestDigest(request), authorityId: request.authorityId,
    authorityVersion: request.authorityVersion, authorityRestrictionVersion: 0,
    policyVersion: request.policyVersion,
  };
  await assert.rejects(governor.beginExecution(request, decision, {
    authority: { id: request.authorityId, version: request.authorityVersion, restrictionVersion: 0 },
    policyVersion: request.policyVersion, workspaceRoot: request.workspaceRoot,
  }), { code: 'tool_revalidation_drift', message: 'approval expired after review but before execution' });
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

test('sub-agent cancellation stops waiting after its bounded settlement window', async () => {
  let releaseStarted;
  const started = new Promise((resolve) => { releaseStarted = resolve; });
  const definition = {
    name: 'agent.run', version: 1, scope: 'subagent', timeoutMs: null,
    maxOutputBytes: 4096, sideEffect: 'unknown',
    async executor(_request, signal) {
      releaseStarted();
      await new Promise((_resolve) => {
        // Deliberately ignore abort to model an uncooperative provider stream.
        signal.addEventListener('abort', () => {}, { once: true });
      });
    },
  };
  const governor = new ToolGovernor({
    events: new EventHub(),
    reviewer: { ledger: { async executionStarted() {}, async settle() {} } },
    registry: { definition: () => definition },
    subagentCancellationSettlementMs: 20,
  });
  const controller = new AbortController();
  const request = {
    id: 'agent-cancel', providerCallId: 'provider-agent-cancel',
    toolName: 'agent.run', definitionVersion: 1,
  };
  const resultPromise = governor.executePrepared(request, { id: 'decision-agent-cancel' }, controller.signal);
  await started;
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.reason_code, 'tool_cancelled');
  assert.equal(result.effect_certainty, 'unknown');
  assert.deepEqual(result.metadata, {
    cancellation_settlement: 'expired', cancellation_settlement_ms: 20,
  });
});

test('governor redacts discovered credentials at the shared tool-result boundary', async () => {
  const definition = {
    name: 'system.inspect', version: 1, timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'read_only',
    async executor() {
      return {
        content: 'ready\nauthtoken=discovered-output-token\nhttps://operator:url-password@example.test',
        metadata: { token: 'metadata-token', note: 'access_token=metadata-note-token' },
      };
    },
  };
  const governor = new ToolGovernor({
    events: new EventHub(), reviewer: { ledger: { async executionStarted() {}, async settle() {} } },
    registry: { definition: () => definition },
  });
  const request = { id: 'inspect-1', providerCallId: 'provider-inspect', toolName: 'system.inspect', definitionVersion: 1 };
  const result = await governor.executePrepared(request, { id: 'decision-inspect' }, new AbortController().signal);
  assert.equal(result.status, 'succeeded');
  assert.match(result.content, /authtoken=\[redacted\]/u);
  assert.match(result.content, /https:\/\/operator:\[redacted\]@example\.test/u);
  assert.deepEqual(result.metadata, {
    token: '[redacted]', note: 'access_token=[redacted]', contentRedacted: true,
    originalBytes: 82, projectionReason: 'secret_redaction',
  });
  assert.doesNotMatch(JSON.stringify(result), /discovered-output-token|url-password|metadata-token|metadata-note-token/u);
});

test('governor redacts credentials from executor failure evidence', async () => {
  const definition = {
    name: 'system.inspect', version: 1, timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'read_only',
    async executor() {
      const error = new ContractError('inspection_failed', 'inspection failed with password=failure-password');
      error.toolMetadata = { diagnostic: 'auth_token=failure-metadata-token' };
      throw error;
    },
  };
  const governor = new ToolGovernor({
    events: new EventHub(), reviewer: { ledger: { async executionStarted() {}, async settle() {} } },
    registry: { definition: () => definition },
  });
  const request = { id: 'inspect-2', providerCallId: 'provider-inspect-2', toolName: 'system.inspect', definitionVersion: 1 };
  const result = await governor.executePrepared(request, { id: 'decision-inspect-2' }, new AbortController().signal);
  assert.equal(result.status, 'failed');
  assert.equal(result.content, 'inspection failed with password=[redacted]');
  assert.deepEqual(result.metadata, { diagnostic: 'auth_token=[redacted]' });
  assert.doesNotMatch(JSON.stringify(result), /failure-password|failure-metadata-token/u);
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

test('governor preserves bounded executor-owned failure metadata', async () => {
  const definition = {
    name: 'web.browse', version: 1, timeoutMs: 1000, maxOutputBytes: 4096, sideEffect: 'unknown',
    async executor() {
      const error = new ContractError('browser_action_timeout', 'browser action "fill" timed out');
      error.toolMetadata = { action: 'fill', failure_kind: 'timeout', error_name: 'TimeoutError' };
      throw error;
    },
  };
  const governor = new ToolGovernor({
    events: new EventHub(), reviewer: { ledger: { async executionStarted() {}, async settle() {} } },
    registry: { definition: () => definition },
  });
  const request = { id: 'browse-1', providerCallId: 'provider-1', toolName: 'web.browse', definitionVersion: 1 };
  const result = await governor.executePrepared(request, { id: 'decision-1' }, new AbortController().signal);
  assert.equal(result.reason_code, 'browser_action_timeout');
  assert.deepEqual(result.metadata, {
    action: 'fill', failure_kind: 'timeout', error_name: 'TimeoutError',
  });
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
