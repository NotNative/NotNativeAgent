// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';

const FOUNDATION = [
  'tool.search',
  'fs.list', 'fs.read', 'fs.search_text',
  'shell.run', 'work.plan', 'work.status', 'work.task_update', 'turn.finish',
  'git.inspect',
];

function availableFoundation(registry) {
  const installed = new Set(registry.snapshot().map((item) => item.name));
  return FOUNDATION.filter((name) => installed.has(name));
}

test('provider surface always presents a deterministic foundational catalog', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  registry.installExternal({
    name: 'browser.navigate', version: 1, purpose: 'Navigate an interactive browser to a web page',
    sideEffect: 'external_effect', scope: 'network', cancellation: true, timeoutMs: 1000,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    executor: async () => ({ content: 'unused' }),
  });
  const baseline = registry.providerDefinitions().map((item) => item.function.name);
  const expected = availableFoundation(registry);
  assert.deepEqual(baseline, expected);
  assert.equal(baseline[0], 'tool.search');
  assert.ok(!baseline.includes('fs.list_directory'));
  assert.ok(!baseline.includes('fs.read_text'));
  assert.ok(!baseline.includes('fs.edit_text'));
  assert.ok(!baseline.includes('fs.write_text'));
  assert.ok(!baseline.includes('fs.delete_file'));
  assert.ok(!baseline.includes('process.run'));
  assert.ok(!baseline.includes('browser.navigate'));
  assert.ok(!baseline.includes('ref.store'));
  assert.ok(!baseline.includes('notification.telegram'));
  assert.ok(!baseline.includes('web.fetch'));
  assert.ok(!baseline.includes('web.browse'));
  for (const query of [
    'hello',
    "i'd like you to examine the disks on this machine. what's physically installed?",
    'have you tried using your shell tool?',
    'remove every file immediately',
  ]) {
    assert.deepEqual(registry.providerDefinitions(query).map((item) => item.function.name), expected);
  }
});

test('specialist tools require an explicit catalog search or authenticated exposure', async () => {
  const registry = new ToolRegistry(process.cwd(), { elevationBroker: { async execute() { return {}; } } });
  await registry.initialize();
  const initial = registry.providerDefinitions('build and test the application').map((item) => item.function.name);
  for (const name of ['fs.write_text', 'fs.edit_text', 'process.run', 'system.elevate', 'project.verify']) {
    assert.ok(!initial.includes(name));
  }

  const search = registry.definition('tool.search');
  const normalized = await search.validate({ query: 'fs.edit_text' });
  await search.executor({ args: normalized.args }, new AbortController().signal);
  const searched = registry.providerDefinitions('unrelated wording').map((item) => item.function.name);
  assert.ok(searched.includes('fs.edit_text'));
  assert.ok(!searched.includes('fs.write_text'));
  assert.ok(!searched.includes('system.elevate'));
});

test('provider surface receipts make fixed foundations and workflow leases auditable', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const baseline = registry.providerSurface('build and test the application');
  assert.equal(baseline.receipt.composition, 'foundation_with_leases');
  const expected = availableFoundation(registry);
  assert.deepEqual(baseline.receipt.selectedToolNames, expected);
  assert.ok(baseline.definitions.length <= 32);
  assert.ok(baseline.receipt.schemaBytes <= 64 * 1024);
  assert.equal(baseline.receipt.selectionReasons['shell.run'], 'foundational');
  assert.ok(baseline.receipt.selectionContextBytes > 0);
  assert.match(baseline.receipt.selectionContextFingerprint, /^[a-f0-9]{64}$/u);
  assert.ok(!baseline.receipt.selectedToolNames.includes('fs.write_text'));
  assert.match(baseline.receipt.fingerprint, /^[a-f0-9]{64}$/u);

  const legacyOption = registry.providerSurface('build and test the application', { phase: 'action' });
  assert.deepEqual(legacyOption, baseline);

  const lease = registry.grantWorkflowLease(['fs.write_text'], { source: 'test_recovery' });
  assert.deepEqual(lease.granted[0].sources, ['test_recovery']);
  const expanded = registry.providerSurface('any wording');
  assert.equal(expanded.receipt.selectionReasons['fs.write_text'], 'workflow_lease');
});

