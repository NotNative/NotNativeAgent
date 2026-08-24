// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { buildContext, measureContext, toProviderMessages } from '../src/context.js';
import { SessionEngine } from '../src/engine.js';
import { modelStepRequestOptions } from '../src/engine/runtime-helpers.js';
import {
  appendReasoningChunk, boundedReasoningContinuations, captureReasoningContinuation,
} from '../src/reliability/reasoning-continuity.js';

const config = {
  workspaceRoot: process.cwd(), executionManifest: null,
  limits: { maxContextBytes: 1_048_576 },
};

test('same-route private reasoning continues across a tool boundary without entering transcript text', () => {
  const active = {
    stepId: 'step-1', providerResource: 'local-qwen', modelName: 'qwen3.8-27b',
    stepReasoningText: 'private implementation plan', stepReasoningReplayable: true,
    reasoningContinuations: [], enrichment: {},
  };
  assert.equal(captureReasoningContinuation(active, [{ providerCallId: 'call-1' }]), true);
  const transcript = [
    { type: 'message', role: 'assistant', content: 'Writing the main file now.', trust: 'model' },
    { type: 'tool_request', providerCallId: 'call-1', toolName: 'fs.write_text', args: { path: 'main.js', content: 'ok' } },
    { type: 'tool_result', providerCallId: 'call-1', toolName: 'fs.write_text', status: 'succeeded', content: 'written' },
  ];
  const context = buildContext(config, transcript, '', active.enrichment);
  assert.doesNotMatch(context.find((item) => item.role === 'assistant' && typeof item.content === 'string').content, /private implementation plan/u);
  const matching = toProviderMessages(context, { profile: { id: 'local-qwen' }, model: 'qwen3.8-27b' });
  assert.equal(matching.find((item) => item.tool_calls)?.reasoning_content, 'private implementation plan');
  const disabled = toProviderMessages(context, {
    profile: { id: 'local-qwen' }, model: 'qwen3.8-27b', reasoningMode: 'off',
  });
  assert.equal(disabled.find((item) => item.tool_calls)?.reasoning_content, undefined);
  const fallback = toProviderMessages(context, { profile: { id: 'fallback' }, model: 'other-model' });
  assert.equal(fallback.find((item) => item.tool_calls)?.reasoning_content, undefined);
  assert.doesNotMatch(JSON.stringify(transcript), /private implementation plan/u);
});

test('one model step replays text, reasoning, and parallel tool calls as one assistant message', () => {
  const transcript = [
    { type: 'message', role: 'assistant', content: 'Checking both files.', trust: 'model', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'tool_request', providerCallId: 'call-a', toolName: 'fs.read', args: { path: 'a.js' }, turnId: 'turn-1', stepId: 'step-1' },
    { type: 'tool_result', providerCallId: 'call-a', toolName: 'fs.read', status: 'succeeded', content: 'a', turnId: 'turn-1', stepId: 'step-1' },
    { type: 'tool_request', providerCallId: 'call-b', toolName: 'fs.read', args: { path: 'b.js' }, turnId: 'turn-1', stepId: 'step-1' },
    { type: 'tool_result', providerCallId: 'call-b', toolName: 'fs.read', status: 'succeeded', content: 'b', turnId: 'turn-1', stepId: 'step-1' },
  ];
  const context = buildContext(config, transcript, '', { reasoningContinuations: [{
    providerCallId: 'call-a', providerProfile: 'local', model: 'qwen', reasoningContent: 'private plan',
  }] });
  const provider = toProviderMessages(context, { profile: { id: 'local' }, model: 'qwen' });
  const assistant = provider.filter((item) => item.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].content, 'Checking both files.');
  assert.deepEqual(assistant[0].tool_calls.map((call) => call.id), ['call-a', 'call-b']);
  assert.equal(assistant[0].reasoning_content, 'private plan');
  assert.deepEqual(provider.filter((item) => item.role === 'tool').map((item) => item.tool_call_id), ['call-a', 'call-b']);
  assert.ok(provider.indexOf(assistant[0]) < provider.findIndex((item) => item.tool_call_id === 'call-a'));
});

