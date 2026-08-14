// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '../src/tool-registry.js';
import { providerSchema } from '../src/tool-schema.js';

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

test('all bundled tool arguments provide provider-visible semantic guidance', async () => {
  const registry = new ToolRegistry(process.cwd(), optionalControls());
  await registry.initialize();
  try {
    const tools = registry.snapshot();
    assert.ok(tools.length >= 39);
    for (const tool of tools) {
      const wire = providerSchema(tool.inputSchema);
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        assert.equal(typeof property.description, 'string', `${tool.name}.${name} lacks a description`);
        assert.ok(property.description.length > 0, `${tool.name}.${name} has an empty description`);
        assert.equal(wire.properties[name].description, property.description);
      }
    }
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
      code: 'tool_schema_invalid', message: 'unknown argument "extra"',
    });
  } finally { await registry.close(); }
});
