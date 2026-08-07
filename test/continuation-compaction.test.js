// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { compactTranscript } from '../src/compaction.js';
import { buildContext } from '../src/context.js';
import { ContinuationCompactor } from '../src/continuation-compactor.js';
import { FairScheduler } from '../src/fair-scheduler.js';

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

function message(role, content, turnId = undefined) {
  return { type: 'message', role, content, trust: role === 'user' ? 'operator' : 'model', ...(turnId ? { turnId } : {}) };
}
