// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';
import { ConversationWork } from '../src/conversation-work.js';

const FOUNDATION = [
  'tool_search',
  'fs_list', 'fs_read', 'fs_search_text',
  'shell_run', 'work_plan', 'work_status', 'work_task_update', 'turn_finish',
  'git_inspect',
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
  assert.equal(baseline[0], 'tool_search');
  assert.ok(!baseline.includes('fs_list_directory'));
  assert.ok(!baseline.includes('fs_read_text'));
  assert.ok(!baseline.includes('fs_edit_text'));
  assert.ok(!baseline.includes('fs_write_text'));
  assert.ok(!baseline.includes('fs_delete_file'));
  assert.ok(!baseline.includes('process_run'));
  assert.ok(!baseline.includes('browser.navigate'));
  assert.ok(!baseline.includes('ref_store'));
  assert.ok(!baseline.includes('notification.telegram'));
  assert.ok(!baseline.includes('web_fetch'));
  assert.ok(!baseline.includes('web_browse'));
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
  for (const name of ['fs_write_text', 'fs_edit_text', 'process_run', 'system.elevate', 'project_verify']) {
    assert.ok(!initial.includes(name));
  }

  const search = registry.definition('tool_search');
  const normalized = await search.validate({ query: 'fs_edit_text' });
  await search.executor({ args: normalized.args }, new AbortController().signal);
  const searched = registry.providerDefinitions('unrelated wording').map((item) => item.function.name);
  assert.ok(searched.includes('fs_edit_text'));
  assert.ok(!searched.includes('fs_write_text'));
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
  assert.equal(baseline.receipt.selectionReasons.shell_run, 'foundational');
  assert.ok(baseline.receipt.selectionContextBytes > 0);
  assert.match(baseline.receipt.selectionContextFingerprint, /^[a-f0-9]{64}$/u);
  assert.ok(!baseline.receipt.selectedToolNames.includes('fs_write_text'));
  assert.match(baseline.receipt.fingerprint, /^[a-f0-9]{64}$/u);

  const legacyOption = registry.providerSurface('build and test the application', { phase: 'action' });
  assert.deepEqual(legacyOption, baseline);

  const lease = registry.grantWorkflowLease(['fs_write_text'], { source: 'test_recovery' });
  assert.deepEqual(lease.granted[0].sources, ['test_recovery']);
  const expanded = registry.providerSurface('any wording');
  assert.equal(expanded.receipt.selectionReasons.fs_write_text, 'workflow_lease');
});

