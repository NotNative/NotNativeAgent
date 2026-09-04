// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { DreamStore } from '../src/dream-store.js';
import { IdleArbiter } from '../src/idle-arbiter.js';
import { DreamCoordinator } from '../src/dream-coordinator.js';
import { ForensicTelemetry } from '../src/forensic-telemetry.js';
import { GovernanceEngine } from '../src/governance-engine.js';
import { LearningCandidateRegistry } from '../src/learning-candidates.js';
import { governanceFingerprint } from '../src/governance/contracts.js';

test('dream defaults are standalone-only and preserve explicit operator disablement', () => {
  assert.equal(resolveManifest(manifest()).dream.enabled, true);
  assert.equal(resolveManifest(manifest({ dream: { enabled: false } })).dream.enabled, false);
  const hosted = resolveManifest(manifest({ dream: { enabled: true } }), {
    principal: 'authenticated-stdio-host', executionManifestId: 'host-run',
    hostIdentity: {
      subject_id: 'fixture', scope: 'workspace', platform_role: 'user',
      permissions: [], workspace_ids: [], group_ids: [], module_ids: [],
    },
  });
  assert.equal(hosted.dream.enabled, false);
});

test('dream state commits watermarks and recovers interrupted runs after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-store-'));
  const path = join(root, 'dream.db');
  const first = new DreamStore({ path });
  await first.initialize();
  first.commitWatermark({ runtimeKey: 'workspace-a', sessionId: 'session-a', turnSequence: 12, stage: 1 });
  const completed = first.begin({ runtimeKey: 'workspace-a', stage: 0, evidenceStart: 1, evidenceEnd: 12 });
  first.finish(completed.id, 'completed', { resultCode: 'harvest_complete', durationMs: 4 });
  const interrupted = first.begin({ runtimeKey: 'workspace-a', stage: 1 });
  first.close();

  const second = new DreamStore({ path });
  await second.initialize();
  assert.equal(second.watermark('workspace-a').turn_sequence, 12);
  assert.equal(second.run(completed.id).state, 'completed');
  assert.equal(second.run(interrupted.id).state, 'cancelled');
  assert.equal(second.run(interrupted.id).result_code, 'restart_recovered');
  second.close();
});

test('malformed durable dream payloads are quarantined instead of poisoning restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-corrupt-'));
  const path = join(root, 'dream.db');
  const first = new DreamStore({ path });
  await first.initialize();
  first.savePacket({
    id: 'packet-corrupt', runtimeKey: 'workspace-a', evidenceId: 'evidence:packet',
    payload: { records: 1 },
  });
  first.observeCandidate({
    id: 'candidate-corrupt', runtimeKey: 'workspace-a', kind: 'reliability.issue',
    scope: { kind: 'workspace', fingerprint: 'a'.repeat(64) }, confidence: 0.8,
    evidenceRefs: ['evidence:packet'], expectedBenefit: 'Avoid repeated failures.',
    successCriteria: ['The failure no longer repeats.'], riskClass: 'low',
    payload: { failure_code: 'provider_timeout' },
  });
  first.db.prepare('UPDATE dream_packets SET payload = ? WHERE id = ?').run('{', 'packet-corrupt');
  first.db.prepare('UPDATE improvement_candidates SET evidence_refs = ? WHERE id = ?')
    .run('{', 'candidate-corrupt');
  first.close();

  const restored = new DreamStore({ path });
  await restored.initialize();
  assert.equal(restored.pendingPacket('workspace-a'), null);
  assert.deepEqual(restored.candidates(), []);
  assert.deepEqual(
    { ...restored.db.prepare('SELECT state, result_code FROM dream_packets WHERE id = ?').get('packet-corrupt') },
    { state: 'completed', result_code: 'malformed_payload_quarantined' },
  );
  assert.deepEqual(
    { ...restored.db.prepare('SELECT state, rejection_reason FROM improvement_candidates WHERE id = ?').get('candidate-corrupt') },
    { state: 'rejected', rejection_reason: 'malformed_durable_payload' },
  );
  restored.close();
});

