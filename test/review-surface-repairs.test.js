// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaShapeValidator } from '../src/tools/schema.js';
import { failureEnvelope } from '../src/failure-envelope.js';
import { ContractError } from '../src/ids.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { hostEnvironmentInstruction, shellToolGuidance } from '../src/reliability/host-environment.js';

test('schema bound failures supply structured repairs without echoing source values', async () => {
  for (const [rule, value, unit, direction, bound] of [
    [{ type: 'string', minLength: 3 }, 'x', 'characters', 'minimum', 3],
    [{ type: 'string', maxLength: 2 }, 'secret', 'characters', 'maximum', 2],
    [{ type: 'string', maxUtf8Bytes: 2 }, '🙂', 'utf8_bytes', 'maximum', 2],
    [{ type: 'number', minimum: 2 }, 1, 'numeric_value', 'minimum', 2],
    [{ type: 'number', maximum: 2 }, 3, 'numeric_value', 'maximum', 2],
    [{ type: 'array', minItems: 2 }, [], 'items', 'minimum', 2],
    [{ type: 'array', maxItems: 2 }, [1, 2, 3], 'items', 'maximum', 2],
  ]) {
    const validate = schemaShapeValidator({ type: 'object', properties: { value: rule } });
    await assert.rejects(validate({ value }), (error) => {
      assert.equal(error.code, 'tool_schema_invalid');
      assert.equal(error.toolMetadata.issue, 'bound_violation');
      assert.equal(error.toolMetadata.unit, unit);
      assert.equal(error.toolMetadata[direction], bound);
      assert.equal(JSON.stringify(error.toolMetadata).includes('secret'), false);
      return true;
    });
  }
});

test('failure envelopes carry one partial and effect field', () => {
  const result = failureEnvelope(new ContractError('tool_cancelled', 'cancelled'), {
    partial: true, effectCertainty: 'unknown',
  });
  assert.equal(result.partial_data, true);
  assert.equal(result.effect_certainty, 'unknown');
  assert.equal(Object.hasOwn(result, 'partial'), false);
  assert.equal(Object.hasOwn(result, 'side_effect_certainty'), false);
});

test('external capability discovery needs neither vendor names nor external keywords', async () => {
  const registry = new ToolRegistry(process.cwd());
  await registry.initialize();
  registry.installExternal({
    name: 'mcp.vendor.lookup', version: 1, purpose: 'Lookup inventory widgets',
    sideEffect: 'read_only', scope: 'external', cancellation: true, timeoutMs: 1000,
    inputSchema: { type: 'object', properties: {} }, executor: async () => ({ content: 'unused' }),
  });
  const result = await registry.definition('tool.search').executor({ args: { query: 'inventory widgets' } }, new AbortController().signal);
  const content = JSON.parse(result.content);
  assert.ok(content.matches.some((item) => item.name === 'mcp.vendor.lookup'));
  assert.equal(content.lease.granted.length, 0);
  assert.equal(registry.providerDefinitions().some((item) => item.function.name === 'mcp.vendor.lookup'), false);
  await registry.close();
});

test('host instructions reuse canonical shell guidance for every platform', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    assert.ok(hostEnvironmentInstruction(platform).includes(shellToolGuidance(platform)));
  }
});
