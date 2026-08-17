// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactTranscript, createHandoffFact } from '../src/compaction.js';
import { buildContext } from '../src/context.js';
import { ContinuationCompactor } from '../src/continuation-compactor.js';
import { FairScheduler } from '../src/provider/fair-scheduler.js';

const config = {
  workspaceRoot: 'D:\\workspace', applicationPolicy: null,
  limits: { maxContextBytes: 200_000 },
};

test('compaction creates a bounded fingerprinted continuation artifact with operational state', () => {
  const transcript = [
    message('user', 'Build the feature safely.'),
    ...Array.from({ length: 40 }, (_, index) => message('assistant', `Old detail ${index} ${'x'.repeat(500)}`)),
    { type: 'tool_request', providerCallId: 'call-1', toolName: 'fs.edit_text', args: { path: 'src/a.js', old_text: 'secret-shaped content', new_text: 'x' } },
    { type: 'tool_result', providerCallId: 'call-1', status: 'succeeded', content: 'done' },
    message('user', 'Keep the existing terminal UX.'),
  ];
  const compacted = compactTranscript(transcript, 12_000);
  assert.equal(compacted.fact.version, 2);
  assert.equal(compacted.fact.continuation.schema, 'nna.continuation.v1');
  assert.equal(compacted.fact.continuation.objective, 'Keep the existing terminal UX.');
  assert.deepEqual(compacted.fact.continuation.recentDirectives, ['Build the feature safely.']);
  assert.deepEqual(compacted.fact.continuation.changedFiles, [{ path: 'src/a.js', operation: 'fs.edit_text', status: 'succeeded' }]);
  assert.deepEqual(compacted.fact.continuation.verifiedFacts, []);
  assert.ok(compacted.fact.omitted < transcript.length);
  assert.ok(compacted.records.length > 0);
  assert.equal(compacted.records.at(-1).content, 'Keep the existing terminal UX.');
  assert.doesNotMatch(compacted.fact.summary, /secret-shaped content/u);
  assert.match(compacted.fact.sourceFingerprint, /^[a-f0-9]{64}$/u);
});

test('compaction preserves the active turn and paired calls while bounding oversized tool output', () => {
  const transcript = [
    message('user', 'Earlier design discussion'), message('assistant', 'Earlier answer'),
    message('user', 'Verify the current Node release and continue this conversation.'),
    message('assistant', 'I will verify it.'),
    { type: 'tool_request', providerCallId: 'fetch-1', toolName: 'web.fetch', args: { url: 'https://example.test' } },
    { type: 'tool_result', providerCallId: 'fetch-1', status: 'succeeded', content: 'x'.repeat(550_000) },
  ];
  const compacted = compactTranscript(transcript, 65_536);
  const context = buildContext({ ...config, limits: { maxContextBytes: 65_536 } }, [compacted.fact], 'Continue.');
  const providerText = context.map((item) => typeof item.content === 'string' ? item.content : '').join('\n');
  assert.match(providerText, /Verify the current Node release/u);
  assert.match(providerText, /Tool output compacted/u);
  assert.equal(context.filter((item) => item.tool_calls?.[0]?.id === 'fetch-1').length, 1);
  assert.equal(context.filter((item) => item.tool_call_id === 'fetch-1').length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(context), 'utf8') < 65_536);
});

test('future model context begins at the latest continuation while full history remains intact', () => {
  const transcript = [
    message('user', 'Very old request'), message('assistant', 'Very old answer'),
    { type: 'compaction', version: 2, summary: 'Validated continuation', omitted: 2, retainedRecords: [] },
    message('user', 'Newest request'),
  ];
  const context = buildContext(config, transcript, 'Continue');
  const text = context.map((item) => item.content).filter((item) => typeof item === 'string').join('\n');
  assert.doesNotMatch(text, /Very old request/u);
  assert.match(text, /Validated continuation/u);
  assert.match(text, /Newest request/u);
  assert.equal(transcript.length, 4);
});