test('dream store emits content-free lifecycle observations for every stage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-observe-')), events = [];
  const store = new DreamStore({ path: join(root, 'dream.db'), observe: (event) => events.push(event) });
  await store.initialize();
  const run = store.begin({
    runtimeKey: 'workspace-a', stage: 2, trigger: 'idle',
    inputFingerprint: 'a'.repeat(64),
  });
  store.finish(run.id, 'completed', {
    resultCode: 'proposal_created', durationMs: 12, outputFingerprint: 'b'.repeat(64),
  });
  store.close();
  assert.deepEqual(events.map((event) => [event.phase, event.run.state]), [
    ['started', 'running'], ['finished', 'completed'],
  ]);
  assert.equal(JSON.stringify(events).includes('prompt'), false);
});

test('dream stage durability is independent from a failed telemetry observer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-observer-failure-'));
  const store = new DreamStore({
    path: join(root, 'dream.db'), observe: () => { throw new Error('telemetry unavailable'); },
  });
  await store.initialize();
  const run = store.begin({ runtimeKey: 'workspace-a', stage: 1 });
  assert.equal(store.finish(run.id, 'completed', { resultCode: 'diagnosis_complete' }).state, 'completed');
  assert.equal(store.run(run.id).result_code, 'diagnosis_complete');
  store.close();
});

test('dream retention expires completed run detail without deleting its watermark', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-retention-'));
  const store = new DreamStore({ path: join(root, 'dream.db'), retentionDays: 1 });
  await store.initialize();
  store.commitWatermark({ runtimeKey: 'workspace-a', sessionId: 'session-a', turnSequence: 27, stage: 1 });
  const run = store.begin({ runtimeKey: 'workspace-a', stage: 0 });
  store.finish(run.id, 'completed', { resultCode: 'harvest_complete' });
  assert.equal(store.cleanup(Date.now() + 2 * 86_400_000), 1);
  assert.equal(store.run(run.id), null);
  assert.equal(store.watermark('workspace-a').turn_sequence, 27);
  store.close();
});

test('idle activity aborts maintenance and foreground eligibility is rechecked', async () => {
  let eligible = true;
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const states = [];
  const arbiter = new IdleArbiter({
    idleMs: 5, interStageMs: 5, eligible: async () => eligible,
    onState: (state) => states.push(state.state),
    runStage: async ({ signal }) => {
      started();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true }));
    },
  });
  arbiter.start();
  await entered;
  arbiter.activity('keyboard');
  await new Promise((resolve) => setTimeout(resolve, 10));
  eligible = false;
  arbiter.activity('foreground');
  await new Promise((resolve) => setTimeout(resolve, 10));
  arbiter.close();
  assert.ok(states.includes('running'));
  assert.ok(states.includes('cancelled'));
  assert.ok(states.includes('waiting'));
});

test('idle activity prevents an obsolete stage from replacing the fresh idle delay', async () => {
  const timers = [];
  const states = [];
  let entered;
  let finish;
  const stageEntered = new Promise((resolve) => { entered = resolve; });
  const arbiter = new IdleArbiter({
    idleMs: 50, interStageMs: 5, eligible: async () => true,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
    onState: (state) => states.push(state.state),
    runStage: async () => {
      entered();
      return new Promise((resolve) => { finish = resolve; });
    },
  });

  const running = arbiter.runNow();
  await stageEntered;
  arbiter.start();
  arbiter.activity('keyboard');
  const freshTimer = timers.at(-1);
  freshTimer.cleared = true;
  freshTimer.callback();
  await Promise.resolve();
  finish({ code: 'obsolete-result' });
  assert.deepEqual(await running, { state: 'skipped', reason: 'stale' });

  const liveTimers = timers.filter((timer) => !timer.cleared);
  assert.deepEqual(liveTimers.map((timer) => timer.delay), [50]);
  assert.equal(states.includes('completed'), false);
  arbiter.close();
});

