// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { join } from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventHub } from '../src/events.js';
import { JournalStore } from '../src/store.js';
import { CanonicalIngress } from '../src/ingress.js';
import { declaredSubscription } from './event-fixture.js';
import { evaluateCompletion } from '../src/completion-supervisor.js';

const EMPTY_HOOK_ROOT = join(process.cwd(), '.nna-test-hooks-none');

test('recovery rejects a context-reset greeting instead of ending the active task', () => {
  const active = {
    finishReason: 'stop', toolAssembler: { size: 0 }, unresolvedToolFailures: [],
    recovery: { actions: [{ action: 'compact' }] },
  };
  const result = evaluateCompletion(active, "I'm ready to help! What would you like me to assist you with?");
  assert.equal(result.disposition, 'continue');
  assert.equal(result.category, 'task_context_lost');
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

class ScriptedProvider {
  async *stream() {
    yield { type: 'text', text: 'Hello' };
    yield { type: 'text', text: ', operator.' };
    yield { type: 'usage', usage: { total_tokens: 7 } };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  }
}

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
  assert.deepEqual(output.map((item) => item.type), [
    'accepted', 'stream_delta', 'stream_delta', 'turn_result',
  ]);
  const records = engine.lifecycles.snapshot();
  assert.equal(records.length, 3);
  assert.ok(records.every((item) => item.outcome === 'completed'));
  assert.equal(engine.transcript.length, 2);
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
  await engine.initialize();
  await engine.submit({ request_id: 'ephemeral-turn', content: 'Keep this turn ephemeral' }, 'operator');
  await engine.shutdown({ request_id: 'ephemeral-stop', type: 'shutdown' });
  await assert.rejects(readFile(join(sessions, 'ephemeral-session.journal.ndjson')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(reviewer, 'ephemeral-session.review.journal.ndjson')), { code: 'ENOENT' });
  assert.equal(memoryWrites, 0);
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

test('AC-FAIL-02 shutdown timeout releases a durable session lock for recovery', async () => {
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
  first.events.close = () => new Promise(() => undefined);
  await assert.rejects(first.shutdown({ request_id: 'bounded-durable-shutdown' }), { code: 'shutdown_timeout' });

  const recovered = new SessionEngine(options);
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

test('active mission expiration cancels a slow provider and terminates with the declared boundary', async () => {
  const now = Date.now();
  const mission = {
    id: 'expiring-mission', outcome: 'Wait for the bounded provider response.',
    not_before: new Date(now - 1_000).toISOString(), expires_at: new Date(now + 300).toISOString(),
    revocation_id: 'expiring-mission-1', resources: ['workspace'], targets: ['scope:workspace'],
    side_effects: ['read_only'], credential_refs: [],
    bounds: { max_turns: 2, max_tool_calls: 2, max_duration_ms: 60_000 },
    termination: { suspend_on: [], terminate_on: ['budget_exhaustion', 'expiration', 'disconnect'] },
  };
  let providerAborted = false;
  const provider = { async *stream(_request, signal) {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    providerAborted = true;
    throw Object.assign(new Error('aborted at mission boundary'), { code: 'provider_cancelled' });
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
    async *stream() {
      yield { type: 'text', text: 'Which target should I use?' };
      yield { type: 'terminal', finishReason: 'stop', usage: null };
    }
  }
  const engine = new SessionEngine({ config: config(), providerFactory: () => new QuestionProvider() });
  const result = await engine.submit({ request_id: 'request-3', content: 'Proceed' }, 'operator');
  assert.equal(result.outcome, 'needs_input');
  assert.deepEqual(result.recovery, []);
});

test('a conversational offer ending in a question completes without claiming a blocker', async () => {
  class GreetingProvider {
    async *stream() {
      yield { type: 'text', text: 'Good morning! How can I help you today?' };
      yield { type: 'terminal', finishReason: 'stop', usage: null };
    }
  }
  const engine = new SessionEngine({ config: config(), providerFactory: () => new GreetingProvider() });
  const result = await engine.submit({ request_id: 'request-greeting', content: 'Good morning' }, 'operator');
  assert.equal(result.outcome, 'completed');
});

test('active durable work forces model continuation until tasks and goal are complete', async () => {
  let calls = 0;
  let engine;
  const provider = { async *stream() {
    calls += 1;
    if (calls === 1) {
      yield { type: 'text', text: 'The report is ready. Want me to go deeper?' };
    } else {
      await engine.updateTask('T1', 'completed', 'verified report delivered');
      await engine.completeGoal('all durable tasks verified');
      yield { type: 'text', text: 'The report and durable work state are complete.' };
    }
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  } };
  engine = new SessionEngine({ config: config(), providerFactory: () => provider });
  await engine.setGoal('Deliver the verified report');
  await engine.addTask('Compile the final report');

  const result = await engine.submit({ request_id: 'work-gated-turn', content: 'Finish the report' }, 'operator');

  assert.equal(calls, 2);
  assert.equal(result.outcome, 'completed');
  assert.equal(engine.workStatus().goal.status, 'completed');
  assert.equal(engine.workStatus().tasks[0].status, 'completed');
  assert.equal(result.recovery.some((item) => item.category === 'unfinished_conversation_work'), true);
});

test('active durable work accepts input requests only for a typed blocked task', async () => {
  let calls = 0;
  let engine;
  const provider = { async *stream() {
    calls += 1;
    if (calls === 2) await engine.updateTask('T1', 'blocked', 'operator must choose the deployment target');
    yield { type: 'text', text: 'Which deployment target should I use?' };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  } };
  engine = new SessionEngine({ config: config(), providerFactory: () => provider });
  await engine.setGoal('Deploy the application');
  await engine.addTask('Choose and use the deployment target');

  const result = await engine.submit({ request_id: 'work-input-turn', content: 'Deploy it' }, 'operator');

  assert.equal(calls, 2);
  assert.equal(result.outcome, 'needs_input');
  assert.equal(engine.workStatus().tasks[0].status, 'blocked');
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
        index: 0, id: 'late-call', function: { name: 'fs.delete_file', arguments: '{}' },
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
    const engine = new SessionEngine({
      config: config(), surface,
      providerFactory: () => ({ async *stream() {
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
      transcript: engine.transcript.map(({ turnId: _turnId, ...item }) => item),
      transitions: engine.state.transitions.map(({ from, to, trigger, guard }) => ({ from, to, trigger, guard })),
      lifecycles: engine.lifecycles.snapshot().map(({ kind, phase, outcome }) => ({ kind, phase, outcome })),
    };
  };
  const headless = await run('headless', 'adapter-a');
  const interactive = await run('interactive_tui', 'adapter-b');
  assert.equal(headless.outcome, 'completed');
  assert.deepEqual(interactive, headless);
});