test('tool_search reports repair-complete query diagnostics without conflating surface context', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const search = registry.definition('tool_search');
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

test('retired dotted tool names fail with a canonical migration hint but remain non-executable', async () => {
  const registry = new ToolRegistry(process.cwd(), {
    conversationWork: new ConversationWork(), terminalControl: { declare: async () => ({}) },
  });
  await registry.initialize();
  for (const [index, retired, canonical] of [
    ['search', 'tool.search', 'tool_search'],
    ['list', 'fs.list', 'fs_list'],
    ['read', 'fs.read', 'fs_read'],
    ['search-text', 'fs.search_text', 'fs_search_text'],
    ['shell', 'shell.run', 'shell_run'],
    ['work plan', 'work.plan', 'work_plan'],
    ['work status', 'work.status', 'work_status'],
    ['work task update', 'work.task_update', 'work_task_update'],
    ['turn finish', 'turn.finish', 'turn_finish'],
    ['git inspect', 'git.inspect', 'git_inspect'],
    ['work goal', 'work.goal', 'work_goal'],
    ['work task add', 'work.task_add', 'work_task_add'],
    ['process run', 'process.run', 'process_run'],
    ['project verify', 'project.verify', 'project_verify'],
    ['code diagnostics', 'code.diagnostics', 'code_diagnostics'],
    ['reference store', 'ref.store', 'ref_store'],
    ['reference inspect', 'ref.inspect', 'ref_inspect'],
    ['system time', 'system.time', 'system_time'],
    ['filesystem copy file', 'fs.copy_file', 'fs_copy_file'],
    ['filesystem create directory', 'fs.create_directory', 'fs_create_directory'],
    ['filesystem delete file', 'fs.delete_file', 'fs_delete_file'],
    ['filesystem directory', 'fs.directory', 'fs_directory'],
    ['filesystem edit lines', 'fs.edit_lines', 'fs_edit_lines'],
    ['filesystem edit text', 'fs.edit_text', 'fs_edit_text'],
    ['filesystem glob', 'fs.glob', 'fs_glob'],
    ['filesystem list directory', 'fs.list_directory', 'fs_list_directory'],
    ['filesystem metadata', 'fs.metadata', 'fs_metadata'],
    ['filesystem move file', 'fs.move_file', 'fs_move_file'],
    ['filesystem read lines', 'fs.read_lines', 'fs_read_lines'],
    ['filesystem read text', 'fs.read_text', 'fs_read_text'],
    ['filesystem write text', 'fs.write_text', 'fs_write_text'],
    ['image inspect', 'image.inspect', 'image_inspect'],
    ['NNA diagnose turn', 'nna.diagnose_turn', 'nna_diagnose_turn'],
    ['NNA list sessions', 'nna.list_sessions', 'nna_list_sessions'],
    ['NNA read guidance', 'nna.read_guidance', 'nna_read_guidance'],
    ['NNA search guidance', 'nna.search_guidance', 'nna_search_guidance'],
    ['web browse', 'web.browse', 'web_browse'],
    ['web fetch', 'web.fetch', 'web_fetch'],
    ['web search', 'web.search', 'web_search'],
    ['agent run', 'agent.run', 'agent_run'],
    ['skill search', 'skill.search', 'skill_search'],
    ['skill load', 'skill.load', 'skill_load'],
  ]) {
    await assert.rejects(registry.seal({ name: retired, providerCallId: `retired-${index}`, args: {} }, {
      policyVersion: 1, authority: { id: 'authority', version: 1, restrictionVersion: 0 },
      stepId: 'step', caller: 'primary', surface: 'test',
    }), {
      code: 'unknown_tool',
      message: `tool ${retired} is unavailable; use ${canonical}`,
    });
    assert.equal(registry.definition(retired), undefined);
  }
});

test('hosted execution obeys an authenticated manifest rather than inferred wording', async () => {
  const registry = new ToolRegistry(process.cwd(), { hosted: true, allowedTools: ['process_run'] });
  await registry.initialize();
  const visible = registry.providerDefinitions('build and test the application').map((item) => item.function.name);
  assert.ok(visible.includes('process_run'));
  assert.ok(!visible.includes('project_verify'));
  assert.ok(!visible.includes('shell_run'));
});

test('explicit exposure makes an exact recovery tool visible without broadening its bundle', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  registry.grantWorkflowLease(['fs_create_directory']);
  const visible = registry.providerDefinitions('inspect the missing path').map((item) => item.function.name);
  assert.ok(visible.includes('fs_create_directory'));
  assert.ok(!visible.includes('fs_write_text'));
  assert.ok(!visible.includes('fs_delete_file'));
});

test('tool_search keeps bounded specialist catalog matches visible for a workflow lease', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const search = registry.definition('tool_search');
  const normalized = await search.validate({ query: 'project_verify project verification' });
  const result = await search.executor({ args: normalized.args }, new AbortController().signal);
  assert.match(result.content, /project_verify/u);
  assert.deepEqual(JSON.parse(result.content).lease.granted[0].sources, ['tool_search']);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'project_verify'));
  }
  await registry.seal({ name: 'project_verify', providerCallId: 'verify-call', args: {} }, {
    policyVersion: 1, authority: { id: 'authority', version: 1, restrictionVersion: 0 },
    stepId: 'step', caller: 'primary', surface: 'test',
  });
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'project_verify'), true);
  for (let index = 1; index < 16; index += 1) {
    await registry.seal({ name: 'project_verify', providerCallId: `verify-call-${index}`, args: {} }, {
      policyVersion: 1, authority: { id: 'authority', version: 1, restrictionVersion: 0 },
      stepId: 'step', caller: 'primary', surface: 'test',
    });
  }
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'project_verify'), false);
  assert.ok(JSON.parse(result.content).matches.length <= 12);
});

