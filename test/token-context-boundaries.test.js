// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionEngine } from '../src/engine.js';
import { resolveManifest } from '../src/config.js';
import { contextBudget } from '../src/reliability/context-budget.js';
import { measureProviderEnvelope } from '../src/reliability/token-accounting.js';
import { compactTranscript } from '../src/reliability/compaction.js';
import { estimateTokenValue, boundedTokenText } from '../src/reliability/context-token-measurement.js';
import { parseProtocolLine } from '../src/contracts.js';

for (const window of [131072, 300000, 1048576]) {
  test(`token-valid Unicode and escaped requests exceed legacy byte ceilings at window ${window}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nna-token-boundary-'));
    const statuses = [];
    const config = resolveManifest({ persistence: 'ephemeral', workspace_root: root, context_limit_bytes: 65536,
      dream: { enabled: false }, provider: { id: 'p', model: 'm', endpoint: 'http://127.0.0.1:9/v1', trust_zone: 'loopback' } });
    const engine = new SessionEngine({ config, telemetry: false, skillRoots: [], hookRoot: join(root, 'hooks'),
      emitContextStatus: true, output: async (event) => statuses.push(event),
      modelRuntime: { resolve: async () => ({ contextWindowTokens: window, outputLimitTokens: 8192, source: 'fixture' }) },
      providerFactory: () => ({ async *stream() { yield { type: 'text', text: 'Done.' }; yield { type: 'terminal', finishReason: 'stop' }; } }) });
    try {
      await engine.initialize();
      for (const content of ['界'.repeat(23000), '\"\\'.repeat(35000)]) {
        const result = await engine.submit({ request_id: `test-${statuses.length}`, content }, 'operator');
        assert.equal(result.outcome, 'completed');
      }
      assert.ok(statuses.some((event) => event.type === 'context_status' && event.bytes > 65536));
      assert.equal(engine.transcript.filter((record) => record.type === 'compaction').length, 0);
    } finally { await engine.shutdown({ type: 'shutdown', request_id: 'shutdown' }); await rm(root, { recursive: true, force: true }); }
  });
}

test('physical allowances follow the token window rather than a fixed configured byte cap', () => {
  const budget = contextBudget({ limits: { maxContextBytes: 1024 } }, [], { contextWindowTokens: 1000000 });
  assert.equal(budget.windowTokens, 1000000);
  assert.ok(budget.hardLimitBytes > 1024);
});

test('wire JSON escaping is physical overhead and does not inflate semantic text counting', () => {
  const escaped = '\"\\'.repeat(1000);
  const plain = 'aa'.repeat(1000);
  const request = (text) => ({ model: 'm', messages: [{ role: 'user', content: text }], tools: [] });
  assert.equal(measureProviderEnvelope(request(escaped)).estimated_input_tokens,
    measureProviderEnvelope(request(plain)).estimated_input_tokens);
});

test('matching request counter counts the entire request; failures fall back explicitly', () => {
  const request = { model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] };
  const exact = measureProviderEnvelope(request, [], { requestTokenCounter: (value) => { assert.equal(value, request); return 42; }, tokenizerExact: true });
  assert.equal(exact.estimated_input_tokens, 42);
  assert.equal(exact.measurement, 'measured');
  const fallback = measureProviderEnvelope(request, [], { requestTokenCounter: () => { throw new Error('offline'); } });
  assert.equal(fallback.tokenizer_degraded, true);
  assert.equal(fallback.measurement, 'estimated');
});

test('token compaction retains budgeted records and Unicode excerpts fit their token target', () => {
  const records = Array.from({ length: 12 }, (_, i) => ({ type: 'message', role: i % 2 ? 'assistant' : 'user', turnId: `t${Math.floor(i / 2)}`, content: '界'.repeat(1000) }));
  const result = compactTranscript(records, 4096, { unit: 'tokens', requireProgress: true });
  assert.equal(result.fact.projection.measurementUnit, 'tokens');
  assert.ok(result.fact.projection.projectedTokens < result.fact.projection.originalTokens);
  assert.ok(estimateTokenValue(boundedTokenText('😀'.repeat(1000), 100)) <= 100);
  assert.equal(boundedTokenText('long text', 1), '');
});

test('headless parser accepts token-valid escaped text beyond the former line byte limit', () => {
  const content = '"\\'.repeat(80_000);
  const line = JSON.stringify({ version: '1.0', type: 'submit', request_id: 'large-input', content });
  assert.ok(Buffer.byteLength(line, 'utf8') > 262_144);
  assert.equal(parseProtocolLine(line, { contextWindowTokens: 300_000 }).content, content);
});