test('handoff replaces active model history with a terse zero-retention continuation', () => {
  const transcript = [
    message('user', 'Build a reliable handoff command.'),
    message('assistant', `Exploration details ${'x'.repeat(20_000)}`),
    { type: 'tool_request', providerCallId: 'edit-1', toolName: 'fs.edit_text', args: { path: 'src/tui.js' } },
    { type: 'tool_result', providerCallId: 'edit-1', status: 'succeeded', content: 'edited' },
    message('user', 'Keep it extremely concise.'),
    message('assistant', 'The command is implemented; run the test suite next.'),
  ];
  const fact = createHandoffFact(transcript);
  assert.equal(fact.version, 3);
  assert.equal(fact.continuation.schema, 'nna.handoff.v1');
  assert.equal(fact.continuation.objective, 'Keep it extremely concise.');
  assert.equal(fact.omitted, transcript.length);
  assert.deepEqual(fact.retainedRecords, []);
  assert.equal(fact.projection.policy, 'terse_handoff_v1');
  assert.ok(fact.projection.projectedBytes < fact.projection.originalBytes);
  const context = buildContext(config, [...transcript, fact], 'Continue.');
  const text = context.map((item) => item.content).filter((item) => typeof item === 'string').join('\n');
  assert.match(text, /NNA self-handoff/u);
  assert.match(text, /Keep it extremely concise/u);
  assert.doesNotMatch(text, /Exploration details/u);
});

test('legacy summary-only checkpoints recover durable history for one-time migration', () => {
  const transcript = [
    message('user', 'Durable request before the old checkpoint'),
    message('assistant', 'Durable answer before the old checkpoint'),
    { type: 'compaction', version: 2, summary: 'Legacy continuation', omitted: 2 },
  ];
  const context = buildContext(config, transcript, 'Resume it.');
  const text = context.map((item) => item.content).filter((item) => typeof item === 'string').join('\n');
  assert.match(text, /Durable request before the old checkpoint/u);
  assert.match(text, /Legacy continuation/u);
});

test('compaction projection replaces only older large successful results for the same target', () => {
  const transcript = [
    message('user', 'Inspect the file.', 'turn-old'),
    { type: 'tool_request', turnId: 'turn-old', providerCallId: 'read-old', toolName: 'fs.read_text', args: { path: 'src/a.js' } },
    { type: 'tool_result', turnId: 'turn-old', providerCallId: 'read-old', toolName: 'fs.read_text', status: 'succeeded', content: `old-marker-${'x'.repeat(4_000)}` },
    ...Array.from({ length: 5 }, (_, index) => [
      message('user', `Intervening request ${index}`, `turn-${index}`),
      message('assistant', `Intervening answer ${index}`, `turn-${index}`),
    ]).flat(),
    message('user', 'Inspect the file again.', 'turn-new'),
    { type: 'tool_request', turnId: 'turn-new', providerCallId: 'read-new', toolName: 'fs.read_text', args: { path: 'src/a.js' } },
    { type: 'tool_result', turnId: 'turn-new', providerCallId: 'read-new', toolName: 'fs.read_text', status: 'succeeded', content: `new-marker-${'y'.repeat(4_000)}` },
  ];
  const compacted = compactTranscript(transcript, 40_000);
  const oldResult = compacted.records.find((item) => item.type === 'tool_result' && item.providerCallId === 'read-old');
  const newResult = compacted.records.find((item) => item.type === 'tool_result' && item.providerCallId === 'read-new');
  assert.match(oldResult.content, /superseded by a newer result/u);
  assert.doesNotMatch(oldResult.content, /old-marker/u);
  assert.match(newResult.content, /new-marker/u);
  assert.match(transcript[2].content, /old-marker/u);
});

