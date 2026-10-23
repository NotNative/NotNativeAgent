// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { userDataPaths } from '../src/product.js';
import { join } from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventHub } from '../src/events.js';
import { JournalStore } from '../src/store.js';
import { CanonicalIngress } from '../src/ingress.js';
import { declaredSubscription } from './event-fixture.js';
import { completionAdvisories, evaluateCompletion, requestsInput } from '../src/reliability/completion-supervisor.js';

const EMPTY_HOOK_ROOT = join(process.cwd(), '.nna-test-hooks-none');

test('context-reset language is advisory while a clean stop completes normally', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [{ action: 'compact' }] },
  };
  const result = evaluateCompletion(active, "I'm ready to help! What would you like me to assist you with?");
  assert.equal(result.disposition, 'completed');
  assert.equal(result.category, 'settled_output');
  assert.ok(completionAdvisories("I'm ready to help! What would you like me to assist you with?")
    .includes('task_context_reset_language'));
});

test('completion supervision continues when provider usage reaches a mislabeled output ceiling', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, attemptOutputLimitTokens: 32_000,
    attemptUsage: { prompt_tokens: 6_549, completion_tokens: 32_000, total_tokens: 38_549 },
  };
  const result = evaluateCompletion(active, 'I will verify the exact API details next.');
  assert.equal(result.disposition, 'continue');
  assert.equal(result.category, 'truncated_output');
});

test('the truncation gate fingerprints the attempt output policy, not the discarded tail wording', () => {
  const active = {
    finishReason: 'length', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, attemptOutputLimitTokens: 32_000, attemptUsage: null,
  };
  const one = evaluateCompletion(active, 'Partial analysis beginning: the service layer ');
  const two = evaluateCompletion(active, 'Entirely different discarded tail wording instead. ');
  assert.equal(one.disposition, 'continue');
  assert.equal(one.category, 'truncated_output');
  assert.equal(two.progressEvidence.value, one.progressEvidence.value);
  assert.equal(one.progressEvidence.detail.kind, 'output_ceiling');
  assert.equal(one.progressEvidence.detail.checkpoint, 'partial_assistant_message_committed');
  assert.deepEqual(one.progressEvidence.detail.summary.output_limit_tokens, 32_000);
  assert.equal(one.progressEvidence.detail.summary.output_bytes > 0, true);
  assert.equal(one.progressEvidence.value, 'output_ceiling:32000');
  const unbounded = evaluateCompletion({ ...active, attemptOutputLimitTokens: null }, 'The request tails off.');
  assert.equal(unbounded.progressEvidence.value, 'output_ceiling:length_stop');
});

test('structured terminal declarations drive disposition without treating state prose as input requests', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, terminalDeclaration: { outcome: 'needs_input' },
  };
  assert.equal(requestsInput('The fix is in place. Shipping requires a version bump.'), false);
  assert.equal(requestsInput('The audit covered 335 modules. Two release gates are missing.'), false);
  assert.deepEqual(evaluateCompletion(active, 'The dependency is not selected.'), {
    disposition: 'needs_input', category: 'declared_input_required',
  });
  active.terminalDeclaration = { outcome: 'completed' };
  assert.deepEqual(evaluateCompletion(active, 'The result is ready.'), {
    disposition: 'completed', category: 'declared_completion',
  });
});

test('an unresolved tool failure cannot disappear behind calm prose or a completion declaration', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: ['edit_failed'],
    recovery: { actions: [] }, terminalDeclaration: { outcome: 'completed' },
  };
  assert.deepEqual(evaluateCompletion(active, 'The remaining report is calm.'), {
    disposition: 'continue', category: 'unresolved_tool_failure', required: true, progressEvidence: null,
  });
  active.terminalDeclaration = null;
  assert.deepEqual(evaluateCompletion(active, 'No authorized route remains.'), {
    disposition: 'incomplete', category: 'terminal_declaration_missing',
  });
});

test('future-action language is advisory and does not override a clean stop', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, attemptOutputLimitTokens: 32_000,
    attemptUsage: { completion_tokens: 200 },
  };
  const result = evaluateCompletion(active,
    'I will build the scene. Before writing it, let me verify the exact API details.');
  assert.equal(result.disposition, 'completed');
  assert.equal(result.category, 'settled_output');
  assert.ok(completionAdvisories('I will build the scene. Before writing it, let me verify the exact API details next.')
    .includes('future_action_language'));
});

test('reviewer-ledger evidence prevents a clean stop from hiding an unresolved tool outcome', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    correctableToolFailures: [], recovery: { actions: [] }, reviewerCompletion: {
      schema: 'nna.reviewer-completion.v1', unresolved_count: 1,
      unresolved: [{ tool: 'fs_write_text', state: 'failed', effect_certainty: 'unknown' }],
    },
  };
  const pending = evaluateCompletion(active, 'Retrying now.');
  assert.equal(pending.disposition, 'continue');
  assert.equal(pending.category, 'unresolved_reviewed_tool_outcome');
  assert.match(pending.hint, /reviewer ledger contains unresolved tool outcomes/u);
  active.terminalDeclaration = { outcome: 'blocked' };
  assert.deepEqual(evaluateCompletion(active, 'The reviewer remains unavailable.'), {
    disposition: 'blocked', category: 'reviewed_tool_outcome_blocked',
  });
});

