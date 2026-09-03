// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareEngineContext } from '../src/engine/context-preparation.js';
import { ReliabilityEngine } from '../src/reliability-engine.js';
import { measureContext } from '../src/context.js';

function fixture(enrichment = {}, tools = []) {
  const route = { model: 'fixture', profile: { id: 'fixture' }, maxOutputTokens: 1024 };
  const reliability = new ReliabilityEngine({ modelDialects: { instructions: () => '' },
    continuationCompactor: { refine: async (fact) => fact } });
  const budget = { hardLimitBytes: 65536, thresholdBytes: 48000, scaledTokens: 16000,
    effectiveInputTokens: 20000, outputReserveTokens: 1024, windowTokens: 22000 };
  reliability.planContextBudget = () => budget;
  // Exercise the final byte/envelope guard rather than the earlier pressure trigger.
  reliability.pressureTier = () => 'none';
  const transitions = [], facts = [], terminals = [];
  const engine = { config: { workspaceRoot: process.cwd(), executionManifest: null,
    limits: { maxContextBytes: budget.hardLimitBytes } }, reliability,
  router: { candidates: () => [route] }, modelRuntime: { resolve: async () => ({ model: 'fixture', providerId: 'fixture' }) },
  tools: { providerDefinitions: () => tools },
  transcript: [{ type: 'message', role: 'assistant', turnId: 'old', content: 'historical evidence '.repeat(20000) },
    { type: 'message', role: 'user', turnId: 'current', content: 'Inspect only; do not change any files.' }],
  state: { transition: (state) => transitions.push(state) },
  lifecycles: { start: () => ({ id: 'compaction' }), finish: (_id, status) => terminals.push(status) } };
  const active = { turnId: 'current', stepId: 'now', controller: new AbortController(),
    enrichment: { hooks: [], ...enrichment }, contextRetryScale: 1, compactionAttempts: 0,
    compactionNoProgressAttempts: 0, compactionFingerprints: new Set(), contextCheckpointFingerprints: new Set() };
  const operations = { publish: async () => ({ results: [] }), persist: async (_type, fact) => {
    facts.push(fact); engine.transcript.push(fact);
  } };
  return { engine, active, operations, transitions, facts, terminals, budget };
}

test('final context overflow triggers bounded compaction before returning a provider context', async () => {
  const run = fixture();
  const context = await prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations);
  assert.ok(measureContext(context) <= run.budget.thresholdBytes);
  assert.ok(context.some((message) => message.role === 'user' && message.content === 'Inspect only; do not change any files.'));
  assert.deepEqual(run.transitions, ['compacting_context']);
  assert.equal(run.facts.length, 1);
  assert.equal(run.active.compactionAttempts, 1);
  assert.deepEqual(run.terminals, ['completed']);
  assert.ok(run.engine.transcript[0].content.length > 300000, 'durable evidence was not truncated');
});

test('irreducible attachments fail closed without silently discarding evidence or committing an unfitted compaction', async () => {
  const run = fixture({ attachments: [{ id: 'attachment', mimeType: 'text/plain', route: 'text', observation: 'untrusted observation '.repeat(10000) }] });
  let candidates = 0;
  run.engine.reliability.continuationCompactor.refine = async (fact) => { candidates += 1; return fact; };
  await assert.rejects(prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations), { code: 'context_too_large' });
  assert.equal(candidates, 3);
  assert.equal(run.facts.length, 0);
  assert.deepEqual(run.terminals, ['failed']);
  assert.equal(run.active.enrichment.attachments[0].observation.length, 220000);
});

test('tool-schema overflow is included in preflight and cannot be hidden by compacting transcript', async () => {
  const run = fixture({}, [{ type: 'function', function: { name: 'large.schema', description: 'schema '.repeat(30000), parameters: { type: 'object' } } }]);
  await assert.rejects(prepareEngineContext(run.engine, [...run.engine.transcript], '', run.active, false, run.operations), { code: 'context_too_large' });
  assert.equal(run.facts.length, 0);
  assert.deepEqual(run.terminals, ['failed']);
});