test('compaction replaces cold byte-identical successful results with recoverable duplicate receipts', () => {
  const repeated = `identical-evidence-${'x'.repeat(5_000)}`;
  const transcript = [
    message('user', 'Compare independent evidence.', 'turn-old'),
    { type: 'tool_request', turnId: 'turn-old', requestId: 'request-old', providerCallId: 'call-old', toolName: 'fs.read_text', args: { path: 'src/a.js' } },
    { type: 'tool_result', turnId: 'turn-old', requestId: 'request-old', providerCallId: 'call-old', toolName: 'fs.read_text', status: 'succeeded', content: repeated },
    ...Array.from({ length: 5 }, (_, index) => [
      message('user', `Intervening request ${index}`, `turn-${index}`),
      message('assistant', `Intervening answer ${index}`, `turn-${index}`),
    ]).flat(),
    message('user', 'Read the independently addressed evidence.', 'turn-new'),
    { type: 'tool_request', turnId: 'turn-new', requestId: 'request-new', providerCallId: 'call-new', toolName: 'web.fetch', args: { url: 'https://example.invalid/evidence' } },
    { type: 'tool_result', turnId: 'turn-new', requestId: 'request-new', providerCallId: 'call-new', toolName: 'web.fetch', status: 'succeeded', content: repeated },
  ];
  const compacted = compactTranscript(transcript, 80_000);
  const oldResult = compacted.records.find((item) => item.providerCallId === 'call-old' && item.type === 'tool_result');
  const newestResult = compacted.records.find((item) => item.providerCallId === 'call-new' && item.type === 'tool_result');
  const receipt = JSON.parse(oldResult.content);
  assert.equal(receipt.schema, 'nna.duplicate-result-receipt.v1');
  assert.equal(receipt.ledger_ref, 'request-old');
  assert.equal(receipt.duplicate_of.ledger_ref, 'request-new');
  assert.equal(receipt.duplicate_of.provider_call_id, 'call-new');
  assert.match(receipt.content_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(oldResult.metadata.compressionClass, 'recoverable');
  assert.equal(newestResult.content, repeated);
  assert.equal(transcript[2].content, repeated, 'the durable source remains unchanged');
  assert.equal(compacted.fact.projection.duplicateResultRecords, 1);
  assert.ok(compacted.fact.projection.duplicateResultBytesSaved > 4_000);
});

test('duplicate projection never collapses failures, small payloads, or protected active results', () => {
  const large = `same-${'z'.repeat(4_000)}`;
  const transcript = [
    message('user', 'Keep active evidence.', 'turn-active'),
    { type: 'tool_request', turnId: 'turn-active', providerCallId: 'active-a', toolName: 'fs.read_text', args: { path: 'a' } },
    { type: 'tool_result', turnId: 'turn-active', providerCallId: 'active-a', toolName: 'fs.read_text', status: 'succeeded', content: large },
    { type: 'tool_request', turnId: 'turn-active', providerCallId: 'active-b', toolName: 'fs.read_text', args: { path: 'b' } },
    { type: 'tool_result', turnId: 'turn-active', providerCallId: 'active-b', toolName: 'fs.read_text', status: 'succeeded', content: large },
    { type: 'tool_result', turnId: 'turn-old', providerCallId: 'failed-a', toolName: 'process.run', status: 'failed', content: large },
    { type: 'tool_result', turnId: 'turn-old', providerCallId: 'failed-b', toolName: 'process.run', status: 'failed', content: large },
    { type: 'tool_result', turnId: 'turn-old', providerCallId: 'small-a', toolName: 'fs.read_text', status: 'succeeded', content: 'same small result' },
    { type: 'tool_result', turnId: 'turn-old', providerCallId: 'small-b', toolName: 'fs.read_text', status: 'succeeded', content: 'same small result' },
  ];
  const compacted = compactTranscript(transcript, 80_000, { activeTurnId: 'turn-active' });
  assert.equal(compacted.fact.projection.duplicateResultRecords, 0);
  assert.equal(compacted.records.find((item) => item.providerCallId === 'active-a' && item.type === 'tool_result').content, large);
  assert.equal(compacted.records.find((item) => item.providerCallId === 'active-b' && item.type === 'tool_result').content, large);
});

test('normal compaction leaves the active turn and five newest completed turns unchanged', () => {
  const transcript = [];
  for (let index = 0; index < 8; index += 1) {
    transcript.push(message('user', `Request ${index}`, `turn-${index}`));
    transcript.push(message('assistant', `${index < 3 ? 'x'.repeat(20_000) : ''}Answer ${index}`, `turn-${index}`));
  }
  transcript.push(message('user', 'Active request', 'turn-active'));
  transcript.push(message('assistant', 'Active work in progress', 'turn-active'));
  const protectedOriginal = transcript.filter((item) => ['turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7', 'turn-active'].includes(item.turnId));
  const compacted = compactTranscript(transcript, 120_000, { activeTurnId: 'turn-active' });
  const protectedRetained = compacted.records.filter((item) => ['turn-3', 'turn-4', 'turn-5', 'turn-6', 'turn-7', 'turn-active'].includes(item.turnId));
  assert.deepEqual(protectedRetained, protectedOriginal);
  assert.equal(compacted.fact.projection.protectedCompletedTurns, 5);
  assert.equal(compacted.fact.projection.protectedTurnCount, 6);
  assert.equal(compacted.fact.projection.oversizedProtectedRecords, 0);
});

test('long active turns protect only the configured newest model steps during automatic compaction', () => {
  const transcript = [
    { type: 'message', role: 'user', content: 'long audit', turnId: 'turn-active' },
    ...Array.from({ length: 5 }, (_, index) => ({
      type: 'message', role: 'assistant', content: `step-${index + 1} `.repeat(2_000),
      turnId: 'turn-active', stepId: `step-${index + 1}`,
    })),
  ];
  const compacted = compactTranscript(transcript, 80_000, {
    activeTurnId: 'turn-active', activeStepId: 'step-5', protectedActiveSteps: 2,
  });
  const steps = compacted.records.map((item) => item.stepId).filter(Boolean);
  assert.ok(steps.includes('step-4'));
  assert.ok(steps.includes('step-5'));
  assert.ok(!steps.includes('step-1'));
  assert.ok(compacted.records.some((item) => item.role === 'user'));
});

test('requested compaction adaptively reduces oversized recent history instead of succeeding as a no-op', () => {
  const transcript = [];
  for (let index = 0; index < 3; index += 1) {
    transcript.push(message('user', `Request ${index}`, `turn-${index}`));
    transcript.push(message('assistant', `${'x'.repeat(18_000)} Answer ${index}`, `turn-${index}`));
  }
  const compacted = compactTranscript(transcript, 200_000, { requireProgress: true });
  assert.equal(compacted.fact.projection.policy, 'adaptive_recent_history_v2');
  assert.ok(compacted.fact.omitted > 0 || compacted.fact.projection.payloadCompactedRecords > 0);
  assert.ok(compacted.fact.projection.projectedBytes < compacted.fact.projection.originalBytes * 0.7);
  assert.match(compacted.records.at(-1).content, /Answer 2/u);
  assert.match(compacted.fact.continuation.completedWork.at(-1), /Answer 2/u);
});

test('oversized protected tool payload becomes a ledger-backed receipt without orphaning its request', () => {
  const transcript = [
    message('user', 'Inspect the large output.', 'turn-active'),
    { type: 'tool_request', turnId: 'turn-active', requestId: 'request-1', providerCallId: 'call-1', toolName: 'process.run', args: { executable: 'fixture' } },
    { type: 'tool_result', turnId: 'turn-active', requestId: 'request-1', providerCallId: 'call-1', toolName: 'process.run', status: 'succeeded', content: `head-${'x'.repeat(200_000)}-tail` },
  ];
  const compacted = compactTranscript(transcript, 65_536, { activeTurnId: 'turn-active' });
  const request = compacted.records.find((item) => item.type === 'tool_request');
  const result = compacted.records.find((item) => item.type === 'tool_result');
  assert.equal(request.providerCallId, result.providerCallId);
  assert.equal(result.metadata.compacted, true);
  assert.equal(result.metadata.reason, 'oversized_protected_payload');
  assert.equal(result.metadata.ledgerRef, 'request-1');
  assert.match(result.content, /head-/u);
  assert.match(result.content, /-tail/u);
});

test('recent tool output below the context-scaled protected cap remains unchanged', () => {
  const content = `head-${'x'.repeat(60_000)}-tail`;
  const transcript = [
    message('user', 'Inspect the substantial output.', 'turn-active'),
    { type: 'tool_request', turnId: 'turn-active', providerCallId: 'call-1', toolName: 'process.run', args: { executable: 'fixture' } },
    { type: 'tool_result', turnId: 'turn-active', providerCallId: 'call-1', toolName: 'process.run', status: 'succeeded', content },
  ];
  const compacted = compactTranscript(transcript, 524_288, { activeTurnId: 'turn-active' });
  const result = compacted.records.find((item) => item.type === 'tool_result');
  assert.equal(result.content, content);
  assert.notEqual(result.metadata?.compacted, true);
});

test('oversized protected history falls back to a bounded hierarchical continuation', () => {
  const transcript = [message('user', 'Current objective: finish the reliable compaction repair.', 'turn-active')];
  for (let index = 0; index < 6; index += 1) {
    transcript.push({
      type: 'tool_request', turnId: 'turn-active', providerCallId: `call-${index}`,
      toolName: 'process.run', args: { executable: 'fixture', args: [String(index)] },
    });
    transcript.push({
      type: 'tool_result', turnId: 'turn-active', providerCallId: `call-${index}`,
      toolName: 'process.run', status: 'succeeded', content: `Result ${index} ${'a'.repeat(20_000)}`,
    });
  }
  transcript.push(message('assistant', `Current work ${'z'.repeat(80_000)}`, 'turn-active'));
  const compacted = compactTranscript(transcript, 65_536, { activeTurnId: 'turn-active' });
  assert.equal(compacted.fact.projection.policy, 'hierarchical_continuation_v1');
  assert.ok(compacted.fact.projection.hierarchyChunks > 1);
  assert.match(compacted.fact.summary, /finish the reliable compaction repair/u);
  assert.ok(compacted.fact.projection.projectedBytes < 65_536);
  assert.ok(compacted.records.length <= 2);
  const context = buildContext({ ...config, limits: { maxContextBytes: 65_536 } }, [compacted.fact], 'Continue.');
  assert.ok(Buffer.byteLength(JSON.stringify(context), 'utf8') < 65_536);
});

test('settled tool exchanges become typed causal receipts while recent turns remain verbatim', () => {
  const transcript = [
    message('user', 'Inspect the host.', 'turn-old'),
    { type: 'tool_request', turnId: 'turn-old', requestId: 'request-old', providerCallId: 'shell-old', toolName: 'shell.run', args: { script: `hostname && ${'x'.repeat(3_000)}`, shell: 'auto' } },
    { type: 'tool_result', turnId: 'turn-old', requestId: 'request-old', providerCallId: 'shell-old', toolName: 'shell.run', status: 'succeeded', effectCertainty: 'completed', content: `host-a\n${'output '.repeat(2_000)}` },
    ...Array.from({ length: 5 }, (_, index) => [
      message('user', `Recent request ${index}`, `turn-${index}`),
      message('assistant', `Recent answer ${index}`, `turn-${index}`),
    ]).flat(),
  ];
  const compacted = compactTranscript(transcript, 80_000);
  const request = compacted.records.find((item) => item.providerCallId === 'shell-old' && item.type === 'tool_request');
  const result = compacted.records.find((item) => item.providerCallId === 'shell-old' && item.type === 'tool_result');
  const receipt = JSON.parse(result.content);
  assert.equal(request.providerCallId, result.providerCallId);
  assert.equal(request.args.shell, 'auto');
  assert.ok(request.args.script.length < 1_000);
  assert.equal(receipt.schema, 'nna.tool-receipt.v1');
  assert.equal(receipt.category, 'shell');
  assert.equal(receipt.outcome, 'succeeded');
  assert.equal(receipt.effect_certainty, 'completed');
  assert.equal(receipt.ledger_ref, 'request-old');
  assert.match(receipt.result_fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(result.metadata.reason, 'semantic_tool_receipt');
});

test('semantic continuation enrichment is schema validated and failure falls back deterministically', async () => {
  const base = compactTranscript([
    message('user', 'Finish the task'),
    ...Array.from({ length: 20 }, (_, index) => message('assistant', `detail ${index} ${'x'.repeat(300)}`)),
  ], 6_000).fact;
  const route = { profile: { id: 'local' }, model: 'fixture', maxOutputTokens: 4096, deadlineMs: 1000 };
  const compactor = new ContinuationCompactor({ scheduler: new FairScheduler(), timeoutMs: 1000 });
  const requests = [];
  const provider = (text) => ({
    runtimeSnapshot: async () => ({}),
    async *stream(request) { requests.push(request); yield { type: 'text', text }; yield { type: 'terminal' }; },
  });
  const enriched = await compactor.refine(base, { provider: () => provider(JSON.stringify({
    completed_work: ['Implemented parser'], open_questions: [], next_actions: ['Run full suite'],
  })) }, route, null, new AbortController().signal);
  assert.deepEqual(enriched.continuation.nextActions, ['Run full suite']);
  assert.deepEqual(enriched.continuation.verifiedFacts, []);
  assert.equal(JSON.stringify(requests[0].responseFormat).includes('maxLength'), false);

  const fallback = await compactor.refine(base, { provider: () => provider('{bad') }, route, null, new AbortController().signal);
  assert.equal(fallback, base);
});

test('semantic handoff is tightly bounded and invalid output falls back deterministically', async () => {
  const base = createHandoffFact([message('user', 'Finish the handoff feature.')]);
  const route = { profile: { id: 'local' }, model: 'fixture', maxOutputTokens: 4096, deadlineMs: 1000 };
  const compactor = new ContinuationCompactor({ scheduler: new FairScheduler(), timeoutMs: 1000 });
  const provider = (text) => ({
    runtimeSnapshot: async () => ({}),
    async *stream() { yield { type: 'text', text }; yield { type: 'terminal' }; },
  });
  const enriched = await compactor.handoff(base, { provider: () => provider(JSON.stringify({
    objective: 'Ship /handoff', decisions: ['No retained records'], completed_work: ['Core implemented'],
    verified_state: ['Focused tests pass'], blockers: [], next_actions: ['Run all checks'],
  })) }, route, null, new AbortController().signal);
  assert.equal(enriched.continuation.objective, 'Ship /handoff');
  assert.deepEqual(enriched.continuation.nextActions, ['Run all checks']);
  assert.match(enriched.summary, /Objective: Ship \/handoff/u);

  const fallback = await compactor.handoff(base, { provider: () => provider('{bad') }, route, null, new AbortController().signal);
  assert.equal(fallback, base);
});

function message(role, content, turnId = undefined) {
  return { type: 'message', role, content, trust: role === 'user' ? 'operator' : 'model', ...(turnId ? { turnId } : {}) };
}
