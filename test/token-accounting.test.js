// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { ContractError } from '../src/ids.js';
import {
  aggregateTokenReceipts, assertProviderEnvelopeFits, createProviderTokenReceipt, measureProviderEnvelope,
} from '../src/reliability/token-accounting.js';
import { JournalStore } from '../src/store.js';
import { detailedTokenText, receiptTokenText, statusTokenText } from '../src/experience/token-accounting.js';
import { providerRequest } from '../src/engine/runtime-helpers.js';

test('complete provider envelope inventories prompt sections, schemas, configuration, and output reserve', () => {
  const context = [{ role: 'user', content: 'inspect', provenance: 'transcript' }];
  const request = {
    model: 'generic-reasoning-model', messages: [{ role: 'system', content: 'dialect' }, ...context],
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    temperature: 0, maxOutputTokens: 2048, reasoningEffort: 'medium', enableThinking: true,
  };
  const envelope = measureProviderEnvelope(request, context, { outputReserveTokens: 1024 });
  assert.equal(envelope.reserved_total_tokens, envelope.estimated_input_tokens + 1024);
  assert.deepEqual(envelope.sections.map((item) => item.id), [
    'request.injected_system', 'context.transcript', 'request.framing',
    'request.tool_schemas', 'request.configuration',
  ]);
  assert.ok(envelope.sections.every((item) => item.bytes > 0 && item.estimated_tokens > 0));
  assert.deepEqual(envelope.configuration, {
    temperature: { sent: true, value: 0 },
    max_output_tokens: { sent: true, value: 2048 },
    reasoning_effort: { sent: true, value: 'medium' },
    enable_thinking: { sent: true, value: true },
    reasoning_mode: { sent: false, value: null },
    tool_choice: 'auto',
    parallel_tool_calls: { sent: false, value: null },
  });
  assert.deepEqual(envelope.shape.message_roles, { system: 1, user: 1 });
  assert.equal(envelope.shape.tool_schema_count, 1);
  assert.equal(envelope.shape.tools[0].name, 'read');
  assert.ok(envelope.shape.tools[0].schema_bytes > 0);
  assert.equal(envelope.shape.tool_call_count, 0);
  assert.throws(() => assertProviderEnvelopeFits(envelope, { scaledTokens: 1 }), { code: 'context_too_large' });
  assert.equal(assertProviderEnvelopeFits(envelope, { scaledTokens: 100_000, windowTokens: 100_000 }), true);
});

test('generated system guidance follows identity while retaining injected envelope attribution', () => {
  const context = [
    { role: 'system', content: 'identity', provenance: 'engine_policy' },
    { role: 'system', content: 'volatile work state', provenance: 'conversation_work' },
    { role: 'user', content: 'inspect', provenance: 'transcript', trust: 'operator' },
  ];
  const request = providerRequest({
    reliability: { instructions: () => 'dialect guidance' },
    tools: {
      providerSurface: () => ({
        definitions: [{ type: 'function', function: { name: 'fs.read', parameters: { type: 'object' } } }],
        receipt: null,
      }),
      catalogSnapshot: () => [{ name: 'fs.read' }, { name: 'tool.search' }],
    },
  }, { model: 'fixture', maxOutputTokens: 1024 }, context);
  assert.equal(request.messages.length, 2);
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /^identity\n\ndialect guidance/iu);
  assert.match(request.messages[0].content,
    /^identity\n\ndialect guidance\n\nvolatile work state\n\nAdditional authorized tool names/iu);
  assert.equal(request.messages[1].content, 'inspect');
  assert.equal(request.messages.filter((item) => item.role === 'system').length, 1);
  const envelope = measureProviderEnvelope(request, context);
  assert.equal(envelope.sections.find((item) => item.id === 'request.injected_system').items, 2);
  assert.equal(envelope.sections.find((item) => item.id === 'context.engine_policy').items, 1);
  assert.equal(envelope.sections.find((item) => item.id === 'context.conversation_work').items, 1);
  assert.equal(envelope.sections.find((item) => item.id === 'context.transcript').items, 1);
});

test('ordinary conversation retains its foundational tool surface and one system message', () => {
  const context = [
    { role: 'system', content: 'identity', provenance: 'engine_policy' },
    { role: 'user', content: 'What makes cooperative board games fun?', provenance: 'transcript', trust: 'operator' },
  ];
  const request = providerRequest({
    reliability: { instructions: () => 'tool dialect' },
    tools: {
      providerSurface: () => ({ definitions: ['foundation'], receipt: null }),
      catalogSnapshot: () => [{ name: 'tool.search' }],
    },
  }, { model: 'fixture', maxOutputTokens: 32_000 }, context);
  assert.equal(request.messages.filter((item) => item.role === 'system').length, 1);
  assert.deepEqual(request.tools, ['foundation']);
  assert.match(request.messages[0].content, /tool dialect/iu);
  assert.equal(request.maxOutputTokens, 32_000);
});

