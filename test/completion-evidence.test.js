// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { completionEvidence, completionEvidenceHint } from '../src/engine/completion-evidence.js';

test('completion evidence reports exact successful reads and verification calls', () => {
  const transcript = [
    request('read-1', 'fs_read', { path: 'src/a.js' }), result('read-1', 'fs_read', 'succeeded'),
    request('read-2', 'fs_read', { path: 'src/a.js' }), result('read-2', 'fs_read', 'succeeded'),
    request('read-3', 'fs_read', { path: 'src/b.js' }), result('read-3', 'fs_read', 'failed'),
    request('verify-1', 'project_verify', {}), result('verify-1', 'project_verify', 'succeeded'),
    request('finish-1', 'turn_finish', { outcome: 'completed' }), result('finish-1', 'turn_finish', 'succeeded'),
    { type: 'tool_request', turnId: 'other', providerCallId: 'other', toolName: 'fs_read', args: { path: 'ignored' } },
  ];
  const evidence = completionEvidence(transcript, 'turn-1');
  assert.deepEqual(evidence, {
    schema: 'nna.completion-evidence.v1', tool_requests: 4, tool_results: 4,
    succeeded: 3, non_success: 1, unique_files_read: 1, project_verifications: 1,
    tool_names: ['fs_read', 'project_verify'],
  });
  assert.match(completionEvidenceHint(evidence), /authoritative event counts/u);
  assert.match(completionEvidenceHint(evidence), /"unique_files_read":1/u);
});

test('reused provider call IDs pair only with their own step and request', () => {
  const transcript = [
    { ...request('call-1', 'fs_read', { path: 'src/failed.js' }), stepId: 'step-1', requestId: 'req-1' },
    { ...result('call-1', 'fs_read', 'failed'), stepId: 'step-1', requestId: 'req-1' },
    { ...request('call-1', 'fs_read', { path: 'src/succeeded.js' }), stepId: 'step-2', requestId: 'req-2' },
    { ...result('call-1', 'fs_read', 'succeeded'), stepId: 'step-2', requestId: 'req-2' },
    { ...request('call-1', 'project_verify', {}), stepId: 'step-3', requestId: 'req-3' },
  ];
  const evidence = completionEvidence(transcript, 'turn-1');
  assert.equal(evidence.tool_requests, 3);
  assert.equal(evidence.tool_results, 2);
  assert.equal(evidence.succeeded, 1);
  assert.equal(evidence.non_success, 2);
  assert.equal(evidence.unique_files_read, 1);
  assert.equal(evidence.project_verifications, 0);
});

test('missing identities and stray results cannot invent completion evidence', () => {
  const transcript = [
    result('call-1', 'fs_read', 'succeeded'),
    { ...request(null, 'fs_read', { path: 'src/unmatched.js' }), providerCallId: null },
    { ...result(null, 'fs_read', 'succeeded'), providerCallId: null },
    { ...request('call-2', 'project_verify', {}), requestId: 'req-2' },
    { ...result('call-2', 'project_verify', 'succeeded'), requestId: 'wrong-req' },
  ];
  const evidence = completionEvidence(transcript, 'turn-1');
  assert.equal(evidence.tool_requests, 2);
  assert.equal(evidence.tool_results, 0);
  assert.equal(evidence.succeeded, 0);
  assert.equal(evidence.unique_files_read, 0);
});

function request(providerCallId, toolName, args) {
  return { type: 'tool_request', turnId: 'turn-1', providerCallId, toolName, args };
}
function result(providerCallId, toolName, toolLifecycleStatus) {
  return { type: 'tool_result', turnId: 'turn-1', providerCallId, toolName, toolLifecycleStatus };
}
