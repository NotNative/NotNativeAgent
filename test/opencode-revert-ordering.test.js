// SPDX-License-Identifier: Apache-2.0
// The revert-ordering guarantees the shared-execution plan names: a revert
// targeting a pending turn withdraws it from the wire queue before the marker
// lands (a held turn never reaches the provider), and the withdrawal settles
// the row honestly (aborted, bounded by an idle marker, no busy frames).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWireSession } from '../src/opencode/wire-session.js';
import { createWireEventBus } from '../src/opencode/wire-events.js';

function fixture(ingress = null) {
  const bus = createWireEventBus();
  const record = { ocId: 'ses_w', directory: '', projectID: '', title: 'T',
    ...(ingress ? { ingress } : {}) };
  const info = () => ({ id: record.ocId, title: record.title, directory: '', projectID: '', time: { created: Date.now(), updated: Date.now() } });
  const wireSession = createWireSession({ record, bus, info, version: 'test' });
  return { bus, wireSession };
}

const blockingIngress = { submit: () => new Promise(() => {}) };

test('a revert targeting a pending turn withdraws it from the queue', () => {
  const { wireSession } = fixture();
  const admitted = wireSession.admit([{ type: 'text', text: 'queued work' }]);
  const requestId = wireSession.requestIdFor(admitted.messageID);
  assert.ok(requestId, 'the admitted prompt joins to its engine request id');
  assert.equal(wireSession.pendingCount(), 1);
  assert.equal(wireSession.withdrawPending(requestId), true);
  // The withdrawn turn never runs: the queue is empty and the row is settled.
  assert.equal(wireSession.pendingCount(), 0);
  assert.equal(wireSession.requestIdFor(admitted.messageID), requestId,
    'the join stays so the revert can name the boundary');
});

test('an active or settled turn is not withdrawable', async () => {
  const { wireSession } = fixture(blockingIngress);
  const first = wireSession.admit([{ type: 'text', text: 'first' }]);
  const second = wireSession.admit([{ type: 'text', text: 'second' }]);
  const firstRequest = wireSession.requestIdFor(first.messageID);
  const secondRequest = wireSession.requestIdFor(second.messageID);
  // Why the wait: runEntry starts on the next microtask; the first turn must
  // be active before the exclusion can be proven.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(wireSession.withdrawPending(secondRequest), true, 'the queued second withdraws');
  assert.equal(wireSession.withdrawPending(secondRequest), false, 'an already-withdrawn entry is settled');
  assert.equal(wireSession.withdrawPending(firstRequest), false,
    'the active turn is not withdrawn by the queue path');
  assert.equal(wireSession.withdrawPending(null), false);
  assert.equal(wireSession.withdrawPending('oc_prompt_absent'), false);
});
