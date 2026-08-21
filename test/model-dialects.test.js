// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelDialectRegistry } from '../src/provider/model-dialects.js';
import { qualifyModel } from '../src/provider/model-qualification.js';

test('model dialect profiles persist observations and tighten guidance after repeated failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dialect-'));
  const path = join(root, 'dialects.json');
  const route = { profile: { id: 'local' }, model: 'qwen3.8-27b' };
  const registry = new ModelDialectRegistry({ path });
  await registry.initialize();
  assert.match(registry.instructions(route), /native tool calls/u);
  registry.observe(route, { status: 'failed', code: 'provider_event_invalid' });
  registry.observe(route, { status: 'failed', code: 'tool_arguments_invalid' });
  assert.match(registry.instructions(route), /recent local schema failures/iu);
  await registry.close();

  const restored = new ModelDialectRegistry({ path });
  await restored.initialize();
  const profile = restored.snapshot(route);
  assert.equal(profile.family, 'qwen');
  assert.equal(profile.observations, 2);
  assert.equal(profile.failures.provider_event_invalid, 1);
  assert.match(restored.instructions(route), /batch only independent calls/u);
  await restored.close();
});

test('detached dialect flush records an unexpected rejection', async () => {
  const records = [];
  const registry = new ModelDialectRegistry({
    telemetry: { record: (...args) => records.push(args) },
  });
  registry.flush = async () => { throw Object.assign(new Error('unexpected'), { code: 'EIO' }); };
  registry.observe({ profile: { id: 'local' }, model: 'fixture' }, { status: 'succeeded' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(records.some(([, status, detail]) => status === 'failed'
    && detail.code === 'dialect_store_flush_failed'));
});

test('qualification lab probes text and native tool-call compatibility without executing the tool', async () => {
  let calls = 0;
  const provider = { async *stream() {
    calls += 1;
    if (calls === 1) {
      yield { type: 'text', text: 'NNA_OK' };
      yield { type: 'terminal' };
      return;
    }
    yield { type: 'tool_fragment', fragments: [{
      index: 0, id: 'qualification-call',
      function: { name: 'nna_qualification_echo', arguments: '{"value":"NNA_OK"}' },
    }] };
    yield { type: 'terminal' };
  } };
  const result = await qualifyModel(provider, { profile: { id: 'local' }, model: 'fixture' }, { timeoutMs: 1000 });
  assert.equal(result.overall, 'passed');
  assert.equal(result.tools.parsed_name, 'nna_qualification_echo');
  assert.equal(calls, 2);
});