test('settled structured state accepts a clean stop after tool use without self-attestation', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    correctableToolFailures: [], recovery: { actions: [] }, reviewerCompletion: null,
  };
  const result = evaluateCompletion(active, 'Writing the files now, starting with the index.');
  assert.equal(result.disposition, 'completed');
  assert.equal(result.category, 'settled_output');
  active.terminalDeclaration = { outcome: 'completed' };
  assert.deepEqual(evaluateCompletion(active, 'The requested response is complete.'), {
    disposition: 'completed', category: 'declared_completion',
  });
});

test('operator-directed closing idioms are not reported as future task work', () => {
  const text = 'The requested change is complete. Let me know if you need anything else.';
  assert.equal(completionAdvisories(text).includes('future_action_language'), false);
});

test('completion advisories recognize Markdown-wrapped future action language', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, toolEvidenceRevision: 4,
  };
  const text = 'Node and npx are available. I\'ll **bundle everything into one self-contained `index.html`**. Setting up the build structure now.';
  assert.ok(completionAdvisories(text).includes('future_action_language'));
  assert.equal(evaluateCompletion(active, text).disposition, 'completed');
});

test('legacy prose obligations cannot override a typed terminal declaration', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, toolEvidenceRevision: 4,
    completionObligation: { kind: 'future_action', evidenceRevision: 4 }, terminalDeclaration: { outcome: 'completed' },
  };
  assert.deepEqual(evaluateCompletion(active, 'The requested work is complete.'), {
    disposition: 'completed', category: 'declared_completion',
  });
});

test('completion supervision accepts a settled result with optional future availability', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, attemptOutputLimitTokens: 32_000, terminalDeclaration: { outcome: 'completed' },
    attemptUsage: { completion_tokens: 200 },
  };
  const result = evaluateCompletion(active, 'The requested change is complete. I will remain available for follow-up.');
  assert.equal(result.disposition, 'completed');
  assert.equal(result.category, 'declared_completion');
});

test('completion supervision settles an explicit terminal blocker without reporting completion', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, attemptOutputLimitTokens: 32_000, terminalDeclaration: { outcome: 'blocked' },
    attemptUsage: { completion_tokens: 200 },
  };
  const result = evaluateCompletion(active, "I can't complete this because the required host capability is unavailable.");
  assert.equal(result.disposition, 'blocked');
  assert.equal(result.category, 'declared_terminal_blocker');

  active.terminalDeclaration = null;
  const alternative = evaluateCompletion(active, "I can't continue with that route. I will try a different bounded operation now.");
  assert.equal(alternative.disposition, 'completed');
  assert.ok(completionAdvisories("I can't continue with that route. I will try a different bounded operation now.")
    .includes('future_action_language'));
});

test('completion supervision accepts a typed blocker while durable work remains active', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, terminalDeclaration: { outcome: 'blocked' },
  };
  const work = {
    revision: 2, goal: { status: 'active' },
    tasks: [{ id: 'T1', status: 'blocked' }],
  };
  const unrecorded = evaluateCompletion(active, "I can't complete this because the dependency is unavailable.", work);
  assert.equal(unrecorded.disposition, 'blocked');
  assert.equal(unrecorded.category, 'declared_terminal_blocker');

  work.goal.status = 'blocked';
  const recorded = evaluateCompletion(active, 'The dependency remains unavailable.', work);
  assert.equal(recorded.disposition, 'blocked');
  assert.equal(recorded.category, 'recorded_work_blocker');
});

test('typed completion cannot erase a newer material non-pass visual verdict', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [] }, visualEvidence: { verdict: 'fail', path: 'latest.png' },
    terminalDeclaration: { outcome: 'completed' },
  };
  const contradicted = evaluateCompletion(active,
    'The detailed DOM inspection confirms there are no real visible artifacts. The task is complete.');
  assert.equal(contradicted.disposition, 'continue');
  assert.equal(contradicted.category, 'visual_evidence_conflict');
  assert.match(contradicted.hint, /newer screenshot and image_inspect|qualified description/iu);

  active.visualEvidence.verdict = 'minor_caveat';
  assert.equal(evaluateCompletion(active, 'A minor seam remains.').disposition, 'completed');
});

function config(persistence = 'ephemeral') {
  return resolveManifest({
    persistence,
    provider: {
      id: 'test', endpoint: 'http://127.0.0.1:9999/v1',
      model: 'fixture-model', trust_zone: 'loopback',
    },
  });
}

function finishCall(outcome, detail = {}) {
  return [
    { type: 'tool_fragment', fragments: [{
      index: 0, id: `finish-${outcome}`, function: {
        name: 'turn_finish', arguments: JSON.stringify({ outcome, ...detail }),
      },
    }] },
    { type: 'terminal', finishReason: 'tool_calls' },
  ];
}

function hasFinishCall(request) {
  return request.messages?.some((message) => message.tool_calls
    ?.some((call) => call.function?.name === 'turn_finish')) === true;
}

class ScriptedProvider {
  async *stream(request) {
    if (!hasFinishCall(request)) { yield* finishCall('completed'); return; }
    yield { type: 'text', text: 'Hello' };
    yield { type: 'text', text: ', operator.' };
    yield { type: 'usage', usage: { total_tokens: 7 } };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  }
}

