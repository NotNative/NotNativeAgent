// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { JournalStore } from '../src/store.js';

test('provider request manifest is durable, content-free, and precedes provider dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-request-manifest-'));
  const stores = join(root, 'sessions');
  let calls = 0;
  const provider = { async *stream() {
    calls += 1;
    yield { type: 'text', text: 'Completed.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({
    config: resolveManifest({
      persistence: 'durable', workspace_root: root,
      provider: {
        id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1',
        model: 'fixture-model', trust_zone: 'loopback',
      },
    }),
    sessionId: 'manifest-session', storeRoot: stores,
    reviewerRoot: join(root, 'reviewers'), providerFactory: () => provider,
  });
  await engine.initialize();
  const secretMarker = 'operator-content-must-not-enter-manifest';
  const result = await engine.submit({ request_id: 'manifest-turn', content: secretMarker }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.equal(calls, 1);
  await engine.shutdown({ request_id: 'manifest-shutdown' });

  const store = new JournalStore(stores, 'manifest-session');
  const recovered = await store.open();
  const manifestIndex = recovered.records.findIndex((item) => item.type === 'provider_request_manifest');
  const dispatchIndex = recovered.records.findIndex((item) => item.type === 'lifecycle_event'
    && item.payload.event_name === 'provider_attempt.started');
  assert.ok(manifestIndex >= 0);
  assert.ok(dispatchIndex > manifestIndex);
  const manifest = recovered.records[manifestIndex].payload;
  assert.match(manifest.requestFingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.envelope.schema, 'nna.provider-envelope.v1');
  assert.ok(manifest.envelope.estimated_input_tokens > 0);
  assert.equal(manifest.envelope.configuration.temperature.sent, false);
  assert.ok(manifest.envelope.shape.message_count > 0);
  assert.ok(manifest.envelope.shape.tool_schema_count > 0);
  assert.equal(manifest.toolSurface.schema, 'nna.provider-tool-surface.v2');
  assert.equal(manifest.toolSurface.composition, 'foundation_with_leases');
  assert.equal(Object.hasOwn(manifest.toolSurface, 'phase'), false);
  assert.equal(manifest.toolSurface.selectedToolNames[0], 'tool.search');
  for (const name of ['shell.run', 'work.plan', 'work.goal', 'work.task_add', 'work.task_update']) {
    assert.ok(manifest.toolSurface.selectedToolNames.includes(name), `${name} missing from provider manifest`);
  }
  assert.equal(manifest.envelope.shape.tool_schema_count, manifest.toolSurface.selectedToolNames.length);
  assert.ok(manifest.toolSurface.schemaBytes > 0);
  assert.match(manifest.toolSurface.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(manifest).includes(secretMarker), false);
  await store.close();
});
