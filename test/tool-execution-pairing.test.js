// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { TypedSessionEngine as SessionEngine } from './typed-provider-fixture.js';
import { ToolResultCache } from '../src/tools/result-cache.js';

function toolFragment(index, id, name, args) {
  return { index, id, function: { name, arguments: JSON.stringify(args) } };
}

test('an executor throw after dispatch pairs the approved tool with an unknown-effect result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-executor-pairing-'));
  await writeFile(join(root, 'missing-before-fault.txt'), 'alpha');
  await writeFile(join(root, 'never-dispatched.txt'), 'beta');
  let streamed = 0;
  const parent = { async *stream() {
    streamed += 1;
    if (streamed === 1) {
      yield { type: 'tool_fragment', fragments: [
        toolFragment(0, 'boom', 'fs_read', { path: 'missing-before-fault.txt' }),
        toolFragment(1, 'quiet', 'fs_read', { path: 'never-dispatched.txt' }),
      ] };
      yield { type: 'terminal', finishReason: 'tool_calls', usage: null };
      return;
    }
    yield { type: 'text', text: 'Both reads could not complete; I cannot continue.' };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  } };
  const config = resolveManifest({
    persistence: 'ephemeral', workspace_root: root, tool_concurrency: 1,
    provider: { id: 'primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'primary', trust_zone: 'loopback' },
  });
  const engine = new SessionEngine({
    config, providerFactory: () => parent,
    semanticReviewer: { async review() {
      return { outcome: 'approve', confidence: 0.99, reason_code: 'intent_match', authority_anchors: [1] };
    } },
  });
  await engine.initialize();
  const execute = engine.governor.executePrepared.bind(engine.governor);
  engine.governor.executePrepared = async (request, decision, signal) => {
    if (request.providerCallId === 'boom') {
      throw Object.assign(new Error('faulted normalizer'), { code: 'normalizer_fault' });
    }
    return execute(request, decision, signal);
  };
  const result = await engine.submit({ request_id: 'executor-escape', content: 'Read both files.' }, 'operator');
  assert.equal(typeof result.outcome, 'string');
  const requests = engine.transcript.filter((item) => item.type === 'tool_request'
    && item.toolName !== 'turn_finish');
  const recorded = engine.transcript.filter((item) => item.type === 'tool_result'
    && item.toolName !== 'turn_finish');
  // Invariant: every persisted tool_request has a paired durable tool_result.
  assert.deepEqual(requests.map((item) => item.providerCallId).toSorted(), ['boom', 'quiet']);
  assert.deepEqual(recorded.map((item) => item.providerCallId).toSorted(), ['boom', 'quiet']);
  const boom = recorded.find((item) => item.providerCallId === 'boom');
  assert.equal(boom.toolLifecycleStatus, 'unknown_effect');
  assert.equal(boom.effectCertainty, 'unknown');
  assert.equal(boom.reasonCode, 'tool_execution_unsettled');
  assert.equal(boom.metadata.synthetic, true);
  assert.match(boom.content, /verify external state/iu);
  // A queued sibling never entered execution, so its effect is honestly none.
  const quiet = recorded.find((item) => item.providerCallId === 'quiet');
  assert.equal(quiet.toolLifecycleStatus, 'cancelled');
  assert.equal(quiet.effectCertainty, 'none');
  assert.equal(quiet.reasonCode, 'tool_execution_not_dispatched');
  assert.equal(engine.lifecycles.snapshot().some((item) => item.outcome === null), false);
  await engine.shutdown({ request_id: 'shutdown-pairing', type: 'shutdown' });
});

test('the result cache restores pairings and ignores requests that never produced a result', () => {
  const cache = new ToolResultCache();
  assert.doesNotThrow(() => cache.restore([
    { type: 'tool_request', providerCallId: 'orphan', toolName: 'fs_read', args: { path: 'x' } },
    { type: 'tool_request', providerCallId: 'pair', toolName: 'fs_read', args: { path: 'y' } },
    { type: 'tool_result', providerCallId: 'pair', requestId: 'req-2', toolLifecycleStatus: 'succeeded',
      content: 'body', metadata: null, reasonCode: null, effectCertainty: 'none',
      elapsedMs: 1, truncated: false },
  ]));
  assert.equal(cache.lookup({ providerCallId: 'orphan', name: 'fs_read', args: { path: 'x' } }), null);
  assert.equal(cache.lookup({ providerCallId: 'pair', name: 'fs_read', args: { path: 'y' } })?.status, 'succeeded');
});

test('the result cache fails loudly when a journal pairs a result with an argumentless request', () => {
  // Why: the tool-call assembler guarantees an argument object for every
  // persisted call, so this shape can only come from a corrupted journal.
  // Restore must reject it visibly rather than cache a call identity it
  // cannot fingerprint.
  const cache = new ToolResultCache();
  assert.throws(() => cache.restore([
    { type: 'tool_request', providerCallId: 'weird', toolName: 'fs_read' },
    { type: 'tool_result', providerCallId: 'weird', requestId: 'req-1', toolLifecycleStatus: 'succeeded',
      content: 'body', metadata: null, reasonCode: null, effectCertainty: 'none',
      elapsedMs: 1, truncated: false },
  ]), { code: 'tool_call_invalid' });
});