test('parallel turn_finish declarations cannot choose a same-step outcome by execution order', async () => {
  const engine = new SessionEngine({ config: config(), providerFactory: () => new ScriptedProvider(),
    hookRoot: EMPTY_HOOK_ROOT });
  await engine.initialize();
  engine.active = { turnId: 'turn-1', stepId: 'step-1', terminalDeclaration: null };
  const finish = engine.tools.definition('turn_finish');
  const signal = new AbortController().signal;
  const request = async (value) => ({ args: (await finish.validate(value)).args });
  const [first, conflicting] = await Promise.allSettled([
    request({ outcome: 'needs_input', question: 'Which target?' }).then((value) => finish.executor(value, signal)),
    request({ outcome: 'blocked', reason_code: 'target_unknown' }).then((value) => finish.executor(value, signal)),
  ]);
  assert.equal(first.status, 'fulfilled', String(first.reason?.stack));
  assert.equal(conflicting.status, 'rejected');
  assert.equal(conflicting.reason.code, 'turn_declaration_conflict');
  assert.equal(engine.active.terminalDeclaration.outcome, 'needs_input');

  const repeated = await finish.executor(await request({ outcome: 'needs_input', question: 'Which target?' }), signal);
  assert.equal(repeated.metadata.declared_outcome, 'needs_input');
  engine.active.stepId = 'step-2';
  const later = await finish.executor(await request({ outcome: 'blocked', reason_code: 'target_unknown' }), signal);
  assert.equal(later.metadata.declared_outcome, 'blocked');
  assert.equal(engine.active.terminalDeclaration.declaredAtStepId, 'step-2');
  engine.active = null;
  await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: 'shutdown-finish-conflict' });
});

test('a conflicting turn_finish batch cannot settle the first declaration', async () => {
  let calls = 0;
  const provider = {
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield { type: 'tool_fragment', fragments: [
          { index: 0, id: 'finish-input', function: { name: 'turn_finish', arguments: JSON.stringify({ outcome: 'needs_input', question: 'Which target?' }) } },
          { index: 1, id: 'finish-blocked', function: { name: 'turn_finish', arguments: JSON.stringify({ outcome: 'blocked', reason_code: 'target_unknown' }) } },
        ] };
        yield { type: 'terminal', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', text: 'The declarations conflicted; no terminal outcome was selected.' };
      yield { type: 'terminal', finishReason: 'stop' };
    },
  };
  const engine = new SessionEngine({ config: config(), providerFactory: () => provider,
    hookRoot: EMPTY_HOOK_ROOT });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'request-finish-conflict', content: 'Check the result' }, 'operator');
  assert.equal(calls, 2);
  assert.equal(result.outcome, 'completed');
  assert.equal(engine.active, null);
  const results = engine.transcript.filter((item) => item.type === 'tool_result' && item.toolName === 'turn_finish');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((item) => item.toolLifecycleStatus), ['succeeded', 'failed']);
  assert.equal(results[1].reasonCode, 'turn_declaration_conflict');
  await engine.shutdown({ version: '1.0', type: 'shutdown', request_id: 'shutdown-finish-batch-conflict' });
});

test('AC-ENGP-01/AC-STATE-05/M1 successful turn finalizes exactly once', async () => {
  const output = [];
  const engine = new SessionEngine({
    config: config(), providerFactory: () => new ScriptedProvider(),
    hookRoot: EMPTY_HOOK_ROOT,
    output: async (record) => output.push(record),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'request-1', content: 'Say hello' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.text, 'Hello, operator.');
  assert.equal(engine.state.state, 'idle');
  assert.equal(output[0].type, 'accepted');
  assert.deepEqual(output.filter((item) => item.type === 'stream_delta').map((item) => item.text), ['Hello', ', operator.']);
  assert.equal(output.at(-1).type, 'turn_result');
  assert.deepEqual(output.at(-1).completion_evidence, {
    schema: 'nna.completion-evidence.v1', tool_requests: 0, tool_results: 0,
    succeeded: 0, non_success: 0, unique_files_read: 0, project_verifications: 0, tool_names: [],
  });
  const records = engine.lifecycles.snapshot();
  assert.ok(records.length > 3);
  assert.equal(records.filter((item) => item.kind === 'turn' && item.phase === 'terminal').length, 1);
  assert.equal(records.find((item) => item.kind === 'turn')?.outcome, 'completed');
  assert.equal(engine.transcript.length, 4);
});

test('AC-TURN-01/AC-STATE-05 accepted identity precedes I/O and a pre-turn veto finalizes once', async () => {
  const events = new EventHub();
  events.register(declaredSubscription({
    id: 'policy-veto', category: 'turn', phase: 'pre', blocking: true,
    priority: -100, timeoutMs: 100, failurePolicy: 'deny',
  }), async () => ({ decision: 'deny', code: 'fixture_policy_veto' }));
  let providerCalls = 0;
  const output = [];
  const engine = new SessionEngine({
    config: config(), events,
    providerFactory: () => ({ async *stream() { providerCalls += 1; yield { type: 'terminal' }; } }),
    output: async (record) => output.push(record),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'veto-turn', content: 'Perform the vetoed task' }, 'operator');
  const accepted = output.find((item) => item.type === 'accepted');
  assert.equal(accepted.turn_id, result.turn_id);
  assert.equal(providerCalls, 0);
  assert.equal(result.outcome, 'denied');
  assert.equal(result.failure.code, 'pre_turn_denied');
});

test('AC-SESS-04 ephemeral session leaves no resumable transcript, reviewer ledger, or derived memory artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-ephemeral-artifacts-'));
  const sessions = join(root, 'sessions');
  const reviewer = join(root, 'reviewer');
  let memoryWrites = 0;
  const memoryAdapter = {
    async query() { return []; },
    async save() { memoryWrites += 1; },
  };
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'ephemeral', workspace_root: root, memory: { enabled: true },
      provider: { endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' },
    }),
    sessionId: 'ephemeral-session', storeRoot: sessions, reviewerRoot: reviewer,
    memoryAdapter, providerFactory: () => new ScriptedProvider(),
  });
  assert.equal(engine.tools.diagnosticContext().sessionsRoot, sessions);
  await engine.initialize();
  await engine.submit({ request_id: 'ephemeral-turn', content: 'Keep this turn ephemeral' }, 'operator');
  await engine.shutdown({ request_id: 'ephemeral-stop', type: 'shutdown' });
  await assert.rejects(readFile(join(sessions, 'ephemeral-session.journal.ndjson')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(reviewer, 'ephemeral-session.review.journal.ndjson')), { code: 'ENOENT' });
  assert.equal(memoryWrites, 0);
});

