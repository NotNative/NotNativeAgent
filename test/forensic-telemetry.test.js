// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForensicTelemetry } from '../src/forensic-telemetry.js';
import { sanitizeTelemetry, supportTelemetryProjection } from '../src/forensic-telemetry-sanitize.js';
import { LifecycleRegistry, StateAuthority } from '../src/lifecycle.js';
import { DatabaseSync } from 'node:sqlite';

test('local forensic telemetry persists correlated rich evidence with secret redaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-forensic-'));
  const telemetry = telemetryAt(root);
  await telemetry.initialize();
  telemetry.record('model.prompt', 'started', {
    content: 'Inspect the project', api_key: 'do-not-store', token_count: 42,
    authorization: 'Bearer hidden-value-123456789',
  }, { spanId: 'model-span', turnId: 'turn-1', stepId: 'step-1' });
  telemetry.record('model.prompt', 'succeeded', { output: 'Done' }, {
    spanId: 'model-span', turnId: 'turn-1', stepId: 'step-1', durationMs: 12.5,
  });
  await telemetry.flush();
  const rows = await telemetry.query({ turnId: 'turn-1' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].payload.api_key, '[redacted]');
  assert.equal(rows[0].payload.authorization, '[redacted]');
  assert.equal(rows[0].payload.token_count, 42);
  assert.equal(rows[1].duration_ms, 12.5);
  assert.equal(JSON.stringify(rows).includes('do-not-store'), false);
  await telemetry.close();
  assert.ok((await readFile(join(root, 'events.db'))).length > 0);
});

test('open span query reports operations without a terminal disposition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-forensic-open-'));
  const telemetry = telemetryAt(root);
  await telemetry.initialize();
  telemetry.record('tool.execute', 'started', { tool_name: 'fs.read_text' }, { spanId: 'open-tool', toolRequestId: 'tool-1' });
  telemetry.record('provider.attempt', 'started', {}, { spanId: 'closed-provider' });
  telemetry.record('provider.attempt', 'failed', { code: 'provider_timeout' }, { spanId: 'closed-provider' });
  await telemetry.flush();
  const spans = await telemetry.openSpans();
  assert.ok(spans.some((row) => row.span_id === 'open-tool'));
  assert.equal(spans.some((row) => row.span_id === 'closed-provider'), false);
  await telemetry.close();
});

test('telemetry bounds oversized content and support projection excludes free-form evidence', () => {
  const sanitized = sanitizeTelemetry({ content: 'x'.repeat(80_000), password: 'hidden' });
  assert.equal(sanitized.password, '[redacted]');
  assert.equal(sanitized.content._nna_telemetry, 'text_truncated');
  assert.equal(sanitized.content.bytes, 80_000);
  const projected = supportTelemetryProjection({
    id: 1, timestamp: 'now', event_name: 'model.prompt', status: 'failed', payload: {
      content: 'private prompt', model_name: 'local-model', reason_code: 'bad_stream',
    },
  });
  assert.equal(JSON.stringify(projected).includes('private prompt'), false);
  assert.equal(projected.payload_summary.model_name, 'local-model');
});

test('telemetry preserves repeated aliases while marking only active traversal cycles', () => {
  const shared = { category: 'tool_no_progress', action: 'nudge' };
  const cyclic = { label: 'cycle' };
  cyclic.self = cyclic;
  const sanitized = sanitizeTelemetry({ completed_progress: [shared], recovery: [shared], cyclic });
  assert.deepEqual(sanitized.completed_progress[0], shared);
  assert.deepEqual(sanitized.recovery[0], shared);
  assert.equal(sanitized.cyclic.self._nna_telemetry, 'circular_reference');
});

test('telemetry sanitizer handles built-in objects and sensitive key variants', () => {
  const sanitized = sanitizeTelemetry({
    at: new Date('2026-08-15T00:00:00.000Z'), values: new Set(['one']),
    secrets: new Map([['api_key_hash', 'hidden']]), password_reset: 'hidden-too',
  });
  assert.equal(sanitized.at, '2026-08-15T00:00:00.000Z');
  assert.deepEqual(sanitized.values, ['one']);
  assert.equal(sanitized.secrets[0][1], '[redacted]');
  assert.equal(sanitized.password_reset, '[redacted]');
  assert.throws(() => supportTelemetryProjection(null), { code: 'telemetry_row_invalid' });
});