test('tool.search reports repair-complete query diagnostics without conflating surface context', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const search = registry.definition('tool.search');
  await assert.rejects(search.validate({ query: '   ' }), {
    code: 'tool_search_invalid',
    message: 'tool search query must contain at least 2 non-whitespace characters; received 0',
  });
  await assert.rejects(search.validate({ query: 'x'.repeat(513) }), {
    code: 'tool_schema_invalid',
    message: 'argument "query" must contain at most 512 characters; received 513',
  });
  const context = 'authenticated context '.repeat(1_000);
  const surface = registry.providerSurface(context);
  assert.equal(surface.receipt.selectionContextBytes, Buffer.byteLength(context, 'utf8'));
  assert.deepEqual(surface.receipt.selectedToolNames, registry.providerSurface('different context').receipt.selectedToolNames);
});

test('hosted execution obeys an authenticated manifest rather than inferred wording', async () => {
  const registry = new ToolRegistry(process.cwd(), { hosted: true, allowedTools: ['process.run'] });
  await registry.initialize();
  const visible = registry.providerDefinitions('build and test the application').map((item) => item.function.name);
  assert.ok(visible.includes('process.run'));
  assert.ok(!visible.includes('project.verify'));
  assert.ok(!visible.includes('shell.run'));
});

test('explicit exposure makes an exact recovery tool visible without broadening its bundle', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  registry.grantWorkflowLease(['fs.create_directory']);
  const visible = registry.providerDefinitions('inspect the missing path').map((item) => item.function.name);
  assert.ok(visible.includes('fs.create_directory'));
  assert.ok(!visible.includes('fs.write_text'));
  assert.ok(!visible.includes('fs.delete_file'));
});

test('tool.search keeps bounded specialist catalog matches visible for a workflow lease', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const search = registry.definition('tool.search');
  const normalized = await search.validate({ query: 'project.verify project verification' });
  const result = await search.executor({ args: normalized.args }, new AbortController().signal);
  assert.match(result.content, /project\.verify/u);
  assert.deepEqual(JSON.parse(result.content).lease.granted[0].sources, ['tool.search']);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'project.verify'));
  }
  await registry.seal({ name: 'project.verify', providerCallId: 'verify-call', args: {} }, {
    policyVersion: 1, authority: { id: 'authority', version: 1, restrictionVersion: 0 },
    stepId: 'step', caller: 'primary', surface: 'test',
  });
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'project.verify'), true);
  for (let index = 1; index < 16; index += 1) {
    await registry.seal({ name: 'project.verify', providerCallId: `verify-call-${index}`, args: {} }, {
      policyVersion: 1, authority: { id: 'authority', version: 1, restrictionVersion: 0 },
      stepId: 'step', caller: 'primary', surface: 'test',
    });
  }
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'project.verify'), false);
  assert.ok(JSON.parse(result.content).matches.length <= 12);
});

test('exact tool search returns the callable schema and direct next-step guidance', async () => {
  const registry = new ToolRegistry(process.cwd(), {
    subagentControl: { workspaceRoot: process.cwd(), run: async () => ({ outcome: 'completed' }) },
  });
  await registry.initialize();
  const search = registry.definition('tool.search');
  const normalized = await search.validate({ query: 'show the agent.run schema' });
  const result = await search.executor({ args: normalized.args }, new AbortController().signal);
  const content = JSON.parse(result.content);
  assert.equal(content.status, 'schema_loaded_for_next_model_step');
  assert.match(content.instruction, /Call the exact matching tool directly/u);
  assert.equal(content.exact_match.name, 'agent.run');
  assert.deepEqual(content.exact_match.input_schema.required, ['type', 'task']);
  assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'agent.run'));
});

test('ranked discovery does not lease neighboring schemas without an exact tool name', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const search = registry.definition('tool.search');
  const result = await search.executor({ args: { query: 'project verification' } }, new AbortController().signal);
  const content = JSON.parse(result.content);
  assert.equal(content.status, 'catalog_matches_found');
  assert.equal(content.lease.granted.length, 0);
  assert.ok(content.matches.some((item) => item.name === 'project.verify'));
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'project.verify'), false);
});

