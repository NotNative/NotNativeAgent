// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEngine } from '../src/engine.js';
import { resolveManifest } from '../src/config.js';
import { MandatoryReviewer } from '../src/reviewer.js';
import { ReviewerLedger } from '../src/persistence/reviewer-ledger.js';
import { JournalStore } from '../src/store.js';
import { ContractError } from '../src/ids.js';
import { denialResult } from '../src/tools/governor.js';
import { supportDiagnosticSummary } from '../src/support-diagnostic-fields.js';
import { reserveToolAdmission } from '../src/tools/admission.js';
import { AuthorityRecord } from '../src/authority.js';

const reviewContext = { authority: { id: 'authority', intent: [{ content: 'Write target.txt', sequence: 1 }], mission: null },
  definition: { name: 'fs_write_text', sideEffect: 'reversible', scope: 'workspace' }, surface: 'headless' };
function mutationRequest(id) {
  return { id, providerCallId: id, toolName: 'fs_write_text', args: { path: 'target.txt', content: 'after', expected_sha256: null },
    resolved: { path: 'D:/workspace/target.txt', exists: false }, authorityId: 'authority', authorityVersion: 1,
    policyVersion: 1, definitionVersion: 1, caller: 'primary', expiresAt: Date.now() + 60000 };
}
test('admission diagnostics distinguish malformed attempts and reused results', async () => {
  const events = []; const config = resolveManifest({
    provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' },
  });
  const authority = new AuthorityRecord(); const active = { authority: authority.snapshot(config), turnId: 'turn', stepId: 'step' };
  await reserveToolAdmission({ config, authority, telemetry: { record: (...args) => events.push(args) } }, active, [
    { request: { id: 'valid' } }, { result: { status: 'invalid_request' } }, { duplicate: true, result: { status: 'succeeded' } },
  ], async () => assert.fail('a non-mission reserves no durable mission budget'));
  assert.deepEqual(supportDiagnosticSummary(events[0][2]), {
    attempted_calls: 3, admitted_calls: 1, invalid_calls: 1, reused_calls: 1,
  });
  assert.equal(events[0][2].reserved_tool_calls, null);
});
test('reviewer deadline stays distinct, aborts work, and does not poison a later authorization', async () => {
  const events = []; let available = false; let aborted = false;
  const reviewer = new MandatoryReviewer({ ledger: new ReviewerLedger({ durable: false, sessionId: 'timeout-audit' }),
    semanticTimeoutMs: 15, telemetry: { record: (...args) => events.push(args) },
    semanticReviewer: { review(_input, signal) {
      if (available) return { outcome: 'approve', confidence: 1, reason_code: 'authorized', authority_anchors: [1] };
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        aborted = true; reject(new Error('aborted provider'));
      }, { once: true }));
    } } });
  const decision = await reviewer.review(mutationRequest('timeout-1'), reviewContext);
  assert.equal(decision.outcome, 'deny_with_guidance');
  assert.equal(decision.reasonCode, 'semantic_review_timeout');
  assert.equal(aborted, true);
  assert.match(decision.guidance, /15.*ms/u);
  const terminal = events.find(([name, status]) => name === 'review.decision' && status === 'timed_out');
  assert.equal(terminal[2].timeout_ms, 15);
  assert.ok(terminal[3].durationMs >= 0);
  assert.equal(supportDiagnosticSummary(terminal[2]).timeout_ms, 15);
  assert.equal(denialResult(mutationRequest('timeout-1'), decision).metadata.user_clarification, false);
  available = true;
  assert.equal((await reviewer.review(mutationRequest('timeout-2'), reviewContext)).outcome, 'approve');
});
test('operator cancellation is not reported as a reviewer deadline', async () => {
  const events = []; const controller = new AbortController();
  const reviewer = new MandatoryReviewer({ ledger: new ReviewerLedger({ durable: false, sessionId: 'cancel-audit' }),
    semanticTimeoutMs: 500, telemetry: { record: (...args) => events.push(args) },
    semanticReviewer: { async review() { controller.abort(); return new Promise(() => {}); } } });
  await assert.rejects(reviewer.review(mutationRequest('cancel'), { ...reviewContext, signal: controller.signal }), { code: 'turn_cancelled' });
  assert.equal(events.some(([, status]) => status === 'timed_out'), false);
});