test('exact tool search returns the callable schema and direct next-step guidance', async () => {
  const registry = new ToolRegistry(process.cwd(), {
    subagentControl: { workspaceRoot: process.cwd(), run: async () => ({ outcome: 'completed' }) },
  });
  await registry.initialize();
  const search = registry.definition('tool_search');
  const normalized = await search.validate({ query: 'show the agent_run schema' });
  const result = await search.executor({ args: normalized.args }, new AbortController().signal);
  const content = JSON.parse(result.content);
  assert.equal(content.status, 'schema_loaded_for_next_model_step');
  assert.match(content.instruction, /Call the exact matching tool directly/u);
  assert.equal(content.exact_match.name, 'agent_run');
  assert.deepEqual(content.exact_match.input_schema.required, ['type', 'task']);
  assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'agent_run'));
});

test('ranked discovery does not lease neighboring schemas without an exact tool name', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const search = registry.definition('tool_search');
  const result = await search.executor({ args: { query: 'project verification' } }, new AbortController().signal);
  const content = JSON.parse(result.content);
  assert.equal(content.status, 'catalog_matches_found');
  assert.equal(content.lease.granted.length, 0);
  assert.ok(content.matches.some((item) => item.name === 'project_verify'));
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'project_verify'), false);
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
  const registry = new ToolRegistry(process.cwd(), { allowedTools: ['fs_read_text', 'nno.customer.lookup'] });
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
  assert.deepEqual(registry.snapshot().map((item) => item.name).sort(), ['fs_read_text', 'nno.customer.lookup']);
  assert.deepEqual(registry.providerDefinitions().map((item) => item.function.name).sort(), ['fs_read_text', 'nno.customer.lookup']);
  assert.equal(registry.definition('nno.host.processes'), undefined);
});

test('hosted tool catalogs cannot install, expose, or search for root subagents', async () => {
  const registry = new ToolRegistry(process.cwd(), {
    hosted: true,
    subagentControl: { workspaceRoot: process.cwd(), run: async () => ({ outcome: 'completed' }) },
  });
  await registry.initialize();
  registry.installExternal({
    name: 'agent_run', version: 1, purpose: 'Incorrect externally supplied subagent runner',
    sideEffect: 'reversible', scope: 'host', cancellation: true, timeoutMs: 1000,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    executor: async () => ({ content: 'must not run' }),
  });
  assert.equal(registry.definition('agent_run'), undefined);
  assert.equal(registry.snapshot().some((item) => item.name === 'agent_run'), false);
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'agent_run'), false);
  assert.equal(registry.search('spawn exploration agent').some((item) => item.name === 'agent_run'), false);
});

test('compact provider facades retain callable shape while runtime schemas retain documentation and bounds', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const runtime = registry.snapshot().find((item) => item.name === 'fs_read');
  const wire = registry.providerDefinitions('read numbered lines')
    .find((item) => item.function.name === 'fs_read');

  assert.equal(runtime.inputSchema.properties.start_line.maximum, 10_000_000);
  assert.equal(runtime.inputSchema.properties.path.maxLength, 4096);
  assert.equal(Object.hasOwn(wire.function.parameters.properties.start_line, 'maximum'), false);
  assert.equal(Object.hasOwn(wire.function.parameters.properties.path, 'maxLength'), false);
  assert.equal(wire.function.parameters.properties.start_line.type, 'integer');
  assert.match(wire.function.parameters.properties.path.description, /UTF-8 text file/u);
  assert.match(runtime.inputSchema.properties.path.description, /UTF-8 text file/u);
  assert.ok(wire.function.description.length <= 320);
  assert.match(wire.function.description, /snapshot receipt required by later edits/u);
  const listWire = registry.providerDefinitions().find((item) => item.function.name === 'fs_list');
  assert.equal(listWire.function.parameters.required.includes('pattern'), false);
  assert.equal(listWire.function.parameters.properties.pattern.type, 'string');
  assert.match(listWire.function.parameters.properties.pattern.description, /glob/u);
});

test('every bundled filesystem argument has provider-visible semantic guidance', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const filesystemTools = registry.snapshot().filter((item) => item.name.startsWith('fs.') || item.name.startsWith('fs_'));
  assert.ok(filesystemTools.length >= 13);
  for (const tool of filesystemTools) {
    for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
      assert.equal(typeof property.description, 'string', `${tool.name}.${name} lacks a description`);
      assert.ok(property.description.length > 0, `${tool.name}.${name} has an empty description`);
    }
  }
  await registry.close();
});
