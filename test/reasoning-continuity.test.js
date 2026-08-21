// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { buildContext, toProviderMessages } from '../src/context.js';
import { SessionEngine } from '../src/engine.js';
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
  const fallback = toProviderMessages(context, { profile: { id: 'fallback' }, model: 'other-model' });
  assert.equal(fallback.find((item) => item.tool_calls)?.reasoning_content, undefined);
  assert.doesNotMatch(JSON.stringify(transcript), /private implementation plan/u);
});

test('reasoning continuity keeps a bounded latest suffix', () => {
  const oversized = appendReasoningChunk('', `old-${'x'.repeat(300_000)}-latest`);
  assert.ok(Buffer.byteLength(oversized, 'utf8') <= 262_144);
  assert.match(oversized, /-latest$/u);
  const selected = boundedReasoningContinuations([
    { providerCallId: 'old', reasoningContent: 'a'.repeat(40_000) },
    { providerCallId: 'new', reasoningContent: 'b'.repeat(40_000) },
  ], 100_000);
  assert.equal(selected.has('old'), false);
  assert.equal(selected.get('new').reasoningContent.length, 25_000);
});

test('engine replays private reasoning on the next same-route model step only', async () => {
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
  assert.equal(requests[1].messages.find((message) => message.tool_calls)?.reasoning_content,
    'retain this implementation decision');
  assert.doesNotMatch(JSON.stringify(engine.transcript), /retain this implementation decision/u);
  await engine.shutdown({ request_id: 'continuity-shutdown', type: 'shutdown' });
});
