// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { hookIdentityScope, hookPayload } from '../src/engine-hooks.js';

test('hook payload exposes a redacted local identity scope', () => {
  const engine = {
    sessionId: 'session-local',
    config: { workspaceRoot: 'D:\\repo' },
    skills: { loadedIds: () => ['research'] },
    store: { path: 'transcript.db' },
  };
  const payload = hookPayload(engine);
  assert.deepEqual(payload.identity_scope, {
    schema: 'notnative.identity-scope/1.0',
    subject_id: 'local-operator', platform_role: 'local-operator', scope: 'workspace',
    workspace_ids: [], group_ids: [], module_ids: [],
    project_root: 'D:\\repo', session_id: 'session-local',
  });
  assert.equal(Object.isFrozen(payload.identity_scope), true);
});

test('host identity is projected without permissions or authority secrets', () => {
  const engine = {
    sessionId: 'session-hosted',
    config: {
      workspaceRoot: '/tenant/workspace',
      executionManifest: { hostIdentity: {
        subjectId: 'user-7', platformRole: 'member', scope: 'workspace',
        permissions: ['secret.read'], workspaceIds: ['workspace-2'],
        groupIds: ['group-3'], moduleIds: ['crm'],
      } },
    },
  };
  const scope = hookIdentityScope(engine);
  assert.equal(scope.subject_id, 'user-7');
  assert.deepEqual(scope.workspace_ids, ['workspace-2']);
  assert.equal('permissions' in scope, false);
  assert.equal('token' in scope, false);
});