test('state transitions and lifecycle records produce paired forensic spans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-forensic-phases-'));
  const telemetry = telemetryAt(root);
  await telemetry.initialize();
  const state = new StateAuthority();
  const lifecycles = new LifecycleRegistry();
  state.setObserver(telemetry.stateObserver());
  lifecycles.setObserver(telemetry.lifecycleObserver());
  const turn = lifecycles.start('turn');
  state.transition('preparing_turn', { trigger: 'test', turnId: turn.id });
  lifecycles.finish(turn.id, 'succeeded');
  await telemetry.flush();
  const rows = await telemetry.query({ sessionId: 'session-test', limit: 100 });
  const transitions = rows.filter((row) => row.event_name === 'state.transition');
  const lifecycle = rows.filter((row) => row.event_name === 'lifecycle.record' && row.span_id === turn.id);
  assert.deepEqual(transitions.map((row) => row.status), ['started', 'succeeded']);
  assert.deepEqual(lifecycle.map((row) => row.status), ['started', 'succeeded']);
  assert.equal((await telemetry.openSpans()).some((row) => row.span_id === turn.id), false);
  await telemetry.close();
});

test('continued hook failures retain their real terminal telemetry status', () => {
  const telemetry = telemetryAt(process.cwd());
  const records = [];
  telemetry.record = (...args) => { records.push(args); return true; };
  const observer = telemetry.eventObserver();
  const event = { event_id: 'event-1', event_name: 'context_checkpoint.terminal', category: 'context_checkpoint', phase: 'terminal' };
  const subscription = { id: 'hook.user.memory.1' };
  observer.subscriberFinished(event, subscription, 'span-1', { decision: 'continue', code: 'hook_timeout' }, 30_000);
  observer.subscriberFinished(event, subscription, 'span-2', { decision: 'continue', code: 'hook_spawn_failed' }, 2);
  observer.subscriberFinished(event, subscription, 'span-3', { decision: 'continue', code: 'hook_completed' }, 3);
  assert.deepEqual(records.map(([, status]) => status), ['timed_out', 'failed', 'succeeded']);
  assert.deepEqual(records.map(([, , , correlation]) => correlation.reasonCode), ['hook_timeout', 'hook_spawn_failed', undefined]);
  assert.deepEqual(records.map(([, , , correlation]) => correlation.outcome), ['continue', 'continue', 'continue']);
});

test('volatile TUI telemetry expires independently after its short retention window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-forensic-volatile-'));
  const dbPath = join(root, 'events.db');
  const telemetry = telemetryAt(root, { volatileMaxAgeMs: 1000 });
  await telemetry.initialize();
  telemetry.record('tui.mouse', 'observed', { type: 'click', button: 'right' });
  telemetry.record('engine.phase', 'succeeded', { phase: 'test' });
  await telemetry.close();
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE events SET timestamp = ? WHERE event_name IN ('tui.mouse', 'engine.phase')")
    .run(new Date(Date.now() - 2000).toISOString());
  db.close();
  const reopened = telemetryAt(root, { volatileMaxAgeMs: 1000 });
  const health = await reopened.initialize();
  const rows = await reopened.query({ sessionId: 'session-test', limit: 100 });
  assert.equal(rows.some((row) => row.event_name === 'tui.mouse'), false);
  assert.equal(rows.some((row) => row.event_name === 'engine.phase'), true);
  assert.equal(health.volatileRetentionDays, 1000 / 86_400_000);
  await reopened.close();
});

test('telemetry degradation is observable but never process-fatal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-forensic-degraded-'));
  const blockedParent = join(root, 'not-a-directory');
  await writeFile(blockedParent, 'occupied');
  const telemetry = new ForensicTelemetry({
    workspaceRoot: root, runtimeId: 'runtime-test', sessionId: 'session-test',
    dbPath: join(blockedParent, 'events.db'), maxAgeMs: 86_400_000, maxBytes: 4_194_304,
  });
  const unhandled = [];
  const observe = (error) => unhandled.push(error);
  process.on('unhandledRejection', observe);
  try {
    const initialized = await telemetry.initialize();
    assert.equal(initialized.status, 'degraded');
    assert.equal(initialized.code, 'telemetry_open_failed');
    assert.equal(telemetry.record('engine.phase', 'started', {}), false);
    assert.deepEqual(await telemetry.query({ limit: 10 }), []);
    assert.deepEqual(await telemetry.openSpans(), []);
    assert.equal((await telemetry.flush()).status, 'degraded');
    await telemetry.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener('unhandledRejection', observe);
    await telemetry.close();
  }
});

function telemetryAt(root, options = {}) {
  return new ForensicTelemetry({
    workspaceRoot: root, runtimeId: 'runtime-test', sessionId: 'session-test',
    dbPath: join(root, 'events.db'), maxAgeMs: 86_400_000, maxBytes: 4_194_304, ...options,
  });
}