test('engine defaults stay within supplied data paths when individual roots are omitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-engine-data-paths-'));
  const dataPaths = {
    sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer-ledger'),
    governanceLedger: join(root, 'governance-ledger'), hooks: join(root, 'hooks'),
    webSearchConfig: join(root, 'web-search.json'), webFetchConfig: join(root, 'web-fetch.json'),
  };
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'durable', workspace_root: root,
      provider: { endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' },
    }),
    sessionId: 'data-path-defaults', dataPaths, providerFactory: () => new ScriptedProvider(),
  });
  assert.equal(engine.storeRoot, dataPaths.sessions);
  assert.equal(engine.reviewerRoot, dataPaths.reviewerLedger);
  assert.equal(engine.governanceRoot, dataPaths.governanceLedger);
  assert.equal(engine.hooks.root, dataPaths.hooks);
  assert.equal(engine.tools.webSearchConfigPath, dataPaths.webSearchConfig);
  assert.equal(engine.tools.webFetchConfigPath, dataPaths.webFetchConfig);
  assert.equal(engine.tools.diagnosticContext().sessionsRoot, dataPaths.sessions);
});

test('partial engine data paths retain explicit governance and diagnostics defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-engine-partial-data-paths-'));
  const sessions = join(root, 'sessions');
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'durable', workspace_root: root,
      provider: { endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' },
    }),
    sessionId: 'partial-data-paths', dataPaths: { sessions }, providerFactory: () => new ScriptedProvider(),
  });
  assert.equal(engine.governanceRoot, userDataPaths().governanceLedger);
  assert.equal(engine.tools.diagnosticContext().sessionsRoot, sessions);
});

test('a selected data root supplies omitted engine paths without overriding explicit paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-engine-selected-root-'));
  const sessions = join(root, 'override-sessions');
  const expected = userDataPaths({ environment: { NNA_HOME: root } });
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'durable', workspace_root: root,
      provider: { endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' },
    }),
    sessionId: 'selected-root', dataPaths: { root, sessions }, providerFactory: () => new ScriptedProvider(),
  });
  assert.equal(engine.storeRoot, sessions);
  assert.equal(engine.governanceRoot, expected.governanceLedger);
  assert.equal(engine.reviewerRoot, expected.reviewerLedger);
  assert.equal(engine.hooks.root, expected.hooks);
  assert.equal(engine.dataPaths.modelDialects, expected.modelDialects);
  assert.deepEqual(engine.skills.roots, [{ scope: 'user', path: expected.skills }]);
  assert.equal(engine.tools.webSearchConfigPath, expected.webSearchConfig);
  assert.equal(engine.tools.webFetchConfigPath, expected.webFetchConfig);
  assert.equal(engine.tools.browserRoot, join(root, 'runtime', 'browser', 'selected-root'));
  assert.equal(engine.tools.diagnosticContext().sessionsRoot, sessions);
});

test('AC-FAIL-02 whole-runtime shutdown has its own typed deadline', async () => {
  const manifest = {
    persistence: 'ephemeral', shutdown_timeout_ms: 100,
    provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' },
  };
  const output = [];
  const engine = new SessionEngine({
    config: resolveManifest(manifest), providerFactory: () => new ScriptedProvider(),
    hookRoot: EMPTY_HOOK_ROOT, output: async (record) => output.push(record),
  });
  await engine.initialize();
  engine.events.close = () => new Promise(() => undefined);
  await assert.rejects(engine.shutdown({ request_id: 'bounded-shutdown' }), { code: 'shutdown_timeout' });
  assert.equal(output.some((item) => item.type === 'shutdown_complete'), false);
});