test('reasoning continuity rejects an oversized block instead of retaining a misleading suffix', () => {
  const oversized = appendReasoningChunk('', `old-${'x'.repeat(300_000)}-latest`);
  assert.equal(oversized, null);
});

test('reasoning continuity preserves complete blocks until actual available context is exhausted', () => {
  const selected = boundedReasoningContinuations([
    { providerCallId: 'old', reasoningContent: 'a'.repeat(40_000) },
    { providerCallId: 'new', reasoningContent: 'b'.repeat(40_000) },
  ], 100_000);
  assert.equal(selected.get('old').reasoningContent.length, 40_000);
  assert.equal(selected.get('new').reasoningContent.length, 40_000);
});

test('reasoning continuity evicts oldest whole blocks without slicing retained reasoning', () => {
  const selected = boundedReasoningContinuations([
    { providerCallId: 'old', reasoningContent: 'a'.repeat(40_000) },
    { providerCallId: 'middle', reasoningContent: 'b'.repeat(40_000) },
    { providerCallId: 'new', reasoningContent: 'c'.repeat(40_000) },
  ], 90_000);
  assert.equal(selected.has('old'), false);
  assert.equal(selected.get('middle').reasoningContent.length, 40_000);
  assert.equal(selected.get('new').reasoningContent.length, 40_000);
});

test('context uses actual envelope headroom instead of a fixed reasoning fraction', () => {
  const transcript = [
    { type: 'tool_request', providerCallId: 'call-old', toolName: 'fs.list', args: { path: '.' } },
    { type: 'tool_result', providerCallId: 'call-old', toolName: 'fs.list', status: 'succeeded', content: 'first' },
    { type: 'tool_request', providerCallId: 'call-new', toolName: 'fs.read', args: { path: 'main.js' } },
    { type: 'tool_result', providerCallId: 'call-new', toolName: 'fs.read', status: 'succeeded', content: 'second' },
  ];
  const enrichment = { reasoningContinuations: [
    { providerCallId: 'call-old', providerProfile: 'local', model: 'qwen', reasoningContent: 'a'.repeat(40_000) },
    { providerCallId: 'call-new', providerProfile: 'local', model: 'qwen', reasoningContent: 'b'.repeat(40_000) },
  ] };
  const baseBytes = measureContext(buildContext(config, transcript, '', {}, Number.MAX_SAFE_INTEGER));
  const context = buildContext(config, transcript, '', enrichment, baseBytes + 100_000);
  const provider = toProviderMessages(context, { profile: { id: 'local' }, model: 'qwen' });
  assert.deepEqual(provider.filter((item) => item.reasoning_content).map((item) => item.reasoning_content.length), [40_000, 40_000]);
});

test('context pressure evicts whole oldest reasoning blocks', () => {
  const transcript = ['old', 'middle', 'new'].flatMap((id) => [
    { type: 'tool_request', providerCallId: `call-${id}`, toolName: 'fs.list', args: { path: id } },
    { type: 'tool_result', providerCallId: `call-${id}`, toolName: 'fs.list', status: 'succeeded', content: id },
  ]);
  const enrichment = { reasoningContinuations: ['old', 'middle', 'new'].map((id, index) => ({
    providerCallId: `call-${id}`, providerProfile: 'local', model: 'qwen',
    reasoningContent: String(index).repeat(40_000),
  })) };
  const baseBytes = measureContext(buildContext(config, transcript, '', {}, Number.MAX_SAFE_INTEGER));
  const context = buildContext(config, transcript, '', enrichment, baseBytes + 90_000);
  const provider = toProviderMessages(context, { profile: { id: 'local' }, model: 'qwen' });
  assert.deepEqual(provider.filter((item) => item.reasoning_content).map((item) => item.reasoning_content[0]), ['1', '2']);
  assert.equal(provider.every((item) => item.reasoning_content === undefined || item.reasoning_content.length === 40_000), true);
});

