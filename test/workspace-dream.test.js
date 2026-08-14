// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { dreamOverlay } from '../src/tui/overlays.js';
import { runWorkspaceDreamCommand } from '../src/experience/dream.js';

test('dream manager exposes bounded stages and learning candidates without payload content', () => {
  const overlay = dreamOverlay({
    enabled: true, state: 'waiting', pending: {
      id: 'packet-1', stage: 3, result_code: 'project_memory_no_eligible_evidence',
    },
  }, [{
    id: 'candidate-1', kind: 'recovery.failure_pattern', state: 'observed',
    confidence: 0.75, recurrence_count: 5, risk_class: 'diagnostic',
    expected_benefit: 'Improve recovery.',
  }]);
  assert.equal(overlay.kind, 'dream');
  assert.match(overlay.lines.join('\n'), /NNM reconciliation/u);
  assert.ok(overlay.items.some((item) => item.id === 'candidate:candidate-1'));
  assert.doesNotMatch(JSON.stringify(overlay), /payload/u);
});

test('dream commands inspect and explicitly reject candidates', async () => {
  const calls = [];
  const workspace = { dream: {
    status: () => ({ state: 'waiting' }), candidates: () => [{ id: 'candidate-1' }],
    candidate: (id) => ({ id }), rejectCandidate: async (id, reason) => { calls.push({ id, reason }); return { id, state: 'rejected' }; },
    pause: () => calls.push('pause'), resume: () => calls.push('resume'), runNow: async () => calls.push('run'),
  } };
  assert.deepEqual(await runWorkspaceDreamCommand(workspace, 'inspect candidate-1'), { id: 'candidate-1' });
  assert.deepEqual(await runWorkspaceDreamCommand(workspace, 'reject candidate-1 noisy signal'), { id: 'candidate-1', state: 'rejected' });
  assert.deepEqual(calls[0], { id: 'candidate-1', reason: 'noisy signal' });
  await assert.rejects(() => runWorkspaceDreamCommand(workspace, 'inspect'), { code: 'dream_candidate_id_required' });
});