function call(id, args) { return { index: 0, id, function: { name: 'fs_read', arguments: JSON.stringify(args) } }; }
async function runMission(batches, options = {}) {
  const { missionOverrides = {}, ...engineOptions } = options;
  const root = await mkdtemp(join(tmpdir(), 'nna-admission-audit-')); const output = []; let requests = 0;
  await writeFile(join(root, 'read.txt'), 'read evidence', 'utf8');
  await writeFile(join(root, 'second.txt'), 'second evidence', 'utf8');
  const mission = { id: 'one-call', outcome: 'Read read.txt', not_before: '2020-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z', revocation_id: 'one-call-1', resources: ['workspace'], targets: ['scope:workspace'],
    side_effects: ['read_only'], credential_refs: [], bounds: { max_turns: 2, max_tool_calls: 1, max_duration_ms: 60000 },
    termination: { suspend_on: [], terminate_on: ['budget_exhaustion', 'expiration', 'disconnect'] }, ...missionOverrides };
  const engine = new SessionEngine({ telemetry: false, hookRoot: join(root, 'hooks'), skillRoots: [], storeRoot: join(root, 'sessions'),
    output: async (item) => output.push(item),
    config: resolveManifest({ persistence: options.storeFactory ? 'durable' : 'ephemeral', workspace_root: root, dream: { enabled: false },
      provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' }, mission },
    { missionPrincipal: 'authenticated-stdio-host' }),
    modelRuntime: { resolve: async () => ({ contextWindowTokens: 300000, outputLimitTokens: 32000, source: 'fixture' }) },
    ...engineOptions,
    providerFactory: () => ({ async *stream() {
      const batch = batches[requests++];
      if (batch) { yield { type: 'tool_fragment', fragments: batch }; yield { type: 'terminal', finishReason: 'tool_calls' }; }
      else { yield { type: 'text', text: 'Read complete.' }; yield { type: 'terminal', finishReason: 'stop' }; }
    } }) });
  try {
    await engine.initialize();
    const result = await engine.submit({ request_id: 'mission-test', content: 'Read read.txt' }, 'operator');
    return { result, usage: engine.authority.missionUsage('one-call'), output, transcript: engine.transcript,
      review: engine.reviewerAudit() };
  } finally { await engine.shutdown({ type: 'shutdown', request_id: 'shutdown' }); await rm(root, { recursive: true, force: true }); }
}
test('invalid schema can be corrected within a one-request mission budget', async () => {
  const observed = await runMission([[call('invalid', {})], [call('valid', { path: 'read.txt' })]]);
  assert.equal(observed.result.outcome, 'completed');
  assert.equal(observed.usage.toolCalls, 1);
  assert.equal(observed.transcript.filter((item) => item.type === 'tool_result' && item.toolLifecycleStatus === 'succeeded').length, 1);
  assert.equal(observed.review.length, 1);
});
test('settled duplicate results do not consume another mission reservation', async () => {
  const observed = await runMission([[call('read', { path: 'read.txt' })], [call('read', { path: 'read.txt' })]]);
  assert.equal(observed.result.outcome, 'completed');
  assert.equal(observed.usage.toolCalls, 1);
  assert.equal(observed.review.length, 1);
  assert.equal(observed.output.filter((item) => item.status === 'duplicate_ignored').length, 1);
});
test('an over-budget valid batch executes no partial subset', async () => {
  const observed = await runMission([[call('first', { path: 'read.txt' }), { ...call('second', { path: 'second.txt' }), index: 1 }]]);
  assert.equal(observed.result.outcome, 'failed');
  assert.equal(observed.result.failure.code, 'mission_terminated');
  assert.equal(observed.usage.toolCalls, 0);
  assert.equal(observed.review.length, 0);
  assert.equal(observed.output.some((item) => item.status === 'running'), false);
});
test('a failed durable reservation prevents review and execution', async () => {
  class ReservationFailureStore extends JournalStore {
    async append(type, payload) {
      if (type === 'mission_tool_calls_reserved') throw new ContractError('persistence_unavailable', 'reservation failed');
      return super.append(type, payload);
    }
  }
  const observed = await runMission([[call('read', { path: 'read.txt' })]], {
    storeFactory: (root, id, options) => new ReservationFailureStore(root, id, options),
  });
  assert.equal(observed.result.outcome, 'failed');
  assert.equal(observed.result.failure.code, 'persistence_unavailable');
  assert.equal(observed.usage.toolCalls, 0);
  assert.equal(observed.review.length, 0);
  assert.equal(observed.output.some((item) => item.status === 'running'), false);
});
test('a valid denied request retains its consumed mission reservation', async () => {
  const observed = await runMission([[call('read', { path: 'read.txt' })]], { missionOverrides: {
    targets: ['tool:fs_list'],
    termination: { suspend_on: [], terminate_on: ['budget_exhaustion', 'expiration', 'disconnect', 'review_denial'] },
  } });
  assert.equal(observed.result.outcome, 'failed');
  assert.equal(observed.result.failure.code, 'mission_terminated');
  assert.equal(observed.usage.toolCalls, 1);
  assert.equal(observed.review.length, 1);
  assert.equal(observed.output.some((item) => item.status === 'running'), false);
});
