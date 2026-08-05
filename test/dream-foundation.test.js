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

test('manual deterministic harvest checkpoints only terminal redacted telemetry evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dream-harvest-'));
  const telemetry = new ForensicTelemetry({
    workspaceRoot: root, runtimeId: 'runtime', sessionId: 'session', dbPath: join(root, 'events.db'),
  });
  await telemetry.initialize();
  telemetry.record('tool.execute', 'succeeded', { tool_name: 'fs.read_text' }, { turnId: 'turn-1' });
  telemetry.record('provider.attempt', 'failed', { code: 'provider_timeout' }, { turnId: 'turn-1', reasonCode: 'provider_timeout' });
  await telemetry.flush();
  const config = resolveManifest(manifest({ workspace_root: root }));
  const workspace = { sessions: new Map([['session', { engine: { state: { state: 'idle' }, telemetry } }]]) };
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
  coordinator.close();
  await telemetry.close();
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
