// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';

test('tool catalog keeps core tools visible and selects bounded relevant capabilities', async () => {
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
  assert.ok(baseline.includes('fs.edit_text'));
  assert.ok(baseline.includes('process.run'));
  assert.ok(baseline.includes('shell.run'));
  assert.ok(!baseline.includes('browser.navigate'));
  const relevant = registry.providerDefinitions('open and navigate a browser page').map((item) => item.function.name);
  assert.ok(relevant.includes('browser.navigate'));
});

test('host process execution is a core visible capability independent of query wording', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  for (const query of ['', 'inspect this computer', 'connect to another host', 'run a repository command']) {
    assert.ok(registry.providerDefinitions(query).some((item) => item.function.name === 'process.run'));
  }
});

test('tool.search exposes bounded matches for subsequent model steps', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  const search = registry.definition('tool.search');
  const normalized = await search.validate({ query: 'inspect git history' });
  const result = await search.executor({ args: normalized.args }, new AbortController().signal);
  assert.match(result.content, /git\.inspect/u);
  assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'git.inspect'));
  assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'git.inspect'));
  assert.ok(registry.providerDefinitions().some((item) => item.function.name === 'git.inspect'));
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'git.inspect'), false);
  assert.ok(JSON.parse(result.content).length <= 12);
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
