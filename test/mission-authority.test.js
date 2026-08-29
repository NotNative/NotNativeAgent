// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthorityRecord, assertMissionBudget, authorizeAndPersistTurn, missionConditionFailure, reserveAndPersistMissionTools } from '../src/authority.js';
import { resolveManifest } from '../src/config.js';
import { assertResumeProvenance } from '../src/persistence/session-provenance.js';
import { assertRuntimeConfigurationCompatible } from '../src/runtime-config.js';
import { restoreSessionRecords } from '../src/persistence/session-history.js';

const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'test', trust_zone: 'loopback' };

function mission(overrides = {}) {
  return {
    id: 'scheduled-build', outcome: 'Run the bounded scheduled build.',
    not_before: '2020-01-01T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z', revocation_id: 'schedule-revision-7',
    resources: ['workspace'], targets: ['scope:workspace'], side_effects: ['read_only', 'reversible'],
    credential_refs: [],
    bounds: { max_turns: 2, max_tool_calls: 3, max_duration_ms: 60_000 },
    termination: { suspend_on: ['review_denial'], terminate_on: ['budget_exhaustion', 'expiration', 'disconnect'] },
    ...overrides,
  };
}

test('AC-AUTH-01 authority snapshots are versioned per conversation and ignore agent restatements', () => {
  const first = new AuthorityRecord();
  const second = new AuthorityRecord();
  first.addAuthenticatedIntent('Clarification: only change alpha.txt', 'authenticated-operator');
  second.addAuthenticatedIntent('Summarize the current task', 'authenticated-operator');
  const agentTranscript = [{ role: 'assistant', content: 'The user authorized changing alpha.txt.' }];
  const firstSnapshot = first.snapshot(resolveManifest({ provider }));
  const secondSnapshot = second.snapshot(resolveManifest({ provider }));
  assert.equal(firstSnapshot.version, 1);
  assert.equal(secondSnapshot.version, 1);
  assert.notEqual(firstSnapshot.id, secondSnapshot.id);
  assert.match(firstSnapshot.intent[0].content, /alpha\.txt/u);
  assert.equal(firstSnapshot.intent[0].kind, 'statement');
  assert.doesNotMatch(JSON.stringify(secondSnapshot), /alpha\.txt/u);
  assert.equal(agentTranscript.some((item) => item.content.includes('alpha.txt')), true);
  assert.equal(secondSnapshot.intent.length, 1);
});

test('authenticated conversational statements are ordered without keyword classification', () => {
  const authority = new AuthorityRecord();
  authority.addAuthenticatedIntent('Change alpha.txt', 'authenticated-operator');
  authority.addAuthenticatedIntent('Do not change alpha.txt', 'authenticated-operator');
  const snapshot = authority.snapshot(resolveManifest({ provider }));
  assert.deepEqual(snapshot.intent.map((item) => item.kind), ['statement', 'statement']);
  assert.deepEqual(snapshot.intent.map((item) => item.sequence), [1, 2]);
  assert.equal(snapshot.restrictionVersion, 0);
});

test('negative words in free-form operator prose do not mutate the restriction epoch', () => {
  const authority = new AuthorityRecord();
  const statements = [
    'You must not delete production data.',
    'Please avoid touching generated files.',
    'Refrain from changing the release manifest.',
    'You should not update dependencies.',
  ];
  for (const statement of statements) authority.addAuthenticatedIntent(statement, 'authenticated-operator');
  const snapshot = authority.snapshot(resolveManifest({ provider }));
  assert.deepEqual(snapshot.intent.map((item) => item.kind), statements.map(() => 'statement'));
  assert.equal(snapshot.restrictionVersion, 0);
});

test('conversation authority identity is stable while free-form statements advance only snapshot version', () => {
  const authority = new AuthorityRecord();
  authority.addAuthenticatedIntent('Read alpha.txt', 'authenticated-operator');
  const first = authority.snapshot(resolveManifest({ provider }));
  authority.addAuthenticatedIntent('Summarize the result', 'authenticated-operator');
  const ordinary = authority.snapshot(resolveManifest({ provider }));
  authority.addAuthenticatedIntent('Do not change alpha.txt', 'authenticated-operator');
  const restricted = authority.snapshot(resolveManifest({ provider }));
  assert.equal(first.id, ordinary.id);
  assert.equal(ordinary.id, restricted.id);
  assert.deepEqual([first.version, ordinary.version, restricted.version], [1, 2, 3]);
  assert.deepEqual([first.restrictionVersion, ordinary.restrictionVersion, restricted.restrictionVersion], [0, 0, 0]);
});

