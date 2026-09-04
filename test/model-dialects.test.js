// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelDialectRegistry } from '../src/reliability/model-dialects.js';
import { qualifyModel } from '../src/provider/model-qualification.js';

test('model dialect profiles persist provider observations while tool-contract lessons stay quarantined', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-dialect-'));
  const path = join(root, 'dialects.json');
  const route = { profile: { id: 'local' }, model: 'qwen3.8-27b' };
  const registry = new ModelDialectRegistry({ path });
  await registry.initialize();
  assert.match(registry.instructions(route), /native tool calls/u);
  registry.observe(route, { status: 'failed', code: 'provider_event_invalid' });
  registry.observe(route, { status: 'failed', code: 'tool_arguments_invalid' });
  assert.doesNotMatch(registry.instructions(route), /recent local schema failures/iu);
  registry.observeToolContract(route, {
    status: 'failed', tool: 'fs.edit_text', version: 3, reason_code: 'tool_schema_invalid',
  });
  registry.observeToolContract(route, {
    status: 'repaired', tool: 'fs.edit_text', version: 3, reason_code: 'tool_schema_invalid',
  });
  await registry.close();

  const restored = new ModelDialectRegistry({ path });
  await restored.initialize();
  const profile = restored.snapshot(route);
  assert.equal(profile.family, 'qwen');
  assert.equal(profile.observations, 2);
  assert.equal(profile.failures.provider_event_invalid, 1);
  assert.equal(profile.tool_contract_learning.mode, 'shadow');
  assert.equal(profile.tool_contract_learning.epoch, 3);
  assert.equal(profile.tool_contract_learning.candidates['fs.edit_text@3/tool_schema_invalid'].failures, 1);
  assert.equal(profile.tool_contract_learning.candidates['fs.edit_text@3/tool_schema_invalid'].validated_repairs, 1);
  assert.doesNotMatch(restored.instructions(route), /recent local schema failures/iu);
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

test('tool-contract candidates use an own-property-only bounded map', () => {
  const route = { profile: { id: 'local' }, model: 'fixture' };
  const registry = new ModelDialectRegistry();
  registry.observeToolContract(route, { status: 'failed', tool: '__proto__', version: 1, reason_code: 'x' });
  const candidates = registry.snapshot(route).tool_contract_learning.candidates;
  assert.equal(Object.hasOwn(candidates, '__proto__@1/x'), true);
  assert.equal(candidates['__proto__@1/x'].failures, 1);
  assert.equal(Object.prototype.failures, undefined);
});

test('successful provider observations exponentially decay stale dialect failures', async () => {
  const route = { profile: { id: 'local' }, model: 'qwen3.8-27b' };
  const registry = new ModelDialectRegistry();
  registry.observe(route, { status: 'failed', code: 'provider_event_invalid' });
  registry.observe(route, { status: 'failed', code: 'provider_event_invalid' });
  assert.match(registry.instructions(route), /Recent local provider-event failures/u);

  registry.observe(route, { status: 'succeeded', code: null });

  assert.doesNotMatch(registry.instructions(route), /Recent local provider-event failures/u);
  assert.equal(registry.snapshot(route).failures.provider_event_invalid, 1);
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