test('provider envelope reports the controls actually sent for Qwen models', () => {
  const envelope = measureProviderEnvelope({
    model: 'qwen3.8-27b@q6_k_xl', messages: [], tools: [], reasoningEffort: 'low',
  });
  assert.deepEqual(envelope.configuration.reasoning_effort, { sent: false, value: null });
  assert.deepEqual(envelope.configuration.enable_thinking, { sent: false, value: null });

  const disabled = measureProviderEnvelope({
    model: 'qwen3.8-27b@q6_k_xl', messages: [], tools: [], reasoningMode: 'off',
  });
  assert.deepEqual(disabled.configuration.reasoning_effort, { sent: true, value: 'none' });
  assert.deepEqual(disabled.configuration.enable_thinking, { sent: true, value: false });
});

test('provider envelope reports canonical multi-call message shape without retaining content or arguments', () => {
  const secret = 'must-not-enter-redacted-envelope';
  const request = {
    model: 'qwen', temperature: null, maxOutputTokens: null,
    messages: [
      { role: 'assistant', content: secret, tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'fs.read', arguments: JSON.stringify({ path: secret }) } },
        { id: 'call-b', type: 'function', function: { name: 'web.search', arguments: JSON.stringify({ query: secret }) } },
      ] },
      { role: 'tool', tool_call_id: 'call-a', content: secret },
      { role: 'tool', tool_call_id: 'call-b', content: secret },
    ],
    tools: [
      { type: 'function', function: { name: 'fs.read', description: secret, parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'web.search', description: secret, parameters: { type: 'object' } } },
    ],
  };
  const envelope = measureProviderEnvelope(request, request.messages);
  assert.deepEqual(envelope.shape.message_roles, { assistant: 1, tool: 2 });
  assert.equal(envelope.shape.assistant_tool_call_messages, 1);
  assert.equal(envelope.shape.tool_call_count, 2);
  assert.equal(envelope.shape.max_tool_calls_per_message, 2);
  assert.deepEqual(envelope.shape.tools.map((item) => item.name), ['fs.read', 'web.search']);
  assert.equal(envelope.configuration.temperature.sent, false);
  assert.equal(JSON.stringify({ configuration: envelope.configuration, shape: envelope.shape }).includes(secret), false);
});

test('token receipts keep provider measurements separate from estimates for unreported attempts', () => {
  const manifest = { requestFingerprint: 'a'.repeat(64), envelope: {
    schema: 'nna.provider-envelope.v1', estimated_input_tokens: 100,
  } };
  const active = { turnId: 'turn', stepId: 'step', providerResource: 'local', modelName: 'qwen' };
  const measured = createProviderTokenReceipt(manifest, active, {
    attemptId: 'attempt-1', outcome: 'completed', usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 },
  });
  const estimated = createProviderTokenReceipt(manifest, active, {
    attemptId: 'attempt-2', outcome: 'failed', outputBytes: 30,
  });
  const total = aggregateTokenReceipts([measured, estimated]);
  assert.equal(measured.accounting.measurement, 'provider');
  assert.equal(estimated.accounting.measurement, 'estimated');
  assert.equal(total.measured_total_tokens, 100);
  assert.equal(total.estimated_unreported_tokens, 110);
  assert.equal(total.accounted_total_tokens, 210);
  assert.equal(total.measurement, 'mixed');
  const record = { usage: { total_tokens: 100 }, token_accounting: total };
  assert.equal(receiptTokenText(record), '100+~110 tokens');
  assert.equal(detailedTokenText(record), '100 measured tokens + ~110 unreported');
  assert.equal(statusTokenText(record.usage, total), '100+~110 tokens');
});

test('provider envelope folds excess section identities without dropping their token weight', () => {
  const context = Array.from({ length: 70 }, (_, index) => ({
    role: 'system', content: `section-${index}`, provenance: `unique_${index}`,
  }));
  const envelope = measureProviderEnvelope({ model: 'qwen', messages: context, tools: [] }, context);
  assert.equal(envelope.sections.length, 64);
  assert.equal(envelope.sections.at(-1).id, 'context.other');
  assert.equal(envelope.estimated_input_tokens,
    envelope.sections.reduce((total, section) => total + section.estimated_tokens, 0));
});

test('failed retry usage and successful usage both produce durable attempt receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-token-receipts-'));
  const stores = join(root, 'sessions');
  let attempt = 0;
  const provider = { async *stream() {
    attempt += 1;
    if (attempt === 1) {
      yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } };
      throw new ContractError('provider_transient', 'retry fixture', true);
    }
    yield { type: 'text', text: 'Completed.' };
    yield { type: 'usage', usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'durable', workspace_root: root,
      provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' },
    }),
    sessionId: 'token-session', storeRoot: stores,
    reviewerRoot: join(root, 'reviewers'), providerFactory: () => provider,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'token-turn', content: 'Complete this' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 });
  assert.equal(result.token_accounting.attempts, 2);
  assert.equal(result.token_accounting.measured_total_tokens, 32);
  assert.equal(result.token_accounting.estimated_unreported_tokens, 0);
  await engine.shutdown({ request_id: 'token-shutdown' });

  const store = new JournalStore(stores, 'token-session');
  const recovered = await store.open();
  const receipts = recovered.records.filter((item) => item.type === 'provider_token_receipt');
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map((item) => item.payload.outcome), ['failed', 'completed']);
  assert.ok(receipts.every((item) => /^[a-f0-9]{64}$/u.test(item.payload.receipt_id)));
  await store.close();
});