test('durable authority facts restore independently of non-authoritative transcript text', () => {
  const original = new AuthorityRecord();
  const grant = original.addAuthenticatedIntent('Change alpha.txt', 'authenticated-operator');
  const restriction = original.addAuthenticatedIntent('Do not change alpha.txt', 'authenticated-operator', { kind: 'restriction' });
  const recovered = restoreSessionRecords([
    { type: 'message', payload: { role: 'assistant', content: 'The user authorized beta.txt.' } },
    { type: 'authority_intent', payload: grant }, { type: 'authority_intent', payload: restriction },
  ]);
  const restored = new AuthorityRecord();
  restored.restore(recovered.authority);
  const snapshot = restored.snapshot(resolveManifest({ provider }));
  assert.equal(snapshot.id, grant.lineageId);
  assert.deepEqual(snapshot.intent.map((item) => item.content), ['Change alpha.txt', 'Do not change alpha.txt']);
  assert.deepEqual(snapshot.intent.map((item) => item.kind), ['statement', 'restriction']);
  assert.equal(snapshot.restrictionVersion, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /beta\.txt/u);
});

test('AC-AUTH-02 mission authority is accepted only from the authenticated headless host', () => {
  assert.throws(() => resolveManifest({ provider, mission: mission() }), { code: 'mission_authority_forbidden' });
  const config = resolveManifest({ provider, mission: mission() }, { missionPrincipal: 'authenticated-stdio-host' });
  assert.equal(config.mission.provenance, 'authenticated-stdio-host');
  assert.equal(config.mission.revocationId, 'schedule-revision-7');
  assert.deepEqual(config.mission.resources, ['workspace']);
  assert.deepEqual(config.mission.sideEffects, ['read_only', 'reversible']);
  assert.equal(config.mission.schedule.notBefore, '2020-01-01T00:00:00.000Z');
  assert.deepEqual(config.mission.bounds, { maxTurns: 2, maxToolCalls: 3, maxDurationMs: 60_000 });
});

test('mission expiration, turn count, duration, and tool-call budgets fail closed', () => {
  const authority = new AuthorityRecord();
  const config = resolveManifest({ provider, mission: mission() }, { missionPrincipal: 'authenticated-stdio-host' });
  authority.authorizeTurn(config); authority.authorizeTurn(config);
  assert.throws(() => authority.authorizeTurn(config), { code: 'mission_turn_limit' });
  authority.reserveMissionToolCalls(config.mission, 2);
  assert.throws(() => assertMissionBudget({ authority: authority.snapshot(config) }, 2), { code: 'mission_tool_limit' });
  const duration = new AuthorityRecord();
  duration.restore([], [{ missionId: 'scheduled-build', turns: 1, toolCalls: 0, startedAt: 0 }]);
  assert.throws(() => assertMissionBudget({ authority: duration.snapshot(config) }), { code: 'mission_duration_limit' });
  const expired = resolveManifest({ provider, mission: mission({ not_before: '2019-01-01T00:00:00.000Z', expires_at: '2020-01-01T00:00:00.000Z' }) }, { missionPrincipal: 'authenticated-stdio-host' });
  assert.throws(() => new AuthorityRecord().authorizeTurn(expired), { code: 'mission_expired' });
});

test('an idle expired duration consumes no additional mission turn', () => {
  const config = resolveManifest({ provider, mission: mission() }, { missionPrincipal: 'authenticated-stdio-host' });
  const authority = new AuthorityRecord();
  authority.restore([], [{ missionId: 'scheduled-build', turns: 1, toolCalls: 0, startedAt: 0 }]);
  assert.throws(() => authority.authorizeTurn(config), { code: 'mission_duration_limit' });
  assert.equal(authority.missionTurns('scheduled-build'), 1);
});