test('AC-FAIL-02 shutdown timeout retains the durable lock until journal cleanup settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-shutdown-lock-'));
  const options = {
    config: resolveManifest({
      persistence: 'durable', workspace_root: root, shutdown_timeout_ms: 100,
      provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' },
    }),
    sessionId: 'shutdown-lock-session', storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => new ScriptedProvider(), hookRoot: EMPTY_HOOK_ROOT,
  };
  const first = new SessionEngine(options);
  await first.initialize();
  let finishEventCleanup;
  first.events.close = () => new Promise((resolve) => { finishEventCleanup = resolve; });
  const originalRelease = first.lock.release.bind(first.lock);
  let observeRelease;
  const released = new Promise((resolve) => { observeRelease = resolve; });
  first.lock.release = async () => { await originalRelease(); observeRelease(); };
  await assert.rejects(first.shutdown({ request_id: 'bounded-durable-shutdown' }), { code: 'shutdown_timeout' });

  const recovered = new SessionEngine(options);
  await assert.rejects(recovered.initialize(), { code: 'session_locked' });
  finishEventCleanup();
  await released;
  await recovered.initialize();
  await recovered.shutdown({ request_id: 'recovered-shutdown' });
});

test('AC-FAIL-05 startup preserves its primary failure and releases ownership after cleanup faults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-startup-cleanup-'));
  const options = {
    config: resolveManifest({
      persistence: 'durable', workspace_root: root,
      provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' },
    }),
    sessionId: 'startup-cleanup-session', storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => new ScriptedProvider(), hookRoot: EMPTY_HOOK_ROOT,
  };
  const first = new SessionEngine(options);
  const primary = Object.assign(new Error('private tool startup detail'), { code: 'tool_start_failed' });
  first.tools.initialize = async () => { throw primary; };
  first.hooks.close = () => { throw new Error('secondary hook cleanup detail'); };
  await assert.rejects(first.initialize(), primary);

  const recovered = new SessionEngine(options);
  await recovered.initialize();
  await recovered.shutdown({ request_id: 'startup-recovered-shutdown' });
});

test('AC-FAIL-05 shutdown attempts peer cleanup and surfaces a component failure', async () => {
  const output = [];
  const engine = new SessionEngine({
    config: config(), providerFactory: () => new ScriptedProvider(), hookRoot: EMPTY_HOOK_ROOT,
    output: async (record) => output.push(record),
  });
  await engine.initialize();
  let peerClosed = false;
  const failure = Object.assign(new Error('private event cleanup detail'), { code: 'event_close_failed' });
  engine.events.close = () => { throw failure; };
  engine.attachments.close = async () => { peerClosed = true; };

  await assert.rejects(engine.shutdown({ request_id: 'failed-cleanup', type: 'shutdown' }), failure);
  assert.equal(peerClosed, true);
  assert.equal(output.some((item) => item.type === 'shutdown_complete'), false);
});

test('shutdown still aborts and closes peers after cancellation status fails', async () => {
  const engine = new SessionEngine({
    config: config(), providerFactory: () => new ScriptedProvider(), hookRoot: EMPTY_HOOK_ROOT,
  });
  await engine.initialize();
  const controller = new AbortController();
  engine.active = { controller, completion: Promise.resolve() };
  const failure = Object.assign(new Error('status delivery failed'), { code: 'status_delivery_failed' });
  engine.cancel = async () => { throw failure; };
  let peerClosed = false;
  engine.attachments.close = async () => { peerClosed = true; };
  await assert.rejects(engine.shutdown({ request_id: 'cancel-status-failed', type: 'shutdown' }), failure);
  assert.equal(controller.signal.aborted, true);
  assert.equal(peerClosed, true);
});

test('shutdown waits for deferred MCP initialization even when MCP close fails', async () => {
  const engine = new SessionEngine({
    config: config(), providerFactory: () => new ScriptedProvider(), hookRoot: EMPTY_HOOK_ROOT,
  });
  await engine.initialize();
  const failure = Object.assign(new Error('MCP close failed'), { code: 'mcp_close_failed' });
  engine.mcp.close = async () => { throw failure; };
  let finishInitialization;
  engine.mcpInitialization = new Promise((resolve) => { finishInitialization = resolve; });
  let settled = false;
  const shutdown = engine.shutdown({ request_id: 'mcp-close-failed', type: 'shutdown' })
    .finally(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finishInitialization();
  await assert.rejects(shutdown, failure);
});

test('shutdown retains deferred MCP and peer failures behind the primary close failure', async () => {
  const engine = new SessionEngine({
    config: config(), providerFactory: () => new ScriptedProvider(), hookRoot: EMPTY_HOOK_ROOT,
  });
  await engine.initialize();
  const closeFailure = Object.assign(new Error('MCP close failed'), { code: 'mcp_close_failed' });
  engine.mcp.close = async () => { throw closeFailure; };
  engine.mcpInitialization = Promise.reject(Object.assign(new Error('MCP startup failed'), {
    code: 'mcp_start_failed',
  }));
  engine.attachments.close = async () => { throw Object.assign(new Error('attachment close failed'), {
    code: 'attachments_close_failed',
  }); };

  await assert.rejects(engine.shutdown({ request_id: 'multiple-cleanup-failures', type: 'shutdown' }), closeFailure);
  assert.deepEqual(closeFailure.secondaryFailures?.map((failure) => failure.code), [
    'mcp_start_failed', 'attachments_close_failed',
  ]);
});

test('active mission expiration cancels a slow provider and terminates with the declared boundary', async (t) => {
  // Why: mocked deadlines keep engine setup off the tested expiration clock.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const now = Date.now();
  const mission = {
    id: 'expiring-mission', outcome: 'Wait for the bounded provider response.',
    not_before: new Date(now - 1_000).toISOString(), expires_at: new Date(now + 100).toISOString(),
    revocation_id: 'expiring-mission-1', resources: ['workspace'], targets: ['scope:workspace'],
    side_effects: ['read_only'], credential_refs: [],
    bounds: { max_turns: 2, max_tool_calls: 2, max_duration_ms: 60_000 },
    termination: { suspend_on: [], terminate_on: ['budget_exhaustion', 'expiration', 'disconnect'] },
  };
  let providerAborted = false;
  // Why: record the provider's observed abort at the signal boundary. A pending
  // async-generator body may be closed by the transport without resuming its frame.
  const provider = { stream(_request, signal) {
    signal.addEventListener('abort', () => { providerAborted = true; }, { once: true });
    // Why: dispatch evidence precedes the mocked mission deadline so setup
    // cannot consume it and leave the provider cancellation untested.
    setImmediate(() => t.mock.timers.tick(100));
    return (async function*() {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    providerAborted = true;
    throw Object.assign(new Error('aborted at mission boundary'), { code: 'provider_cancelled' });
    })();
  } };
  const engine = new SessionEngine({
    config: resolveManifest({ persistence: 'ephemeral', provider: {
      id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback',
    }, mission }, { missionPrincipal: 'authenticated-stdio-host' }),
    providerFactory: () => provider, hookRoot: EMPTY_HOOK_ROOT,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'expiring-turn', content: 'Run the bounded mission.' }, 'authenticated-stdio-host');
  assert.equal(providerAborted, true);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failure.code, 'mission_terminated');
  assert.equal(result.failure.cause_code, 'mission_expired');
  assert.equal(result.failure.mission_policy, 'terminate_turn');
});

