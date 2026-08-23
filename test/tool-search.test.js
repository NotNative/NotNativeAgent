// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';
import { actionOrientedIntent, taskActivatedToolNames, toolOrientedIntent } from '../src/tools/capability-activation.js';

test('tool catalog keeps observational tools visible and effectful tools situational', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  registry.installExternal({
    name: 'browser.navigate', version: 1, purpose: 'Navigate an interactive browser to a web page',
    sideEffect: 'external_effect', scope: 'network', cancellation: true, timeoutMs: 1000,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    executor: async () => ({ content: 'unused' }),
  });
  const baseline = registry.providerDefinitions().map((item) => item.function.name);
  assert.deepEqual(baseline.sort(),
    ['fs.list', 'fs.read', 'fs.search_text', 'tool.search']);
  assert.ok(!baseline.includes('fs.list_directory'));
  assert.ok(!baseline.includes('fs.read_text'));
  assert.ok(!baseline.includes('fs.edit_text'));
  assert.ok(!baseline.includes('fs.write_text'));
  assert.ok(!baseline.includes('fs.delete_file'));
  assert.ok(!baseline.includes('process.run'));
  assert.ok(!baseline.includes('shell.run'));
  assert.ok(!baseline.includes('browser.navigate'));
  assert.ok(!baseline.includes('ref.store'));
  assert.ok(!baseline.includes('work.goal'));
  assert.ok(!baseline.includes('work.task_add'));
  assert.ok(!baseline.includes('notification.telegram'));
  assert.ok(!baseline.includes('web.search'));
  assert.ok(!baseline.includes('web.fetch'));
  assert.ok(!baseline.includes('web.browse'));
  assert.ok(!baseline.includes('nna.search_guidance'));
  assert.ok(!baseline.includes('nna.diagnose_turn'));
  assert.ok(!baseline.includes('session.search_history'));
  const relevant = registry.providerDefinitions('open and navigate a browser page').map((item) => item.function.name);
  assert.ok(relevant.includes('web.browse'));
  assert.ok(!relevant.includes('browser.navigate'));
});

test('authenticated task intent activates bounded effectful capability bundles', async () => {
  const registry = new ToolRegistry(process.cwd(), { elevationBroker: { async execute() { return {}; } } });
  await registry.initialize();
  const inspect = registry.providerDefinitions('inspect the repository structure').map((item) => item.function.name);
  assert.ok(!inspect.includes('fs.write_text'));
  assert.ok(!inspect.includes('process.run'));

  const build = registry.providerDefinitions('build and test the application').map((item) => item.function.name);
  assert.ok(build.includes('shell.run'));
  for (const name of ['fs.directory', 'fs.write_text', 'fs.edit_text']) assert.ok(!build.includes(name));
  const groundedBuild = registry.providerDefinitions('build and test the application', { phase: 'action' })
    .map((item) => item.function.name);
  for (const name of ['fs.directory', 'fs.write_text', 'fs.edit_text', 'shell.run']) {
    assert.ok(groundedBuild.includes(name), `${name} was not activated after grounding`);
  }
  assert.ok(!build.includes('process.run'));
  assert.ok(!build.includes('fs.delete_file'));
  assert.ok(!build.includes('system.elevate'));
  assert.ok(!build.includes('project.verify'));
  assert.ok(!build.includes('work.plan'));

  const cleanup = registry.providerDefinitions('remove the obsolete file', { phase: 'action' }).map((item) => item.function.name);
  assert.ok(cleanup.includes('fs.directory'));
  assert.ok(!cleanup.includes('fs.delete_file'));

  const privileged = registry.providerDefinitions('retry this with administrator elevation').map((item) => item.function.name);
  assert.ok(!privileged.includes('system.elevate'));

  const work = taskActivatedToolNames('build this project and track the plan');
  assert.ok(work.includes('work.plan'));
  assert.equal(taskActivatedToolNames('build and implement this project').includes('work.plan'), false);
  assert.ok(taskActivatedToolNames('notify me on telegram when finished').includes('notification.telegram'));
  assert.ok(taskActivatedToolNames('store this large payload as a reusable reference').includes('ref.store'));
  assert.ok(taskActivatedToolNames('diagnose the failed turn from the logs').includes('nna.diagnose_turn'));
  assert.equal(taskActivatedToolNames('research the latest release online').includes('web.search'), true);
  assert.ok(taskActivatedToolNames('run this direct executable with exact argv without a shell').includes('process.run'));
  assert.equal(actionOrientedIntent('build and test the application'), true);
  assert.equal(actionOrientedIntent('inspect and explain the repository structure'), false);
  assert.equal(actionOrientedIntent('research the latest release online'), false);
  assert.equal(toolOrientedIntent('Recommend a cooperative board game for four friends in 60 minutes.'), false);
  assert.equal(taskActivatedToolNames('Recommend a cooperative board game for four friends in 60 minutes.')
    .includes('web.search'), false);
  assert.equal(toolOrientedIntent('Find current prices for a cooperative board game.'), true);
});

