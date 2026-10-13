// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

export async function probeReviewMode(call, json, id) {
  const path = `/api/v1/nnd/sessions/${encodeURIComponent(id)}/review-mode`;
  const initial = await json(call, path, 200);
  assert.equal(initial.mode, 'default');
  assert.equal(initial.effective, 'auto-review');
  assert.deepEqual(initial.availableModes, ['default', 'auto-review', 'unattended']);
  const put = (mode, revision) => call(path, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, expected_revision: revision }) });
  const switched = await put('unattended', initial.revision);
  assert.equal(switched.status, 200);
  const saved = await switched.json();
  assert.equal(saved.effective, 'unattended');
  assert.ok(saved.revision > initial.revision);
  assert.equal((await put('full-control', saved.revision)).ok, false, 'NNA must reject unsupported full control');
  assert.equal((await put('auto-review', initial.revision)).ok, false, 'NNA must reject stale mode writes');
  assert.equal((await json(call, `/api/session/${id}`, 200)).metadata.nnd.governance.reviewPosture, 'unattended');
}

export async function probeRestoredReviewMode(call, json, id) {
  const path = `/api/v1/nnd/sessions/${encodeURIComponent(id)}/review-mode`;
  const restored = await json(call, path, 200);
  assert.equal(restored.mode, 'unattended', 'NNA must restore the session choice after restart');
  assert.equal(restored.effective, 'unattended');
  const reset = await json(call, path, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'default', expected_revision: restored.revision }) }, 200);
  assert.equal(reset.effective, 'auto-review');
}
