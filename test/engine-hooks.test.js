// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { addHookContexts, hookIdentityScope, hookPayload } from '../src/engine/hooks.js';

test('hook payload exposes a redacted local identity scope', () => {
  const loaded = ['research'];
  const engine = {
    sessionId: 'session-local',
    config: { workspaceRoot: 'D:\\repo' },
    skills: { loadedIds: () => loaded },
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
  assert.equal(Object.isFrozen(payload.loaded_skills), true);
  loaded.push('mutated');
  assert.deepEqual(payload.loaded_skills, ['research']);
  const protectedPayload = hookPayload(engine, { prompt: 'trusted', modelName: 'trusted-model' }, {
    cwd: 'untrusted', prompt: 'untrusted', model_name: 'untrusted', transcript_path: 'untrusted',
    loaded_skills: ['untrusted'], identity_scope: { scope: 'untrusted' }, authority_snapshot_id: 'authority',
  });
  assert.equal(protectedPayload.cwd, 'D:\\repo');
  assert.equal(protectedPayload.prompt, 'trusted');
  assert.equal(protectedPayload.model_name, 'trusted-model');
  assert.equal(protectedPayload.transcript_path, 'transcript.db');
  assert.equal(protectedPayload.authority_snapshot_id, 'authority');
});

test('hosted hook identity fails closed when its manifest projection is incomplete', () => {
  const base = { sessionId: 'hosted', config: { workspaceRoot: '/workspace', executionManifest: {} } };
  assert.deepEqual(hookIdentityScope(base), {
    schema: 'notnative.identity-scope/1.0', subject_id: 'host-identity-unavailable',
    platform_role: 'host-identity-unavailable', scope: 'host-identity-unavailable',
    workspace_ids: [], group_ids: [], module_ids: [], project_root: '/workspace', session_id: 'hosted',
  });
  assert.throws(() => hookIdentityScope({
    ...base, config: { ...base.config, executionManifest: { hostIdentity: {
      subjectId: 'user', platformRole: 'member', scope: 'workspace',
      workspaceIds: 'workspace', groupIds: [], moduleIds: [],
    } } },
  }), { code: 'execution_manifest_mismatch' });
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

test('repeated identical hook context is admitted only once per turn', async () => {
  let admitted = 0;
  const engine = {
    sessionId: 'session-hooks',
    grounding: { async admitHook(items) { admitted += items.length; return { admitted: items }; } },
  };
  const active = {
    turnId: 'turn-1', authority: { id: 'authority-1' }, controller: new AbortController(),
    enrichment: { hooks: [] },
  };
  const dispatch = { results: [
    { hook: 'fixture', additionalContext: 'same context' },
    { hook: 'fixture', additionalContext: 'same context' },
  ] };
  await addHookContexts(engine, active, dispatch);
  await addHookContexts(engine, active, dispatch);
  assert.equal(admitted, 1);
  assert.equal(active.enrichment.hooks.length, 1);
});

test('hook context injection fails closed when grounding is unavailable', async () => {
  const active = {
    turnId: 'turn-1', authority: { id: 'authority-1' }, controller: new AbortController(),
    enrichment: { hooks: [] },
  };
  await assert.rejects(addHookContexts({ sessionId: 'session-hooks' }, active, {
    results: [{ hook: 'fixture', additionalContext: 'untrusted context' }],
  }), { code: 'hook_context_unavailable' });
  assert.deepEqual(active.enrichment.hooks, []);
});
