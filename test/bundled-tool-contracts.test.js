// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '../src/tool-registry.js';
import { providerSchema, schemaShapeValidator } from '../src/tools/schema.js';
import { systemTimeDefinition } from '../src/tools/system-time.js';

const MAXIMAL_BUNDLED_TOOL_NAMES = Object.freeze([
  'ref.store', 'ref.inspect',
  'fs.list_directory', 'fs.read_text', 'fs.read_lines', 'fs.glob', 'fs.search_text',
  'fs.write_text', 'fs.edit_text', 'fs.edit_lines', 'fs.delete_file', 'fs.metadata',
  'fs.create_directory', 'fs.copy_file', 'fs.move_file', 'fs.read', 'fs.list', 'fs.directory',
  'nna.search_guidance', 'nna.read_guidance', 'nna.diagnose_turn', 'nna.list_sessions',
  'nna.mcp_status', 'nna.mcp_test',
  'web.search', 'web.fetch', 'web.browse', 'image.inspect', 'tool.search',
  'process.run', 'shell.run', 'system.elevate', 'project.verify', 'git.inspect', 'code.diagnostics',
  'skill.search', 'skill.load', 'agent.run',
  'work.plan', 'work.status', 'work.goal', 'work.task_add', 'work.task_update',
  'turn.finish',
  'notification.telegram', 'session.search_history', 'session.read_history', 'system.time',
  'workspace.change',
]);