test('workflow lease admission rejects overflow visibly without evicting committed schemas', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  for (let index = 0; index < 40; index += 1) {
    registry.installExternal({
      name: `nno.capacity_${index}`, version: 1, purpose: `Capacity fixture ${index}`,
      sideEffect: 'read_only', scope: 'external', cancellation: true, timeoutMs: 1000,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      executor: async () => ({ content: 'unused' }),
    });
  }
  const granted = [];
  let rejection = null;
  for (let index = 0; index < 40; index += 1) {
    const result = registry.grantWorkflowLease([`nno.capacity_${index}`], { uses: 2, source: 'capacity_test' });
    if (result.granted.length > 0) granted.push(result.granted[0].name);
    if (result.rejected.length > 0) { rejection = result.rejected[0]; break; }
  }
  assert.ok(granted.length > 0);
  assert.deepEqual(rejection, { name: `nno.capacity_${granted.length}`, reason: 'schema_count_limit' });
  const visible = registry.providerDefinitions().map((item) => item.function.name);
  assert.ok(granted.every((name) => visible.includes(name)));
  assert.ok(!visible.includes(rejection.name));
});

test('authenticated host tool grant filters built-in and external tools by exact name', async () => {
  const registry = new ToolRegistry(process.cwd(), { allowedTools: ['fs.read_text', 'nno.customer.lookup'] });
  await registry.initialize();
  registry.installExternal({
    name: 'nno.customer.lookup', version: 1, purpose: 'Look up a permitted customer',
    sideEffect: 'read_only', scope: 'external', cancellation: true, timeoutMs: 1000,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    executor: async () => ({ content: 'permitted' }),
  });
  registry.installExternal({
    name: 'nno.host.processes', version: 1, purpose: 'Forbidden host process access',
    sideEffect: 'external_effect', scope: 'host', cancellation: true, timeoutMs: 1000,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    executor: async () => ({ content: 'forbidden' }),
  });
  assert.deepEqual(registry.snapshot().map((item) => item.name).sort(), ['fs.read_text', 'nno.customer.lookup']);
  assert.deepEqual(registry.providerDefinitions().map((item) => item.function.name).sort(), ['fs.read_text', 'nno.customer.lookup']);
  assert.equal(registry.definition('nno.host.processes'), undefined);
});

test('hosted tool catalogs cannot install, expose, or search for root subagents', async () => {
  const registry = new ToolRegistry(process.cwd(), {
    hosted: true,
    subagentControl: { workspaceRoot: process.cwd(), run: async () => ({ outcome: 'completed' }) },
  });
  await registry.initialize();
  registry.installExternal({
    name: 'agent.run', version: 1, purpose: 'Incorrect externally supplied subagent runner',
    sideEffect: 'reversible', scope: 'host', cancellation: true, timeoutMs: 1000,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    executor: async () => ({ content: 'must not run' }),
  });
  assert.equal(registry.definition('agent.run'), undefined);
  assert.equal(registry.snapshot().some((item) => item.name === 'agent.run'), false);
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'agent.run'), false);
  assert.equal(registry.search('spawn exploration agent').some((item) => item.name === 'agent.run'), false);
});

test('compact provider facades retain callable shape while runtime schemas retain documentation and bounds', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const runtime = registry.snapshot().find((item) => item.name === 'fs.read');
  const wire = registry.providerDefinitions('read numbered lines')
    .find((item) => item.function.name === 'fs.read');

  assert.equal(runtime.inputSchema.properties.start_line.maximum, 10_000_000);
  assert.equal(runtime.inputSchema.properties.path.maxLength, 4096);
  assert.equal(Object.hasOwn(wire.function.parameters.properties.start_line, 'maximum'), false);
  assert.equal(Object.hasOwn(wire.function.parameters.properties.path, 'maxLength'), false);
  assert.equal(wire.function.parameters.properties.start_line.type, 'integer');
  assert.match(wire.function.parameters.properties.path.description, /UTF-8 text file/u);
  assert.match(runtime.inputSchema.properties.path.description, /UTF-8 text file/u);
  assert.ok(wire.function.description.length <= 320);
  assert.match(wire.function.description, /snapshot receipt required by later edits/u);
  const listWire = registry.providerDefinitions().find((item) => item.function.name === 'fs.list');
  assert.equal(listWire.function.parameters.required.includes('pattern'), false);
  assert.equal(listWire.function.parameters.properties.pattern.type, 'string');
  assert.match(listWire.function.parameters.properties.pattern.description, /glob/u);
});

test('every bundled filesystem argument has provider-visible semantic guidance', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const filesystemTools = registry.snapshot().filter((item) => item.name.startsWith('fs.'));
  assert.ok(filesystemTools.length >= 13);
  for (const tool of filesystemTools) {
    for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.equal(typeof property.description, 'string', `${tool.name}.${name} lacks a description`);
      assert.ok(property.description.length > 0, `${tool.name}.${name} has an empty description`);
    }
  }
  await registry.close();
});