test('manual deterministic harvest checkpoints only terminal redacted telemetry evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-harvest-'));
  const telemetry = new ForensicTelemetry({
    workspaceRoot: root, runtimeId: 'runtime', sessionId: 'session', dbPath: join(root, 'events.db'),
  });
  await telemetry.initialize();
  telemetry.record('tool.execute', 'succeeded', { tool_name: 'fs.read_text' }, { turnId: 'turn-1' });
  telemetry.record('provider.attempt', 'failed', { code: 'provider_timeout' }, { turnId: 'turn-1', reasonCode: 'provider_timeout' });
  await telemetry.flush();
  const governance = new GovernanceEngine({ sessionId: 'session' });
  await governance.initialize();
  const config = resolveManifest(manifest({ workspace_root: root }));
  const workspace = { sessions: new Map([['session', { engine: { state: { state: 'idle' }, telemetry, governance } }]]) };
  const coordinator = new DreamCoordinator({ workspace, config, path: join(root, 'dream.db') });
  await coordinator.initialize();
  const result = await coordinator.runNow();
  const status = coordinator.status();
  assert.equal(result.state, 'completed');
  assert.equal(result.result.code, 'harvest_complete');
  assert.equal(result.result.packet.records, 2);
  assert.equal(result.result.packet.counts.failed, 1);
  assert.equal(result.result.packet.diagnosis.quarantined_turns, 1);
  assert.equal(result.result.packet.diagnosis.eligible_turns, 0);
  assert.ok(status.watermark.turn_sequence > 0);
  assert.equal(JSON.stringify(status).includes('fs.read_text'), false);
  await telemetry.flush();
  const lifecycle = await telemetry.query({ eventName: 'maintenance.stage', limit: 20 });
  assert.deepEqual(lifecycle.map((row) => row.status), ['running', 'succeeded']);
  assert.equal(JSON.stringify(lifecycle).includes('fs.read_text'), false);
  coordinator.close();
  await telemetry.close();
});

test('idle operational diagnosis survives the stage boundary and observes repeated-failure candidates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-diagnosis-'));
  const telemetry = new ForensicTelemetry({
    workspaceRoot: root, runtimeId: 'runtime', sessionId: 'session', dbPath: join(root, 'events.db'),
  });
  await telemetry.initialize();
  for (let index = 1; index <= 3; index += 1) {
    telemetry.record('provider.attempt', 'failed', { code: 'provider_timeout' }, {
      turnId: `turn-${index}`, reasonCode: 'provider_timeout',
    });
  }
  await telemetry.flush();
  const governance = new GovernanceEngine({ sessionId: 'session' });
  await governance.initialize();
  const config = resolveManifest(manifest({ workspace_root: root }));
  const workspace = { sessions: new Map([['session', { engine: { state: { state: 'idle' }, telemetry, governance } }]]) };
  const path = join(root, 'dream.db');
  const coordinator = new DreamCoordinator({ workspace, config, path });
  await coordinator.initialize();
  assert.equal((await coordinator.runNow()).result.code, 'harvest_complete');
  const stage = await coordinator.runNow();
  assert.equal(stage.result.code, 'operational_diagnosis_complete');
  assert.equal(stage.result.candidates, 1);
  assert.equal(coordinator.status().store.candidates.observed, 1);
  coordinator.close();

  const restored = new DreamStore({ path });
  await restored.initialize();
  assert.equal(restored.pendingPacket(createHashForTest(root)), null);
  assert.equal(restored.candidates().at(0).payload.failure_code, 'provider_timeout');
  restored.close();
  await telemetry.close();
});

test('idle maintenance settles packets whose governance evidence is no longer available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-stale-evidence-'));
  const governance = new GovernanceEngine({ sessionId: 'session' });
  await governance.initialize();
  const engine = { state: { state: 'idle' }, governance, transcript: [] };
  const coordinator = new DreamCoordinator({
    workspace: { sessions: new Map([['session', { engine }]]) },
    config: resolveManifest(manifest({ workspace_root: root })), path: join(root, 'dream.db'),
  });
  await coordinator.initialize();
  const packet = coordinator.store.savePacket({
    id: 'stale-evidence-packet', runtimeKey: coordinator.runtimeKey,
    evidenceStart: 7, evidenceEnd: 9, evidenceId: 'evidence:missing',
    payload: {
      records: 3, turn_refs: [], session_refs: [],
      diagnosis: { issues: [{ code: 'repeated_reason', reason: 'provider_timeout', count: 3 }] },
    },
  });

  try {
    const stage = await coordinator.runNow();
    assert.equal(stage.state, 'completed', stage.error?.stack);
    assert.deepEqual(stage.result, {
      code: 'maintenance_evidence_unavailable', packet_id: packet.id,
      reason_code: 'learning_evidence_missing',
    });
    assert.equal(coordinator.store.pendingPacket(coordinator.runtimeKey), null);
    const settledRun = coordinator.store.db.prepare(
      'SELECT state, result_code FROM dream_runs ORDER BY started_at DESC LIMIT 1',
    ).get();
    assert.deepEqual({ ...settledRun }, {
      state: 'skipped', result_code: 'maintenance_evidence_unavailable',
    });
  } finally {
    coordinator.close();
  }
});

