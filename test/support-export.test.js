// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { ForensicTelemetry } from '../src/forensic-telemetry.js';
import { JournalStore } from '../src/store.js';
import { createSessionLineage } from '../src/session-lineage.js';
import { discoverSupportSessions } from '../src/support-session-discovery.js';
import { DiagnosticBundle } from '../src/diagnostic-bundle.js';
import { supportTelemetryProjection } from '../src/forensic-telemetry-sanitize.js';

test('support trace pages beyond 5000 events and declares bounded snapshot coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-support-pagination-'));
  const telemetry = new ForensicTelemetry({ root, workspaceRoot: root, sessionId: 'parent', runtimeId: 'runtime' });
  await telemetry.initialize();
  try {
    for (let index = 0; index < 6005; index += 1) telemetry.record('context.budget', 'measured', {
      context_window_tokens: 300000, index, content: 'private prompt',
    });
    await telemetry.flush();
    const snapshot = await telemetry.supportSnapshot();
    assert.equal(snapshot.rows.filter((row) => row.event_name === 'context.budget').length, 6005);
    assert.equal(snapshot.coverage.complete, true);
    assert.equal(snapshot.coverage.exported_rows, snapshot.coverage.available_rows);
    assert.equal(snapshot.rows.at(-1).payload_summary.context_window_tokens, 300000);
    assert.doesNotMatch(JSON.stringify(snapshot), /private prompt/u);
    const partial = await telemetry.supportSnapshot({ limit: 10 });
    assert.equal(partial.rows.length, 10); assert.equal(partial.coverage.complete, false);
    assert.ok(partial.coverage.available_rows > partial.coverage.exported_rows);
    assert.ok(snapshot.rows.every((row, index) => !index || row.id > snapshot.rows[index - 1].id));
  } finally { await telemetry.close(); }
});

test('support trace preserves compaction and accounting diagnostics without raw content', () => {
  const row = supportTelemetryProjection({ event_name: 'context.compaction', payload: {
    trigger: 'tool_payload_budget', before_estimated_tokens: 55938, after_estimated_tokens: 24841,
    context_window_tokens: 300000, effective_input_tokens: 268000, measurement_basis: 'complete_provider_input',
    content: 'private transcript', api_key: 'hidden',
    accounting: { accounted_input_tokens: 5417, prompt: 'private prompt' },
  } });
  assert.equal(row.payload_summary.trigger, 'tool_payload_budget');
  assert.equal(row.payload_summary.before_estimated_tokens, 55938);
  assert.equal(row.payload_summary.accounting.accounted_input_tokens, 5417);
  assert.doesNotMatch(JSON.stringify(row), /private|hidden/u);
});

test('bundle discovers closed children from journals and exports their audit evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-support-descendants-'));
  const parentStore = new JournalStore(join(root, 'sessions'), 'parent'); await parentStore.open();
  const engine = { sessionId: 'parent', storeRoot: parentStore.root, store: parentStore,
    reviewerRoot: join(root, 'reviews'), governanceRoot: join(root, 'governance'),
    active: { turnId: 'turn', stepId: 'step' }, config: { limits: { maxContextBytes: 2097152 } },
    health: async () => ({ status: 'ready' }), reviewerAudit: () => [], governanceAudit: () => [],
    telemetry: { flush: async () => {}, supportSnapshot: async ({ sessionId }) => ({ format: 2, rows: [{ session_id: sessionId }],
      open_spans: [], coverage: { complete: true, available_rows: 1, exported_rows: 1 } }) } };
  const lineage = createSessionLineage(engine, 'child', 'reviewer', { toolRequestId: 'launch' });
  await parentStore.append('session_created', { sessionId: 'parent' });
  await parentStore.append('subagent_session', { ...lineage, state: 'completed' });
  const child = new JournalStore(parentStore.root, 'child'); await child.open();
  await child.append('session_created', { sessionId: 'child', lineage, diagnostic_configuration: { model: 'worker' } });
  await child.append('message', { content: 'private transcript' }); await child.close();
  const review = new JournalStore(engine.reviewerRoot, 'child.review'); await review.open();
  await review.append('proposal', { requestId: 'child-tool', toolName: 'fs_read', classification: { risk: 0 },
    guidance: 'private reviewer text', authorityAnchors: [{ quote: 'private operator quote' }] }); await review.close();
  const governance = new JournalStore(engine.governanceRoot, 'child.governance'); await governance.open();
  await governance.append('decision_committed', { decision: { id: 'decision', outcome: 'approve' } }); await governance.close();
  await parentStore.close();
  const sessions = await discoverSupportSessions([{ id: 'parent', engine }]);
  assert.deepEqual(sessions.map((session) => session.id), ['parent', 'child']);
  assert.equal(sessions[1].lineage.launching_tool_request_id, 'launch');
  assert.equal(sessions[1].engine.diagnosticConfiguration.model, 'worker');
  const bundle = new DiagnosticBundle({ engine }); const path = join(root, 'support.zip'); await bundle.create(path);
  const entries = zipEntries(await readFile(path)); const manifest = JSON.parse(entries.get('manifest.json'));
  assert.equal(manifest.sessions.length, 2);
  const childFolder = manifest.sessions.find((session) => session.session_id === 'child').folder;
  const diagnostics = JSON.parse(entries.get(`${childFolder}/diagnostics.json`));
  assert.equal(diagnostics.reviewer_trace.records[0].payload.requestId, 'child-tool');
  assert.equal(diagnostics.governance_trace.records[0].payload.decision.outcome, 'approve');
  assert.equal(diagnostics.reviewer_trace.coverage.complete, true);
  assert.doesNotMatch([...entries.values()].join('\n'), /private transcript|private reviewer text|private operator quote/u);
  assert.equal(manifest.sessions[0].discovery.historical_associations, 'unknown');
});

test('missing child journals are explicit and mismatched lineage is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-support-missing-'));
  const store = new JournalStore(root, 'parent'); await store.open();
  const engine = { sessionId: 'parent', storeRoot: root, store, active: { turnId: 'turn', stepId: 'step' } };
  const lineage = createSessionLineage(engine, 'child', 'general');
  await store.append('session_created', { sessionId: 'parent' });
  await store.append('subagent_session', { ...lineage, state: 'failed' }); await store.close();
  const sessions = await discoverSupportSessions([{ id: 'parent', engine }]);
  assert.equal(sessions[1].discovery.complete, false); assert.equal(sessions[1].discovery.reason, 'ENOENT');
  const child = new JournalStore(root, 'child'); await child.open();
  await child.append('session_created', { sessionId: 'child', lineage: { ...lineage, parent_session_id: 'foreign' } }); await child.close();
  await assert.rejects(discoverSupportSessions([{ id: 'parent', engine }]), { code: 'session_history_invalid' });
});

test('related session count overflow fails explicitly instead of dropping sessions', async () => {
  const sessions = Array.from({ length: 64 }, (_, index) => ({ id: `session-${index}`, engine: {} }));
  await assert.rejects(discoverSupportSessions(sessions), { code: 'zip_entries_invalid' });
});

function zipEntries(buffer) {
  const entries = new Map(); let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18); const nameLength = buffer.readUInt16LE(offset + 26);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + buffer.readUInt16LE(offset + 28);
    const data = buffer.subarray(start, start + size);
    entries.set(name, (buffer.readUInt16LE(offset + 8) === 8 ? inflateRawSync(data) : data).toString('utf8'));
    offset = start + size;
  }
  return entries;
}
