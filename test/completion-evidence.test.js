// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { completionEvidence, completionEvidenceHint } from '../src/engine/completion-evidence.js';

test('completion evidence reports exact successful reads and verification calls', () => {
  const transcript = [
    request('read-1', 'fs.read', { path: 'src/a.js' }), result('read-1', 'fs.read', 'succeeded'),
    request('read-2', 'fs.read', { path: 'src/a.js' }), result('read-2', 'fs.read', 'succeeded'),
    request('read-3', 'fs.read', { path: 'src/b.js' }), result('read-3', 'fs.read', 'failed'),
    request('verify-1', 'project.verify', {}), result('verify-1', 'project.verify', 'succeeded'),
    request('finish-1', 'turn.finish', { outcome: 'completed' }), result('finish-1', 'turn.finish', 'succeeded'),
    { type: 'tool_request', turnId: 'other', providerCallId: 'other', toolName: 'fs.read', args: { path: 'ignored' } },
  ];
  const evidence = completionEvidence(transcript, 'turn-1');
  assert.deepEqual(evidence, {
    schema: 'nna.completion-evidence.v1', tool_requests: 4, tool_results: 4,
    succeeded: 3, non_success: 1, unique_files_read: 1, project_verifications: 1,
    tool_names: ['fs.read', 'project.verify'],
  });
  assert.match(completionEvidenceHint(evidence), /authoritative event counts/u);
  assert.match(completionEvidenceHint(evidence), /"unique_files_read":1/u);
});

function request(providerCallId, toolName, args) {
  return { type: 'tool_request', turnId: 'turn-1', providerCallId, toolName, args };
}
function result(providerCallId, toolName, toolLifecycleStatus) {
  return { type: 'tool_result', turnId: 'turn-1', providerCallId, toolName, toolLifecycleStatus };
}