test('AC-STATE-05 provider failure preserves partial output and finalizes exactly once', async () => {
  class FailingProvider {
    async *stream() {
      yield { type: 'text', text: 'partial' };
      throw Object.assign(new Error('secret detail'), { code: 'socket' });
    }
  }
  const output = [];
  const engine = new SessionEngine({
    config: config(), providerFactory: () => new FailingProvider(),
    output: async (record) => output.push(record),
  });
  const result = await engine.submit({ request_id: 'request-2', content: 'Work' }, 'operator');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.partial, true);
  assert.equal(result.failure.code, 'internal_failure');
  assert.equal(result.failure.category, 'internal');
  assert.equal(result.failure.cause_id, result.turn_id);
  assert.equal(result.failure.partial_data, true);
  assert.equal(result.failure.effect_certainty, 'none');
  assert.equal(output.filter((item) => item.type === 'turn_result').length, 1);
  assert.equal(engine.state.state, 'idle');
});

test('streaming cancellation persists genuinely uncommitted assistant text once', async () => {
  let releaseStarted;
  const started = new Promise((resolve) => { releaseStarted = resolve; });
  const provider = { async *stream(_request, signal) {
    yield { type: 'text', text: 'Useful partial analysis.' };
    releaseStarted();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('cancelled'), { code: 'provider_cancelled' }));
    }, { once: true }));
  } };
  const engine = new SessionEngine({ config: config(), providerFactory: () => provider });
  const turn = engine.submit({ request_id: 'stream-cancel', content: 'Analyze this.' }, 'operator');
  await started;
  await engine.cancel({ request_id: 'cancel-stream' });
  const result = await turn;
  assert.equal(result.outcome, 'cancelled');
  const messages = engine.transcript.filter((item) => item.role === 'assistant');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'Useful partial analysis.');
  assert.equal(messages[0].partial, true);
});

test('AC-FAIL-05 primary failure survives secondary finalization failures', async () => {
  class FailingProvider {
    async *stream() {
      throw new Error('private provider detail');
    }
  }
  const output = [];
  const engine = new SessionEngine({
    config: config(), providerFactory: () => new FailingProvider(),
    hookRoot: EMPTY_HOOK_ROOT, output: async (record) => output.push(record),
  });
  await engine.initialize();
  const originalFinish = engine.lifecycles.finish.bind(engine.lifecycles);
  let injected = false;
  engine.lifecycles.finish = (id, outcome) => {
    if (!injected) {
      injected = true;
      throw new Error('private cleanup detail');
    }
    return originalFinish(id, outcome);
  };
  const result = await engine.submit({ request_id: 'request-faults', content: 'Work' }, 'operator');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failure.code, 'internal_failure');
  assert.equal(result.failure.cause_id, result.turn_id);
  assert.equal(result.secondary_failures.length, 2);
  assert.ok(result.secondary_failures.every((item) => !item.message.includes('private')));
  assert.equal(output.filter((item) => item.type === 'turn_result').length, 1);
  assert.equal(engine.active, null);
});

test('AC-TURN-04/AC-FAIL-01 a genuine model question yields needs_input without stall recovery', async () => {
  class QuestionProvider {
    async *stream(request) {
      if (!hasFinishCall(request)) { yield* finishCall('needs_input', { question: 'Which target should I use?' }); return; }
      yield { type: 'text', text: 'Which target should I use?' };
      yield { type: 'terminal', finishReason: 'stop', usage: null };
    }
  }
  const engine = new SessionEngine({ config: config(), providerFactory: () => new QuestionProvider() });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'request-3', content: 'Proceed' }, 'operator');
  assert.equal(result.outcome, 'needs_input');
  assert.deepEqual(result.recovery, []);
});

