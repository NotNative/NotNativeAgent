// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '../src/tool-registry.js';
import { providerSchema, schemaShapeValidator } from '../src/tools/schema.js';

function optionalControls() {
  const snapshot = { revision: 0, goal: null, tasks: [] };
  return {
    mcpControl: { async status() { return {}; }, async test() { return {}; } },
    skillRegistry: {
      search() { return []; },
      load() { return { id: 'fixture', version: 1, source: 'test', requiresTools: [], body: '' }; },
    },
    subagentControl: { workspaceRoot: process.cwd(), async run() { return {}; } },
    conversationWork: {
      snapshot() { return snapshot; }, async setGoal() { return snapshot; },
      async completeGoal() { return snapshot; }, async reopenGoal() { return snapshot; },
      async addTask() { return snapshot; }, async updateTask() { return snapshot; },
    },
    telegramNotifications: { schedule() {} }, activeTurnId: () => 'turn-fixture',
    elevationBroker: { async execute() { return {}; } },
    sessionHistory: { transcript() { return []; } },
  };
}

test('all bundled tool schemas are closed, documented, and safe to project to providers', async () => {
  const registry = new ToolRegistry(process.cwd(), optionalControls());
  await registry.initialize();
  try {
    const tools = registry.snapshot();
    assert.ok(tools.length >= 39);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} must accept one object`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown fields`);
      assert.equal(typeof tool.purpose, 'string', `${tool.name} lacks a purpose`);
      assert.ok(tool.purpose.trim().length > 0, `${tool.name} has an empty purpose`);
      const propertyNames = new Set(Object.keys(tool.inputSchema.properties ?? {}));
      const required = tool.inputSchema.required ?? [];
      assert.equal(new Set(required).size, required.length, `${tool.name} repeats a required field`);
      for (const name of required) assert.ok(propertyNames.has(name), `${tool.name} requires unknown field ${name}`);
      const wire = providerSchema(tool.inputSchema);
      const documented = providerSchema(tool.inputSchema, { mode: 'documented' });
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        assert.equal(typeof property.description, 'string', `${tool.name}.${name} lacks a description`);
        assert.ok(property.description.length > 0, `${tool.name}.${name} has an empty description`);
        assert.equal(Object.hasOwn(wire.properties[name], 'description'), false);
        assert.equal(documented.properties[name].description, property.description);
      }
    }
  } finally { await registry.close(); }
});

test('provider contracts preserve semantic guidance and keep edit selectors disjoint', async () => {
  const registry = new ToolRegistry(process.cwd(), optionalControls());
  await registry.initialize();
  try {
    const exact = registry.definition('fs.edit_text');
    const lines = registry.definition('fs.edit_lines');
    assert.deepEqual(Object.keys(exact.inputSchema.properties), ['path', 'content', 'find', 'all']);
    assert.deepEqual(exact.inputSchema.required, ['path', 'find', 'content']);
    assert.equal(Object.hasOwn(exact.inputSchema.properties, 'start_line'), false);
    assert.deepEqual(Object.keys(lines.inputSchema.properties), ['path', 'start_line', 'end_line', 'replacement']);
    assert.equal(Object.hasOwn(lines.inputSchema.properties, 'find'), false);

    const surface = registry.providerDefinitions('build and edit a project file', { phase: 'action' });
    for (const name of ['fs.edit_text', 'fs.edit_lines']) {
      const parameters = surface.find((entry) => entry.function.name === name)?.function.parameters;
      assert.ok(parameters, `${name} is missing from the activated mutation surface`);
      for (const [field, schema] of Object.entries(parameters.properties)) {
        assert.equal(typeof schema.description, 'string', `${name}.${field} lost provider-visible guidance`);
      }
    }
    const browse = providerSchema(registry.definition('web.browse').inputSchema, { mode: 'documented' });
    assert.match(browse.properties.action.description, /navigate=url/u);
    assert.match(browse.properties.action.description, /fill_secret=target\+secret_id\+secret_field/u);
  } finally { await registry.close(); }
});

test('bundled tool shape failures identify the argument the model must repair', async () => {
  const registry = new ToolRegistry(process.cwd(), optionalControls());
  await registry.initialize();
  try {
    await assert.rejects(registry.definition('process.run').validate({ args: [] }), {
      code: 'tool_schema_invalid', message: 'required argument "executable" is missing',
    });
    await assert.rejects(registry.definition('web.fetch').validate({ url: 'https://example.com', extra: true }), {
      code: 'tool_schema_invalid',
      message: 'unknown argument "extra"; allowed arguments: url',
    });
    const taskUpdate = registry.definition('work.task_update');
    assert.match(taskUpdate.inputSchema.properties.detail.description, /1,024 characters/u);
    await assert.rejects(taskUpdate.validate({ id: 'T4', status: 'completed', detail: 'x'.repeat(1778) }), {
      code: 'tool_schema_invalid', message: 'argument "detail" must contain at most 1024 characters; received 1778',
    });
    await assert.rejects(taskUpdate.validate({ id: 'T4', status: 'done' }), {
      code: 'tool_schema_invalid', message: 'argument "status" must be one of "pending", "in_progress", "completed", "blocked"; received "done"',
    });
    await assert.rejects(taskUpdate.validate({ id: 'T0', status: 'pending' }), {
      code: 'tool_schema_invalid',
      message: /argument "id" must match this format .*; received "T0"/u,
    });
  } finally { await registry.close(); }
});

test('repair-complete format errors bound ordinary values and redact sensitive values', async () => {
  const ordinary = schemaShapeValidator({
    type: 'object', additionalProperties: false, required: ['id'],
    properties: { id: { type: 'string', pattern: '^T[1-9][0-9]*$', description: 'a task id such as T1' } },
  });
  await assert.rejects(ordinary({ id: 'not-a-task' }), {
    code: 'tool_schema_invalid',
    message: 'argument "id" must match this format (a task id such as T1); received "not-a-task"',
  });
  const sensitive = schemaShapeValidator({
    type: 'object', additionalProperties: false, required: ['api_key'],
    properties: { api_key: { type: 'string', pattern: '^key_[a-z]+$', description: 'a key_ prefix followed by lowercase letters' } },
  });
  await assert.rejects(sensitive({ api_key: 'wrong-secret-value' }), {
    code: 'tool_schema_invalid',
    message: /received \[redacted string; 18 characters\]$/u,
  });
});