test('engine keeps reasoning enabled but does not replay completed reasoning after a tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reasoning-continuity-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'reasoning', text: 'retain this implementation decision', field: 'reasoning_content' };
      yield { type: 'text', text: 'Checking the workspace.' };
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'call-list', function: { name: 'fs.list', arguments: '{"path":"."}' },
      }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    yield { type: 'text', text: 'Workspace checked.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'ephemeral', workspace_root: root,
      provider: { id: 'local-qwen', endpoint: 'http://127.0.0.1:9/v1', model: 'qwen3.8-27b', trust_zone: 'loopback' },
    }),
    providerFactory: () => provider,
    hookRoot: join(process.cwd(), '.nna-test-hooks-none'),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'continuity-turn', content: 'Inspect this workspace.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].reasoningMode, undefined);
  assert.equal(requests[1].messages.find((message) => message.tool_calls)?.reasoning_content, undefined);
  assert.doesNotMatch(JSON.stringify(engine.transcript), /retain this implementation decision/u);
  await engine.shutdown({ request_id: 'continuity-shutdown', type: 'shutdown' });
});

test('reasoning-only truncation checkpoints the private chain for one enabled action retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reasoning-checkpoint-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'reasoning', text: 'inspect first, then act', field: 'reasoning_content' };
      yield { type: 'terminal', finishReason: 'length' };
      return;
    }
    if (requests.length === 2) {
      yield { type: 'text', text: 'The first useful action is listing the workspace.' };
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'call-list', function: { name: 'fs.list', arguments: '{"path":"."}' },
      }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    yield { type: 'text', text: 'Workspace inspected.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'ephemeral', workspace_root: root,
      provider: { id: 'local-qwen', endpoint: 'http://127.0.0.1:9/v1', model: 'qwen3.8-27b', trust_zone: 'loopback' },
    }),
    providerFactory: () => provider,
    hookRoot: join(process.cwd(), '.nna-test-hooks-none'),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'checkpoint-turn', content: 'Inspect this workspace.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(requests.length, 3);
  assert.equal(requests[0].maxOutputTokens, 32_000);
  assert.equal(requests[1].maxOutputTokens, 32_000);
  assert.equal(requests[1].reasoningMode, undefined);
  assert.equal(requests[1].messages.find((message) => message.reasoning_content)?.reasoning_content,
    'inspect first, then act');
  assert.equal(requests[2].messages.some((message) => typeof message.reasoning_content === 'string'), false);
  await engine.shutdown({ request_id: 'checkpoint-shutdown', type: 'shutdown' });
});

test('every primary model step receives the context-planned output headroom', () => {
  assert.equal(modelStepRequestOptions(undefined, { contextBudget: { outputReserveTokens: 32_000 } })
    .outputReserveTokens, 32_000);
  assert.equal(modelStepRequestOptions(undefined, { contextBudget: { outputReserveTokens: 2048 } })
    .outputReserveTokens, 2048);
  assert.equal(modelStepRequestOptions(undefined, { contextBudget: null }).outputReserveTokens, undefined);
});

test('engine omits an oversized reasoning block instead of replaying a partial thought', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reasoning-continuity-overflow-'));
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: 'reasoning', text: 'x'.repeat(300_000), field: 'reasoning_content' };
      yield { type: 'tool_fragment', fragments: [{
        index: 0, id: 'call-list', function: { name: 'fs.list', arguments: '{"path":"."}' },
      }] };
      yield { type: 'terminal', finishReason: 'tool_calls' };
      return;
    }
    yield { type: 'text', text: 'Workspace checked without partial reasoning replay.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'ephemeral', workspace_root: root,
      provider: { id: 'local-qwen', endpoint: 'http://127.0.0.1:9/v1', model: 'qwen3.8-27b', trust_zone: 'loopback' },
    }),
    providerFactory: () => provider,
    hookRoot: join(process.cwd(), '.nna-test-hooks-none'),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'continuity-overflow', content: 'Inspect this workspace.' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(requests[1].messages.some((message) => typeof message.reasoning_content === 'string'), false);
  await engine.shutdown({ request_id: 'continuity-overflow-shutdown', type: 'shutdown' });
});