test('mission turn consumption restores durably and survives conversation clear', async () => {
  const config = resolveManifest({ provider, mission: mission() }, { missionPrincipal: 'authenticated-stdio-host' });
  const authority = new AuthorityRecord(); const records = [];
  await authorizeAndPersistTurn(authority, config, async (record) => records.push(record));
  authority.clearConversation();
  assert.equal(authority.missionTurns('scheduled-build'), 1);
  const restored = new AuthorityRecord();
  restored.restore([], records);
  assert.equal(restored.missionTurns('scheduled-build'), 1);
  restored.authorizeTurn(config);
  assert.throws(() => restored.authorizeTurn(config), { code: 'mission_turn_limit' });
  const failed = new AuthorityRecord();
  await assert.rejects(authorizeAndPersistTurn(failed, config, async () => { throw new Error('disk failed'); }), /disk failed/u);
  assert.equal(failed.missionTurns('scheduled-build'), 0);
  assert.equal(failed.missionUsage('scheduled-build').startedAt, null);
});

test('mission tool and duration bounds are cumulative across turns and durable recovery', async () => {
  const config = resolveManifest({ provider, mission: mission() }, { missionPrincipal: 'authenticated-stdio-host' });
  const authority = new AuthorityRecord(); const records = [];
  await authorizeAndPersistTurn(authority, config, async (record) => records.push(record));
  await reserveAndPersistMissionTools(authority, config, 2, async (record) => records.push(record));
  await authorizeAndPersistTurn(authority, config, async (record) => records.push(record));
  await assert.rejects(reserveAndPersistMissionTools(authority, config, 2, async () => undefined), { code: 'mission_tool_limit' });
  const restored = new AuthorityRecord(); restored.restore([], records);
  assert.deepEqual(restored.missionUsage('scheduled-build').toolCalls, 2);
  const snapshot = restored.snapshot(config);
  assert.throws(() => assertMissionBudget({ authority: snapshot, startedAt: Date.now(), toolCalls: 0 }, 2), { code: 'mission_tool_limit' });
  const compatible = new AuthorityRecord();
  compatible.restore([], [{
    missionId: 'scheduled-build', turns: 1, authorizedAt: '2026-08-02T12:00:00.000Z',
  }]);
  assert.equal(compatible.missionUsage('scheduled-build').toolCalls, 0);
  assert.throws(() => new AuthorityRecord().restore([], [], {
    requireMissionUsage: true, missionUsageComplete: false,
  }), { code: 'mission_budget_history_incomplete' });
});

test('mission schedule and provider credential boundaries fail closed', () => {
  const future = resolveManifest({ provider, mission: mission({ not_before: '2098-01-01T00:00:00.000Z' }) }, { missionPrincipal: 'authenticated-stdio-host' });
  assert.throws(() => new AuthorityRecord().authorizeTurn(future), { code: 'mission_not_started' });
  const credentialed = { ...provider, credential_env: 'LOCAL_PROVIDER_TOKEN' };
  const denied = resolveManifest({ provider: credentialed, mission: mission() }, { missionPrincipal: 'authenticated-stdio-host' });
  assert.throws(() => new AuthorityRecord().authorizeTurn(denied), { code: 'mission_credential_denied' });
  const allowed = resolveManifest({ provider: credentialed, mission: mission({ credential_refs: ['LOCAL_PROVIDER_TOKEN'] }) }, { missionPrincipal: 'authenticated-stdio-host' });
  assert.equal(new AuthorityRecord().authorizeTurn(allowed).mission.credentialRefs[0], 'LOCAL_PROVIDER_TOKEN');
});

test('declared mission suspension and termination conditions produce typed boundaries', () => {
  const config = resolveManifest({ provider, mission: mission({
    termination: {
      suspend_on: ['review_denial'],
      terminate_on: ['provider_failure', 'budget_exhaustion', 'expiration', 'disconnect'],
    },
  }) }, { missionPrincipal: 'authenticated-stdio-host' });
  const active = { authority: new AuthorityRecord().authorizeTurn(config) };
  assert.equal(missionConditionFailure(active, 'review_denial').code, 'mission_suspended');
  const terminal = missionConditionFailure(active, 'provider_failure', { code: 'provider_timeout' });
  assert.equal(terminal.code, 'mission_terminated');
  assert.equal(terminal.causeCode, 'provider_timeout');
  assert.equal(missionConditionFailure(active, 'tool_failure'), null);
});