test('a conversational offer ending in a question completes without claiming a blocker', async () => {
  let calls = 0;
  class GreetingProvider {
    async *stream() {
      calls += 1;
      yield { type: 'text', text: 'Good morning! How can I help you today?' };
      yield { type: 'terminal', finishReason: 'stop', usage: null };
    }
  }
  const engine = new SessionEngine({ config: config(), providerFactory: () => new GreetingProvider() });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'request-greeting', content: 'Good morning' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(calls, 1);
});

test('active durable work survives a clean turn boundary without forcing continuation', async () => {
  let calls = 0;
  const provider = { async *stream() {
    calls += 1;
    yield { type: 'text', text: 'I gathered the requirements. Which deployment target should we design for?' };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  } };
  const engine = new SessionEngine({ config: config(), providerFactory: () => provider });
  await engine.initialize();
  await engine.setGoal('Design the deployment plan');
  await engine.addTask('Gather requirements');

  const result = await engine.submit({ request_id: 'work-cross-turn', content: 'Start discovery' }, 'operator');

  assert.equal(calls, 1);
  assert.equal(result.outcome, 'completed');
  assert.equal(engine.workStatus().goal.status, 'active');
  assert.equal(engine.workStatus().tasks[0].status, 'pending');
  assert.deepEqual(result.recovery, []);
});

test('assistant text and accepted needs_input declaration settle the same response', async () => {
  let calls = 0;
  const question = 'Which city should host the primary fleet hub?';
  const provider = { async *stream() {
    calls += 1;
    yield { type: 'text', text: question };
    yield* finishCall('needs_input', { question });
  } };
  const engine = new SessionEngine({ config: config(), providerFactory: () => provider });
  await engine.initialize();
  await engine.setGoal('Design the fleet deployment plan');
  await engine.addTask('Gather deployment requirements');

  const result = await engine.submit({ request_id: 'same-response-input', content: 'Continue discovery' }, 'operator');

  assert.equal(calls, 1);
  assert.equal(result.outcome, 'needs_input');
  assert.equal(result.text, question);
  assert.equal(engine.transcript.filter((record) => record.role === 'assistant'
    && record.content === question).length, 1);
  assert.deepEqual(result.recovery, []);
});

test('active durable work cannot turn an assistant authorization question into a synthetic user answer', async () => {
  let calls = 0;
  const provider = { async *stream() {
    calls += 1;
    if (calls === 1) { yield* finishCall('needs_input', { question: 'Want me to start implementing Slice A?' }); return; }
    yield { type: 'text', text: 'The requested audit is complete. Want me to start implementing Slice A?' };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  } };
  const engine = new SessionEngine({ config: config(), providerFactory: () => provider });
  await engine.initialize();
  await engine.setGoal('Audit the codebase without making changes');
  await engine.addTask('Deliver the audit findings');

  const result = await engine.submit({ request_id: 'work-authorization-turn', content: 'Audit the codebase' }, 'operator');

  assert.equal(calls, 2);
  assert.equal(result.outcome, 'needs_input');
  assert.match(result.text, /Want me to start implementing Slice A\?/u);
  assert.equal(result.recovery.some((item) => item.category === 'unfinished_conversation_work'), false);
});

test('active durable work yields when the model genuinely requires operator input', async () => {
  let calls = 0;
  const provider = { async *stream() {
    calls += 1;
    if (calls === 1) { yield* finishCall('needs_input', { question: 'Which deployment target should I use?' }); return; }
    yield { type: 'text', text: 'Which deployment target should I use?' };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  } };
  const engine = new SessionEngine({ config: config(), providerFactory: () => provider });
  await engine.initialize();
  await engine.setGoal('Deploy the application');
  await engine.addTask('Choose and use the deployment target');

  const result = await engine.submit({ request_id: 'work-input-turn', content: 'Deploy it' }, 'operator');

  assert.equal(calls, 2);
  assert.equal(result.outcome, 'needs_input');
  assert.equal(engine.workStatus().tasks[0].status, 'pending');
});

test('a recorded terminal work blocker finalizes the turn without recovery', async () => {
  let calls = 0;
  const provider = { async *stream() {
    calls += 1;
    yield { type: 'text', text: "I can't complete the host operation because the required capability is unavailable." };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  } };
  const engine = new SessionEngine({ config: config(), providerFactory: () => provider });
  await engine.setGoal('Complete the host operation');
  await engine.addTask('Use the required host capability');
  await engine.updateTask('T1', 'blocked', 'The required host capability is unavailable.');
  await engine.blockGoal('No available authorized route can supply the host capability.');

  const result = await engine.submit({ request_id: 'work-blocked-turn', content: 'Finish the host operation' }, 'operator');

  assert.equal(calls, 1);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.recovery.length, 0);
  assert.match(result.text, /can't complete/u);
});

