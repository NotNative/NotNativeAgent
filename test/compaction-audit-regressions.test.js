// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionEngine } from '../src/engine.js';
import { resolveManifest } from '../src/config.js';
import { buildContext } from '../src/context.js';
import { evaluateCompletion } from '../src/reliability/completion-supervisor.js';

test('large-window small conversations complete 33 turns without cadence checkpoints', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-compaction-audit-'));
  let requests = 0;
  const engine = new SessionEngine({ telemetry: false, hookRoot: join(root, 'hooks'), skillRoots: [],
    config: resolveManifest({ persistence: 'ephemeral', workspace_root: root, dream: { enabled: false },
      provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' } }),
    modelRuntime: { resolve: async () => ({ contextWindowTokens: 300000, outputLimitTokens: 32000, source: 'fixture' }) },
    providerFactory: () => ({ async *stream() {
      requests += 1; yield { type: 'text', text: 'Hello.' }; yield { type: 'terminal', finishReason: 'stop' };
    } }) });
  try {
    await engine.initialize();
    for (let index = 0; index < 33; index += 1) {
      assert.equal((await engine.submit({ request_id: `hello-${index}`, content: `Hello ${index}.` }, 'operator')).outcome, 'completed');
    }
    assert.equal(requests, 33);
    assert.equal(engine.transcript.filter((item) => item.type === 'compaction').length, 0);
  } finally { await engine.shutdown({ type: 'shutdown', request_id: 'shutdown' }); await rm(root, { recursive: true, force: true }); }
});

test('active work instructions agree with clean progress response completion', () => {
  const work = { revision: 1, goal: { id: 'goal', objective: 'Finish an audit', status: 'active' },
    tasks: [{ id: 'T1', title: 'Inspect modules', status: 'in_progress' }] };
  const config = { workspaceRoot: '.', limits: { maxContextBytes: 100000 } };
  const instructions = buildContext(config, [], 'Give me a progress update.', { work })
    .find((item) => item.provenance === 'conversation_work').content;
  assert.match(instructions, /Active work can span turns/u);
  assert.match(instructions, /without completing the goal/u);
  assert.doesNotMatch(instructions, /cannot end the turn/u);
  assert.equal(evaluateCompletion({ finishReason: 'stop' }, 'Core modules inspected.', work).disposition, 'completed');
  assert.equal(work.goal.status, 'active');
});

test('ineffective automatic refresh completes real engine turns without checkpoint accumulation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-refresh-skip-'));
  const output = [];
  const engine = new SessionEngine({ telemetry: false, surface: 'interactive_tui', output: async (item) => output.push(item),
    hookRoot: join(root, 'hooks'), skillRoots: [],
    config: resolveManifest({ persistence: 'ephemeral', workspace_root: root, dream: { enabled: false }, context_compression_threshold: 0.20,
      provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9/v1', model: 'fixture', trust_zone: 'loopback' } }),
    modelRuntime: { resolve: async () => ({ contextWindowTokens: 20000, outputLimitTokens: 1024, source: 'fixture' }) },
    providerFactory: () => ({ async *stream() {
      yield { type: 'text', text: 'Hello.' }; yield { type: 'terminal', finishReason: 'stop' };
    } }) });
  try {
    await engine.initialize();
    for (let index = 0; index < 14; index += 1) {
      const turn = await engine.submit({ request_id: `skip-${index}`, content: `Hello ${index}. ${'a'.repeat(500)}` }, 'operator');
      assert.equal(turn.outcome, 'completed');
    }
    const skipped = output.filter((item) => item.type === 'context_compaction_status' && item.status === 'skipped');
    assert.ok(skipped.length > 0);
    assert.ok(skipped.every((item) => item.after_estimated_tokens === item.before_estimated_tokens
      && item.candidate_estimated_tokens >= item.before_estimated_tokens));
    assert.equal(engine.transcript.filter((item) => item.type === 'compaction').length, 0);
  } finally { await engine.shutdown({ type: 'shutdown', request_id: 'shutdown' }); await rm(root, { recursive: true, force: true }); }
});