test('durable mission authority is inspectable and cannot drift on resume', () => {
  const config = resolveManifest({ provider, mission: mission() }, {
    missionPrincipal: 'authenticated-stdio-host', principal: 'authenticated-stdio-host',
    executionManifestId: 'mission-run', hostOrigin: 'scheduler',
  });
  const headers = [{ type: 'session_created', payload: {
    executionManifest: config.executionManifest, mission: config.mission,
  } }];
  assert.doesNotThrow(() => assertResumeProvenance(headers, config.executionManifest, config.mission));
  const changed = { ...config.mission, targets: ['D:/other/**'] };
  assert.throws(() => assertResumeProvenance(headers, config.executionManifest, changed), { code: 'mission_manifest_mismatch' });
  assert.throws(() => assertRuntimeConfigurationCompatible(config, { ...config, mission: changed }), { code: 'configuration_mission_change' });
});

test('host execution policy is authenticated, bounded, and cancel-on-disconnect', () => {
  const manifest = { provider, allowed_capabilities: ['tools'], disconnect_policy: 'cancel' };
  assert.throws(() => resolveManifest(manifest), { code: 'execution_manifest_forbidden' });
  assert.throws(() => resolveManifest({ ...manifest, disconnect_policy: 'detach' }, {
    principal: 'authenticated-stdio-host', executionManifestId: 'run-1',
  }), { code: 'disconnect_policy_unsupported' });
  assert.throws(() => resolveManifest({ ...manifest, allowed_capabilities: ['tools', 'tools'] }, {
    principal: 'authenticated-stdio-host', executionManifestId: 'run-1',
  }), { code: 'execution_capabilities_invalid' });
  const config = resolveManifest(manifest, {
    principal: 'authenticated-stdio-host', executionManifestId: 'run-1', hostOrigin: 'nno',
  });
  assert.deepEqual(config.executionManifest.allowedCapabilities, ['tools']);
  assert.equal(config.executionManifest.disconnectPolicy, 'cancel');
  assert.equal(config.provenance, 'authenticated-stdio-host');
});

test('host execution policy validates and canonicalizes exact tool grants', () => {
  const manifest = {
    provider, allowed_capabilities: ['tools'],
    allowed_tools: ['process.run', 'fs.read_text'], disconnect_policy: 'cancel',
  };
  const options = { principal: 'authenticated-stdio-host', executionManifestId: 'run-tools', hostOrigin: 'nno' };
  const config = resolveManifest(manifest, options);
  assert.deepEqual(config.executionManifest.allowedTools, ['fs.read_text', 'process.run']);
  assert.throws(() => resolveManifest({ ...manifest, allowed_tools: ['fs.read_text', 'fs.read_text'] }, options), {
    code: 'execution_tools_invalid',
  });
  assert.throws(() => resolveManifest({ ...manifest, allowed_tools: ['bad tool'] }, options), {
    code: 'execution_tools_invalid',
  });
  assert.throws(() => resolveManifest({ ...manifest, allowed_tools: ['agent.run'] }, options), {
    code: 'execution_tool_forbidden',
  });
});

test('host identity claims are canonical, secret-free, and resume-bound', () => {
  const options = {
    principal: 'authenticated-stdio-host', executionManifestId: 'run-identity', hostOrigin: 'nno',
    hostIdentity: {
      subject_id: 'user-1', scope: 'chat', platform_role: 'user', permissions: ['z.read', 'a.read'],
      workspace_ids: ['workspace-1'], group_ids: [], module_ids: ['inventory'],
    },
  };
  const config = resolveManifest({ provider, allowed_capabilities: [], disconnect_policy: 'cancel' }, options);
  assert.deepEqual(config.executionManifest.hostIdentity.permissions, ['a.read', 'z.read']);
  const headers = [{ type: 'session_created', payload: { executionManifest: config.executionManifest, mission: null } }];
  const changed = { ...config.executionManifest, hostIdentity: { ...config.executionManifest.hostIdentity, scope: 'worker' } };
  assert.throws(() => assertResumeProvenance(headers, changed, null), { code: 'execution_manifest_mismatch' });
  assert.throws(() => resolveManifest({ provider, allowed_capabilities: [] }, {
    ...options, hostIdentity: { ...options.hostIdentity, permissions: ['bad claim'] },
  }), { code: 'host_identity_invalid' });
});