test('AC-EVENT-04/AC-STATE-05 a failing terminal observer cannot prevent one outcome or another observer', async () => {
  const events = new EventHub();
  let remainingObserverRuns = 0;
  events.register(declaredSubscription({ id: 'broken-terminal-observer', category: 'turn', phase: 'terminal', blocking: false }), async () => {
    throw new Error('observer failure');
  });
  events.register(declaredSubscription({ id: 'remaining-terminal-observer', category: 'turn', phase: 'terminal', blocking: false }), async () => {
    remainingObserverRuns += 1;
  });
  const output = [];
  const engine = new SessionEngine({
    config: config(), events, providerFactory: () => new ScriptedProvider(),
    output: async (record) => output.push(record),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'observer-turn', content: 'Respond' }, 'operator');
  await events.drain();
  assert.equal(result.outcome, 'completed');
  assert.equal(output.filter((item) => item.type === 'turn_result').length, 1);
  assert.equal(remainingObserverRuns, 1);
  assert.equal(engine.lifecycles.snapshot().filter((item) => item.kind === 'turn' && item.phase === 'terminal').length, 1);
});

test('AC-STATE-04/AC-STATE-05 cancellation immediately after acceptance starts no work and finalizes once', async () => {
  let providerCalls = 0;
  const output = [];
  let engine;
  engine = new SessionEngine({
    config: config(),
    providerFactory: () => ({ async *stream() { providerCalls += 1; yield { type: 'terminal' }; } }),
    output: async (record) => {
      output.push(record);
      if (record.type === 'accepted') await engine.cancel({ request_id: 'immediate-cancel' });
    },
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'cancel-before-work', content: 'Start work' }, 'operator');
  assert.equal(result.outcome, 'cancelled');
  assert.equal(providerCalls, 0);
  assert.equal(output.filter((item) => item.type === 'turn_result').length, 1);
  assert.equal(engine.state.state, 'idle');
});

test('AC-STATE-05 output-consumer disconnect still durably commits one terminal outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-output-disconnect-'));
  const stores = join(root, 'sessions');
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'durable', workspace_root: root,
      provider: { id: 'test', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture-model', trust_zone: 'loopback' },
    }),
    sessionId: 'output-disconnect', storeRoot: stores, reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => new ScriptedProvider(),
    output: async (record) => {
      if (record.type === 'turn_result') throw new Error('consumer disconnected');
    },
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'disconnect-turn', content: 'Respond' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(result.secondary_failures.some((item) => item.boundary === 'output'), true);
  await engine.shutdown({ request_id: 'disconnect-stop' });
  const recovered = new JournalStore(stores, 'output-disconnect');
  const journal = await recovered.open();
  assert.equal(journal.records.filter((item) => item.type === 'turn_outcome').length, 1);
  await recovered.close();
});

test('AC-FAIL-08 conflicting provider terminal data cannot execute tools', async () => {
  class ConflictingProvider {
    async *stream() {
      yield { type: 'terminal', finishReason: 'stop' };
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'late-call', function: { name: 'fs_delete_file', arguments: '{}' },
      }] };
    }
  }
  const engine = new SessionEngine({
    config: config(), providerFactory: () => new ConflictingProvider(),
    hookRoot: EMPTY_HOOK_ROOT,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'invalid-provider', content: 'Work' }, 'operator');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.failure.code, 'provider_conflicting_terminal');
  assert.equal(engine.reviewerAudit().length, 0);
  assert.equal(engine.transcript.some((item) => item.type === 'tool_request'), false);
});

test('review bypass keys are rejected from authenticated manifests', () => {
  assert.throws(() => resolveManifest({
    skip_review: true,
    provider: { endpoint: 'http://127.0.0.1:1/v1', model: 'x', trust_zone: 'loopback' },
  }), { code: 'review_floor_violation' });
});

test('AC-ARCH-01/AC-PROD-02 provider adapters and input surfaces preserve canonical semantics', async () => {
  const run = async (surface, providerLabel) => {
    let calls = 0;
    const engine = new SessionEngine({
      config: config(), surface,
      providerFactory: () => ({ async *stream() {
        calls += 1;
        if (calls === 1) { yield* finishCall('completed'); return; }
        yield { type: 'metadata', finishReason: providerLabel };
        yield { type: 'text', text: 'Equivalent response.' };
        yield { type: 'terminal', finishReason: 'stop' };
      } }),
    });
    await engine.initialize();
    const ingress = new CanonicalIngress(engine, { interactive: surface === 'interactive_tui' });
    const result = await ingress.submit({
      version: '1.0', type: 'submit', request_id: `request-${surface}`, content: 'Equivalent request',
    }, 'authenticated-operator');
    return {
      outcome: result.outcome,
      transcript: engine.transcript.map((item) => ({
        type: item.type, role: item.role, content: item.type === 'message' ? item.content : undefined,
        toolName: item.toolName, providerCallId: item.providerCallId,
        args: item.args, toolLifecycleStatus: item.toolLifecycleStatus,
        declaredOutcome: item.metadata?.declared_outcome,
      })),
      transitions: engine.state.transitions.map(({ from, to, trigger, guard }) => ({ from, to, trigger, guard })),
      lifecycles: engine.lifecycles.snapshot().map(({ kind, phase, outcome }) => ({ kind, phase, outcome })),
    };
  };
  const headless = await run('headless', 'adapter-a');
  const interactive = await run('interactive_tui', 'adapter-b');
  assert.equal(headless.outcome, 'completed');
  assert.deepEqual(interactive, headless);
});