test('provider surface receipts make phase selection and byte budgets auditable', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const orientation = registry.providerSurface('build and test the application');
  assert.equal(orientation.receipt.phase, 'orientation');
  assert.ok(orientation.definitions.length <= 7);
  assert.ok(orientation.receipt.schemaBytes <= 6 * 1024);
  assert.equal(orientation.receipt.selectionReasons['shell.run'], 'task_intent');
  assert.ok(!orientation.receipt.selectedToolNames.includes('fs.write_text'));
  assert.match(orientation.receipt.fingerprint, /^[a-f0-9]{64}$/u);

  const action = registry.providerSurface('build and test the application', { phase: 'action' });
  assert.equal(action.receipt.phase, 'action');
  assert.ok(action.definitions.length <= 10);
  assert.ok(action.receipt.schemaBytes <= 8 * 1024);
  assert.equal(action.receipt.selectionReasons['fs.write_text'], 'task_intent');

  const fileRead = registry.providerSurface('Read input.txt before creating output.txt');
  assert.ok(!fileRead.receipt.selectedToolNames.includes('web.fetch'));
  assert.deepEqual(fileRead.receipt.selectedToolNames,
    ['fs.list', 'fs.read', 'fs.search_text', 'tool.search']);
  assert.ok(!fileRead.receipt.selectedToolNames.includes('web.browse'));
  const browser = registry.providerSurface('Navigate the browser to http://localhost:8123');
  assert.equal(browser.receipt.selectionReasons['web.browse'], 'task_intent');

  for (const query of [
    'research current laptop prices online',
    'compare hotel availability and prices',
    'check the latest release using authoritative web sources',
    'build a realistic ocean scene using Three.js',
    'verify this WebGL application renders correctly',
  ]) {
    const surface = registry.providerSurface(query);
    assert.ok(['phase_baseline', 'task_intent'].includes(
      surface.receipt.selectionReasons['web.browse'],
    ), query);
    assert.ok(surface.receipt.selectedToolNames.includes('web.browse'), query);
  }
  const webApplication = registry.providerSurface('build and test this Three.js web app');
  assert.ok(webApplication.receipt.selectedToolNames.includes('shell.run'));
  assert.ok(webApplication.receipt.selectedToolNames.includes('web.browse'));
  assert.ok(!registry.providerSurface('research the repository implementation')
    .receipt.selectedToolNames.includes('web.browse'));
});

test('hosted execution falls back to process.run when no shell tool exists', async () => {
  const registry = new ToolRegistry(process.cwd(), { hosted: true });
  await registry.initialize();
  const visible = registry.providerDefinitions('build and test the application').map((item) => item.function.name);
  assert.ok(visible.includes('process.run'));
  assert.ok(!visible.includes('project.verify'));
  assert.ok(!visible.includes('shell.run'));
});

test('explicit exposure makes an exact recovery tool visible without broadening its bundle', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  registry.expose(['fs.create_directory']);
  const visible = registry.providerDefinitions('inspect the missing path').map((item) => item.function.name);
  assert.ok(visible.includes('fs.create_directory'));
  assert.ok(!visible.includes('fs.write_text'));
  assert.ok(!visible.includes('fs.delete_file'));
});

test('tool.search keeps bounded provider-catalog matches visible until a validated call consumes them', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const search = registry.definition('tool.search');
  const normalized = await search.validate({ query: 'nna.diagnose_turn runtime failure' });
  const result = await search.executor({ args: normalized.args }, new AbortController().signal);
  assert.match(result.content, /nna\.diagnose_turn/u);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'nna.diagnose_turn'));
  }
  await registry.seal({ name: 'nna.diagnose_turn', providerCallId: 'diagnose-call', args: {} }, {
    policyVersion: 1, authority: { id: 'authority', version: 1, restrictionVersion: 0 },
    stepId: 'step', caller: 'primary', surface: 'test',
  });
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'nna.diagnose_turn'), false);
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
  assert.equal(content.status, 'schemas_loaded_for_next_model_step');
  assert.match(content.instruction, /Call the matching tool directly/u);
  assert.equal(content.exact_match.name, 'agent.run');
  assert.deepEqual(content.exact_match.input_schema.required, ['type', 'task']);
  assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'agent.run'));
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
  assert.equal(Object.hasOwn(wire.function.parameters.properties.path, 'description'), false);
  assert.match(runtime.inputSchema.properties.path.description, /UTF-8 text file/u);
  assert.ok(wire.function.description.length <= 180);
  const listWire = registry.providerDefinitions().find((item) => item.function.name === 'fs.list');
  assert.equal(listWire.function.parameters.required.includes('pattern'), false);
  assert.equal(listWire.function.parameters.properties.pattern.type, 'string');
  assert.equal(Object.hasOwn(listWire.function.parameters.properties.pattern, 'description'), false);
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