test('idle diagnosis records explicit skill requests as proposal-only opportunities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-skill-'));
  const telemetry = new ForensicTelemetry({
    workspaceRoot: root, runtimeId: 'runtime', sessionId: 'session', dbPath: join(root, 'events.db'),
  });
  await telemetry.initialize();
  telemetry.record('turn.result', 'succeeded', {}, { turnId: 'turn-skill' });
  await telemetry.flush();
  const governance = new GovernanceEngine({ sessionId: 'session' });
  await governance.initialize();
  const engine = {
    state: { state: 'idle' }, telemetry, governance,
    transcript: [{
      type: 'message', role: 'user', trust: 'operator', turnId: 'turn-skill',
      content: 'Please build a deep research skill from this workflow.',
    }],
  };
  const coordinator = new DreamCoordinator({
    workspace: { sessions: new Map([['session', { engine }]]) },
    config: resolveManifest(manifest({ workspace_root: root })), path: join(root, 'dream.db'),
  });
  await coordinator.initialize();
  assert.equal((await coordinator.runNow()).result.code, 'harvest_complete');
  assert.equal((await coordinator.runNow()).result.code, 'operational_diagnosis_complete');
  const candidate = coordinator.candidates().find((item) => item.kind === 'skill.workflow_opportunity');
  assert.equal(candidate.state, 'observed');
  assert.equal(coordinator.candidate(candidate.id).payload.state, 'specification_only');
  coordinator.close();
  await telemetry.close();
});

test('idle project memory creates an inspectable proposal from explicit operator decisions only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-project-memory-'));
  const telemetry = new ForensicTelemetry({
    workspaceRoot: root, runtimeId: 'runtime', sessionId: 'session', dbPath: join(root, 'events.db'),
  });
  await telemetry.initialize();
  telemetry.record('turn.result', 'succeeded', {}, { turnId: 'turn-decision' });
  await telemetry.flush();
  const governance = new GovernanceEngine({ sessionId: 'session' });
  await governance.initialize();
  const config = resolveManifest(manifest({ workspace_root: root }));
  const engine = {
    state: { state: 'idle' }, telemetry, governance,
    transcript: [
      { type: 'message', role: 'user', trust: 'operator', turnId: 'turn-decision', content: 'We decided the governance engine owns evidence policy.' },
      { type: 'message', role: 'assistant', trust: 'model', turnId: 'turn-decision', content: 'We should silently rewrite NNA.md.' },
    ],
  };
  const coordinator = new DreamCoordinator({
    workspace: { sessions: new Map([['session', { engine }]]) }, config,
    path: join(root, 'dream.db'),
  });
  await coordinator.initialize();
  assert.equal((await coordinator.runNow()).result.code, 'harvest_complete');
  assert.equal((await coordinator.runNow()).result.code, 'operational_diagnosis_complete');
  const stage = await coordinator.runNow();
  assert.equal(stage.result.code, 'project_memory_proposal_created');
  const candidate = coordinator.candidate(stage.result.candidate_id);
  assert.equal(candidate.state, 'observed');
  assert.match(candidate.payload.new_region, /governance engine owns evidence policy/u);
  assert.doesNotMatch(candidate.payload.new_region, /silently rewrite/u);
  assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(join(root, 'NNA.md'), 'utf8').catch((error) => error.code)), 'ENOENT');
  coordinator.close();
  await telemetry.close();
});