function optionalControls() {
  const snapshot = { revision: 0, goal: null, tasks: [] };
  return {
    mcpControl: { async status() { return {}; }, async test() { return {}; } },
    skillRegistry: {
      search() { return []; },
      load() { return { id: 'fixture', version: 1, source: 'test', requiresTools: [], body: '' }; },
    },
    subagentControl: { workspaceRoot: process.cwd(), async run() { return {}; } },
    workspaceControl: { async change() { return { previousWorkspace: process.cwd(), workspaceRoot: process.cwd(), changed: false }; } },
    conversationWork: {
      snapshot() { return snapshot; }, async setGoal() { return snapshot; },
      async completeGoal() { return snapshot; }, async reopenGoal() { return snapshot; },
      async addTask() { return snapshot; }, async updateTask() { return snapshot; },
    },
    terminalControl: { declare(value) { return value; } },
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
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...MAXIMAL_BUNDLED_TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object', `${tool.name} must accept one object`);
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown fields`);
      assert.equal(typeof tool.purpose, 'string', `${tool.name} lacks a purpose`);
      assert.ok(tool.purpose.trim().length > 0, `${tool.name} has an empty purpose`);
      assert.doesNotMatch(tool.purpose, /\b(?:use this|prefer this|always use|first use)\b/iu,
        `${tool.name} purpose prescribes model strategy instead of describing the capability`);
      const propertyNames = new Set(Object.keys(tool.inputSchema.properties ?? {}));
      for (const internal of ['expected_sha256', 'read_receipt_id', 'edit_mode', 'old_text', 'new_text', 'replace_all']) {
        assert.equal(propertyNames.has(internal), false, `${tool.name} exposes sealed execution field ${internal}`);
      }
      const required = tool.inputSchema.required ?? [];
      assert.equal(new Set(required).size, required.length, `${tool.name} repeats a required field`);
      for (const name of required) assert.ok(propertyNames.has(name), `${tool.name} requires unknown field ${name}`);
      const wire = providerSchema(tool.inputSchema);
      const documented = providerSchema(tool.inputSchema, { mode: 'documented' });
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        assert.equal(typeof property.description, 'string', `${tool.name}.${name} lacks a description`);
        assert.ok(property.description.length > 0, `${tool.name}.${name} has an empty description`);
        assert.equal(Object.hasOwn(wire.properties[name], 'description'), false);
        assert.ok(documented.properties[name].description.startsWith(property.description));
        const hasHiddenConstraint = ['minimum', 'maximum', 'minLength', 'maxLength', 'maxUtf8Bytes', 'pattern', 'minItems', 'maxItems']
          .some((constraint) => Object.hasOwn(property, constraint));
        if (hasHiddenConstraint) assert.match(documented.properties[name].description, /Constraints:/u);
        assert.equal(Object.hasOwn(documented.properties[name], 'maxUtf8Bytes'), false);
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
    assert.equal(exact.inputSchema.properties.find.maxLength, 16_384);
    assert.equal(exact.inputSchema.properties.content.maxLength, 32_768);
    assert.equal(lines.inputSchema.properties.replacement.maxLength, 32_768);
    assert.equal(registry.definition('fs.write_text').inputSchema.properties.content.maxLength, 32_768);
    assert.equal(registry.definition('ref.store').inputSchema.properties.value.maxLength, 32_768);

    registry.grantWorkflowLease(['fs.edit_text', 'fs.edit_lines']);
    const surface = registry.providerDefinitions('build and edit a project file', { phase: 'action' });
    for (const name of ['fs.edit_text', 'fs.edit_lines']) {
      const parameters = surface.find((entry) => entry.function.name === name)?.function.parameters;
      assert.ok(parameters, `${name} is missing from the activated mutation surface`);
      for (const [field, schema] of Object.entries(parameters.properties)) {
        assert.equal(typeof schema.description, 'string', `${name}.${field} lost provider-visible guidance`);
      }
    }
    const browse = providerSchema(registry.definition('web.browse').inputSchema, { mode: 'documented' });
    assert.match(browse.properties.action.description, /Navigate: set exactly one of url or path/u);
    assert.match(browse.properties.action.description, /Fill_secret: set target, secret_id, and secret_field/u);
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

test('schema validation normalizes safe integer and canonical boolean strings at every schema depth', async () => {
  const validate = schemaShapeValidator({
    type: 'object', additionalProperties: false, required: ['count', 'codes', 'nested', 'label', 'enabled'],
    properties: {
      count: { type: 'integer', minimum: 0 },
      codes: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 } },
      nested: {
        type: 'object', additionalProperties: false, required: ['offset'],
        properties: { offset: { type: 'integer' } },
      },
      label: { type: 'string' },
      enabled: { type: 'boolean' },
    },
  });
  const original = { count: ' 003 ', codes: ['0', '1e2'], nested: { offset: '-4.0' }, label: '3', enabled: ' FALSE ' };
  const normalized = await validate(original);
  assert.deepEqual(normalized, { count: 3, codes: [0, 100], nested: { offset: -4 }, label: '3', enabled: false });
  assert.deepEqual(original, { count: ' 003 ', codes: ['0', '1e2'], nested: { offset: '-4.0' }, label: '3', enabled: ' FALSE ' });
  await assert.rejects(validate({ count: '3.5', codes: [0], nested: { offset: 1 }, label: 'x', enabled: true }), {
    code: 'tool_schema_invalid', message: 'argument "count" must be an integer; received string',
  });
  await assert.rejects(validate({ count: '9007199254740993', codes: [0], nested: { offset: 1 }, label: 'x', enabled: true }), {
    code: 'tool_schema_invalid', message: 'argument "count" must be an integer; received string',
  });
});

test('provider documentation exposes locally enforced bounds while UTF-8 byte limits remain transport-safe', async () => {
  const schema = {
    type: 'object', additionalProperties: false, required: ['value', 'count'], properties: {
      value: { type: 'string', minLength: 1, maxLength: 4, maxUtf8Bytes: 4, pattern: '^.+$', description: 'A short value.' },
      count: { type: 'integer', minimum: -4, maximum: 12, description: 'Signed count.' },
    },
  };
  const projected = providerSchema(schema, { mode: 'documented' });
  assert.equal(Object.hasOwn(projected.properties.value, 'maxLength'), false);
  assert.equal(Object.hasOwn(projected.properties.value, 'maxUtf8Bytes'), false);
  assert.match(projected.properties.value.description, /1-4 characters/u);
  assert.match(projected.properties.value.description, /UTF-8 encoding at most 4 bytes/u);
  assert.match(projected.properties.value.description, /must match/u);
  assert.match(projected.properties.count.description, /-4-12 numeric value/u);

  const validate = schemaShapeValidator(schema);
  assert.deepEqual(await validate({ value: '🙂', count: '3' }), { value: '🙂', count: 3 });
  await assert.rejects(validate({ value: '🙂a', count: 3 }), {
    code: 'tool_schema_invalid',
    message: 'argument "value" UTF-8 encoding must be at most 4 bytes; received 5',
  });
});

test('system.time observes the host clock and applies calendar weeks before elapsed offsets', async () => {
  const instant = new Date('2026-08-27T22:15:42.381Z');
  const definition = systemTimeDefinition({ now: () => new Date(instant) });
  const plain = await definition.executor(await definition.validate({}), new AbortController().signal);
  const observed = JSON.parse(plain.content);
  assert.equal(observed.utc, instant.toISOString());
  assert.equal(observed.source, 'host_clock');
  assert.equal(typeof observed.local_date, 'string');
  assert.equal(typeof observed.yesterday_date, 'string');
  assert.equal(typeof observed.tomorrow_date, 'string');

  const adjustedRequest = await definition.validate({ weeks: 2, minutes: 30 });
  const adjusted = JSON.parse((await definition.executor(adjustedRequest, new AbortController().signal)).content);
  assert.deepEqual(adjusted.offset, { weeks: 2, minutes: 30 });
  assert.equal(adjusted.normalized_calendar_days, 14);
  assert.equal(adjusted.result.unix_ms - adjusted.observed.unix_ms, 14 * 86_400_000 + 30 * 60_000);
  assert.deepEqual(adjusted.range, {
    start_date: adjusted.observed.local_date, end_date: adjusted.result.local_date, inclusive: true,
  });
});

test('system.time is foundational and normalizes singular aliases and integer strings', async () => {
  const registry = new ToolRegistry(process.cwd(), optionalControls());
  await registry.initialize();
  try {
    const time = registry.definition('system.time');
    const normalized = await time.validate({ week: '2', minute: '-30' });
    assert.deepEqual(normalized.args, { weeks: 2, minutes: -30 });
    const names = registry.providerDefinitions('', { phase: 'orientation' }).map((entry) => entry.function.name);
    assert.ok(names.includes('system.time'));
  } finally { await registry.close(); }
});
