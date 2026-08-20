// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';
import { taskActivatedToolNames } from '../src/tools/capability-activation.js';

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
  assert.ok(baseline.includes('tool.search'));
  assert.ok(baseline.includes('fs.list_directory'));
  assert.ok(baseline.includes('fs.read_text'));
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
  assert.ok(!baseline.includes('nna.search_guidance'));
  assert.ok(!baseline.includes('nna.diagnose_turn'));
  assert.ok(!baseline.includes('session.search_history'));
  const relevant = registry.providerDefinitions('open and navigate a browser page').map((item) => item.function.name);
  assert.ok(relevant.includes('browser.navigate'));
});

test('authenticated task intent activates bounded effectful capability bundles', async () => {
  const registry = new ToolRegistry(process.cwd(), { elevationBroker: { async execute() { return {}; } } });
  await registry.initialize();
  const inspect = registry.providerDefinitions('inspect the repository structure').map((item) => item.function.name);
  assert.ok(!inspect.includes('fs.write_text'));
  assert.ok(!inspect.includes('process.run'));

  const build = registry.providerDefinitions('build and test the application').map((item) => item.function.name);
  for (const name of ['fs.create_directory', 'fs.write_text', 'fs.edit_text', 'process.run', 'shell.run', 'project.verify']) {
    assert.ok(build.includes(name), `${name} was not activated`);
  }
  assert.ok(!build.includes('fs.delete_file'));
  assert.ok(!build.includes('system.elevate'));

  const cleanup = registry.providerDefinitions('remove the obsolete file').map((item) => item.function.name);
  assert.ok(cleanup.includes('fs.delete_file'));

  const privileged = registry.providerDefinitions('retry this with administrator elevation').map((item) => item.function.name);
  assert.ok(privileged.includes('system.elevate'));

  const work = taskActivatedToolNames('build this project and track the plan');
  for (const name of ['work.goal', 'work.task_add', 'work.task_update']) assert.ok(work.includes(name));
  assert.ok(taskActivatedToolNames('notify me on telegram when finished').includes('notification.telegram'));
  assert.ok(taskActivatedToolNames('store this large payload as a reusable reference').includes('ref.store'));
  for (const name of ['web.search', 'web.fetch', 'web.browse']) {
    assert.ok(taskActivatedToolNames('research the latest release online').includes(name));
  }
  for (const name of ['nna.list_sessions', 'nna.diagnose_turn']) {
    assert.ok(taskActivatedToolNames('diagnose the failed turn from the logs').includes(name));
  }
  assert.equal(taskActivatedToolNames('read the current file').includes('web.search'), false);
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

test('tool.search keeps bounded matches visible until a validated call consumes them', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const search = registry.definition('tool.search');
  const normalized = await search.validate({ query: 'inspect git history' });
  const result = await search.executor({ args: normalized.args }, new AbortController().signal);
  assert.match(result.content, /git\.inspect/u);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'git.inspect'));
  }
  await registry.seal({ name: 'git.inspect', providerCallId: 'git-call', args: { operation: 'status' } }, {
    policyVersion: 1, authority: { id: 'authority', version: 1, restrictionVersion: 0 },
    stepId: 'step', caller: 'primary', surface: 'test',
  });
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'git.inspect'), false);
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

test('provider tool schemas omit grammar-hostile bounds while runtime schemas retain them', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const runtime = registry.snapshot().find((item) => item.name === 'fs.read_lines');
  const wire = registry.providerDefinitions('read numbered lines')
    .find((item) => item.function.name === 'fs.read_lines');

  assert.equal(runtime.inputSchema.properties.start_line.maximum, 10_000_000);
  assert.equal(runtime.inputSchema.properties.path.maxLength, 4096);
  assert.equal(Object.hasOwn(wire.function.parameters.properties.start_line, 'maximum'), false);
  assert.equal(Object.hasOwn(wire.function.parameters.properties.path, 'maxLength'), false);
  assert.equal(wire.function.parameters.properties.start_line.type, 'integer');
  assert.match(wire.function.parameters.properties.path.description, /UTF-8 text file/u);
  const globWire = registry.providerDefinitions('glob files').find((item) => item.function.name === 'fs.glob');
  assert.equal(globWire.function.parameters.required.includes('pattern'), true);
  assert.equal(globWire.function.parameters.properties.pattern.type, 'string');
  assert.match(globWire.function.parameters.properties.pattern.description, /Required glob/u);
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