test('idle NNM hygiene uses a read-only hook receipt and creates attention, never mutations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-hygiene-'));
  const governance = new GovernanceEngine({ sessionId: 'session' });
  await governance.initialize();
  let dispatched = null;
  const engine = {
    state: { state: 'idle' }, governance, telemetry: null, transcript: [],
    hooks: { health: () => ({ bundles: [{ bundle: 'notnative-memory', version: '1.6.0', status: 'loaded' }] }) },
    eventFactory: { create: (name, category, phase, _correlation, payload) => ({ event_name: name, category, phase, payload }) },
    events: { dispatch: async (event) => { dispatched = event; return { decision: 'continue', results: [] }; } },
  };
  const receipt = {
    contract: 'nnm.hygiene-receipt/1.0', receipt_id: 'b'.repeat(64), session_id: 'session',
    status: 'completed', candidates: 3, categories: { conflict: 2, stale: 1 },
    project_fingerprint: governanceFingerprint(root), completed_at: new Date().toISOString(),
  };
  const coordinator = new DreamCoordinator({
    workspace: { sessions: new Map([['session', { engine }]]) },
    config: resolveManifest(manifest({ workspace_root: root })), path: join(root, 'dream.db'),
    nnmHygieneReceipts: { latest: async () => receipt },
  });
  await coordinator.initialize();
  const packet = coordinator.store.savePacket({
    id: 'hygiene-packet', runtimeKey: coordinator.runtimeKey, evidenceStart: 1, evidenceEnd: 1,
    evidenceId: 'evidence:window', payload: { records: 1, turn_refs: [], session_refs: [] },
  });
  coordinator.store.advancePacket(packet.id, 2, 'diagnosed');
  coordinator.store.advancePacket(packet.id, 3, 'project_memory_skipped');
  coordinator.store.advancePacket(packet.id, 4, 'nnm_reconciled');
  const stage = await coordinator.runNow();
  const candidate = stage.result?.candidate_id ? coordinator.candidate(stage.result.candidate_id) : null;
  const pending = coordinator.store.pendingPacket(coordinator.runtimeKey);
  coordinator.close();
  assert.equal(stage.state, 'completed', stage.error?.stack);
  assert.equal(stage.result.code, 'nnm_hygiene_scanned');
  assert.equal(dispatched.event_name, 'maintenance.idle');
  assert.equal(dispatched.payload.evidence_packet_id, packet.id);
  assert.equal(candidate.kind, 'memory.hygiene_attention');
  assert.deepEqual(candidate.payload, { candidates: 3, categories: { conflict: 2, stale: 1 } });
  assert.equal(pending, null);
});

test('deterministic oversized NNM receipts settle each optional stage instead of retrying forever', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-receipt-bound-'));
  const engine = {
    state: { state: 'idle' }, telemetry: null, transcript: [],
    hooks: { health: () => ({ bundles: [{ bundle: 'notnative-memory', version: '1.6.0', status: 'loaded' }] }) },
    eventFactory: { create: () => ({ event_name: 'maintenance.idle' }) },
    events: { dispatch: async () => ({ decision: 'continue', results: [] }) },
  };
  const tooLarge = async () => { throw Object.assign(new Error('oversized'), { code: 'nnm_receipts_too_large' }); };
  const coordinator = new DreamCoordinator({
    workspace: { sessions: new Map([['session', { engine }]]) },
    config: resolveManifest(manifest({ workspace_root: root })), path: join(root, 'dream.db'),
    nnmReceipts: { matching: tooLarge }, nnmHygieneReceipts: { latest: tooLarge },
  });
  await coordinator.initialize();
  const packet = coordinator.store.savePacket({
    id: 'oversized-receipt-packet', runtimeKey: coordinator.runtimeKey,
    evidenceStart: 1, evidenceEnd: 1, evidenceId: 'evidence:window',
    payload: { records: 1, turn_refs: [], session_refs: [] },
  });
  coordinator.store.advancePacket(packet.id, 2, 'diagnosed');
  coordinator.store.advancePacket(packet.id, 3, 'project_memory_skipped');
  assert.equal((await coordinator.runNow()).result.code, 'nnm_receipts_too_large');
  assert.equal(coordinator.store.pendingPacket(coordinator.runtimeKey).stage, 4);
  assert.equal((await coordinator.runNow()).result.code, 'nnm_receipts_too_large');
  assert.equal(coordinator.store.pendingPacket(coordinator.runtimeKey), null);
  coordinator.close();
});

test('learning candidates persist bounded evidence and require governed authority to promote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-learning-candidate-'));
  const path = join(root, 'dream.db');
  const store = new DreamStore({ path });
  await store.initialize();
  const governance = new GovernanceEngine({ sessionId: 'session' });
  await governance.initialize();
  const scope = { kind: 'workspace', fingerprint: governanceFingerprint(root) };
  await governance.registerEvidence({
    id: 'evidence:verified-test', kind: 'verified_outcome', origin: 'tool_result',
    trust: 'observed', state: 'active', freshness: 'current', conflict: 'none',
    sourceRef: 'turn:1', sourceFingerprint: 'turn:1', contentFingerprint: 'passed',
    scope, observedAt: Date.now(), attributes: { result: 'passed' },
  });
  await governance.registerEvidence({
    id: 'evidence:operator-grant', kind: 'maintenance_grant', origin: 'operator',
    trust: 'authority', state: 'active', freshness: 'current', conflict: 'none',
    sourceRef: 'grant:1', sourceFingerprint: 'grant:1', contentFingerprint: 'workspace-guidance',
    scope, observedAt: Date.now(), attributes: { capability: 'guidance_promotion' },
  });
  const registry = new LearningCandidateRegistry({ store, governance, runtimeKey: 'workspace-a', scope });
  const observed = await registry.observe({
    id: 'candidate-guidance-1', kind: 'guidance.project_memory', confidence: 0.8,
    evidenceRefs: ['evidence:verified-test'], expectedBenefit: 'Preserve a verified project convention.',
    successCriteria: ['Managed guidance contains the verified convention exactly once.'],
    riskClass: 'reversible', payload: { section: 'Working conventions', statement: 'Run checks before commit.' },
  });
  assert.equal(observed.state, 'observed');
  assert.equal(governance.evidence('evidence:candidate:candidate-guidance-1').state, 'quarantined');
  assert.equal(governance.health().status, 'ready');
  assert.equal(governance.health().pending_evidence, 1);
  assert.equal(governance.health().unsettled_decisions, 0);
  for (const state of ['gathering', 'ready', 'validating', 'proposed']) await registry.advance(observed.id, state);
  await assert.rejects(() => registry.promote(observed.id, { authorityRefs: [] }), { code: 'learning_authority_required' });
  const active = await registry.promote(observed.id, { authorityRefs: ['evidence:operator-grant'] });
  assert.equal(active.state, 'active');
  assert.equal(governance.evidence('evidence:candidate:candidate-guidance-1').state, 'active');
  assert.ok(governance.audit().some((decision) => decision.domain === 'guidance_promotion' && decision.outcome === 'promote'));
  store.close();

  const restored = new DreamStore({ path });
  await restored.initialize();
  assert.equal(restored.candidate(observed.id).state, 'active');
  assert.equal(restored.status().candidates.active, 1);
  restored.close();
});

test('learning candidates reject secrets, drift, and invalid state shortcuts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-learning-guard-'));
  const store = new DreamStore({ path: join(root, 'dream.db') });
  await store.initialize();
  const base = {
    id: 'candidate-safe', runtimeKey: 'workspace-a', kind: 'recovery.ordering',
    scope: { kind: 'workspace', fingerprint: governanceFingerprint(root) }, confidence: 0.5,
    evidenceRefs: ['evidence:one'], expectedBenefit: 'Reduce a repeated recovery failure.',
    successCriteria: ['Recovery succeeds in the bounded fixture.'], riskClass: 'low',
    payload: { failure_code: 'provider_timeout', action: 'retry' },
  };
  store.observeCandidate(base);
  assert.throws(() => store.transitionCandidate(base.id, 'active'), { code: 'dream_candidate_transition_invalid' });
  assert.throws(() => store.observeCandidate({ ...base, payload: { password: 'do-not-store' } }), { code: 'dream_candidate_secret_forbidden' });
  assert.throws(() => store.observeCandidate({ ...base, payload: { action: 'compact' } }), { code: 'dream_candidate_drift' });
  store.close();
});

test('learning candidates reject nested secret-bearing fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-secret-'));
  const store = new DreamStore({ path: join(root, 'dream.db') });
  await store.initialize();
  assert.throws(() => store.observeCandidate({
    id: 'candidate-nested-secret', runtimeKey: 'runtime', kind: 'guidance.test',
    scope: { kind: 'workspace', fingerprint: 'a'.repeat(64) }, confidence: 1,
    evidenceRefs: ['evidence:test'], expectedBenefit: 'test', successCriteria: ['safe'],
    riskClass: 'low', payload: { safe: { auth_token: 'hidden' } },
  }), { code: 'dream_candidate_secret_forbidden' });
  store.close();
});

function manifest(extra = {}) {
  return {
    format_version: 1, persistence: 'ephemeral', workspace_root: process.cwd(),
    provider: {
      id: 'local', endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture', trust_zone: 'loopback',
    },
    ...extra,
  };
}

function createHashForTest(value) {
  return governanceFingerprint(value).slice(0, 32);
}
