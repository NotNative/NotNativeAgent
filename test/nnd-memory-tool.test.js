// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';
import { consumeNndAgentToolCallbackFromEnvironment, nndAgentToolCallbackFromEnvironment,
  nndMemoryDefinition } from '../src/nnd-memory-tool.js';

const URL = 'http://127.0.0.1:4173/api/agent-tool/callback';
const TOKEN = 'a'.repeat(43);
const CALLBACK = { url: URL, token: TOKEN };

test('NND memory launch callback accepts only the exact managed loopback pair', () => {
  assert.equal(nndAgentToolCallbackFromEnvironment({}), null);
  assert.throws(() => nndAgentToolCallbackFromEnvironment({
    NNA_NND_AGENT_TOOL_URL: 'http://evil.example:4173/api/agent-tool/callback', NNA_NND_AGENT_TOOL_TOKEN: TOKEN,
  }), { code: 'nnd_agent_tool_callback_invalid' });
  assert.throws(() => nndAgentToolCallbackFromEnvironment({
    NNA_NND_AGENT_TOOL_URL: 'http://127.0.0.1:0/api/agent-tool/callback', NNA_NND_AGENT_TOOL_TOKEN: TOKEN,
  }), { code: 'nnd_agent_tool_callback_invalid' });
  assert.throws(() => nndAgentToolCallbackFromEnvironment({ NNA_NND_AGENT_TOOL_URL: URL }), { code: 'nnd_agent_tool_callback_invalid' });
  assert.deepEqual(nndAgentToolCallbackFromEnvironment({ NNA_NND_AGENT_TOOL_URL: URL, NNA_NND_AGENT_TOOL_TOKEN: TOKEN }), CALLBACK);
  const previousUrl = process.env.NNA_NND_AGENT_TOOL_URL;
  const previousToken = process.env.NNA_NND_AGENT_TOOL_TOKEN;
  try {
    process.env.NNA_NND_AGENT_TOOL_URL = URL;
    process.env.NNA_NND_AGENT_TOOL_TOKEN = TOKEN;
    assert.deepEqual(consumeNndAgentToolCallbackFromEnvironment(process.env), CALLBACK);
    assert.equal(process.env.NNA_NND_AGENT_TOOL_URL, undefined);
    assert.equal(process.env.NNA_NND_AGENT_TOOL_TOKEN, undefined);
    process.env.NNA_NND_AGENT_TOOL_URL = 'http://evil.example/api/agent-tool/callback';
    process.env.NNA_NND_AGENT_TOOL_TOKEN = TOKEN;
    assert.throws(() => consumeNndAgentToolCallbackFromEnvironment(process.env), { code: 'nnd_agent_tool_callback_invalid' });
    assert.equal(process.env.NNA_NND_AGENT_TOOL_URL, undefined);
  } finally {
    if (previousUrl === undefined) delete process.env.NNA_NND_AGENT_TOOL_URL;
    else process.env.NNA_NND_AGENT_TOOL_URL = previousUrl;
    if (previousToken === undefined) delete process.env.NNA_NND_AGENT_TOOL_TOKEN;
    else process.env.NNA_NND_AGENT_TOOL_TOKEN = previousToken;
  }
});

test('memory tool registry is conditional on NND launch and rejects malformed actions', async () => {
  assert.throws(() => nndMemoryDefinition(null), { code: 'nnd_agent_tool_callback_invalid' });
  const standalone = new ToolRegistry(process.cwd(), { nndAgentToolCallback: CALLBACK });
  const desktop = new ToolRegistry(process.cwd(), { browserSurface: 'nnd', nndAgentToolCallback: CALLBACK });
  await Promise.all([standalone.initialize(), desktop.initialize()]);
  const definition = desktop.definition('openchamber_memory');
  try {
    assert.equal(standalone.definition('openchamber_memory'), undefined);
    assert.equal(definition.name, 'openchamber_memory');
    await assert.rejects(definition.validate({ action: 'save', parameters: { title: 'Title' } }), /save parameters/u);
    await assert.rejects(definition.validate({
      action: 'save', parameters: { title: 'Title', body: 'Body', scope: 'both' },
    }), /save parameters/u);
    await assert.rejects(definition.validate({
      action: 'save', parameters: { title: 'Token', body: 'api_key=super-secret-value' },
    }), /secret-like content/u);
    await assert.rejects(definition.validate({ action: 'delete', parameters: { memoryId: 'm' } }), /delete parameters/u);
    await assert.rejects(definition.validate({
      action: 'read', parameters: { title: '', memoryId: 'm' },
    }), /title/u);
  } finally {
    await Promise.all([standalone.close(), desktop.close()]);
  }
});

test('memory executor sends the bounded server contract and returns a plain JSON result', async () => {
  const requests = [];
  const definition = nndMemoryDefinition(CALLBACK, {
    contextDirectory: 'C:\\managed\\project', fetcher: async (target, options) => {
      requests.push({ target, options });
      return new Response(JSON.stringify({ memory: [{ memoryId: 'm_1', title: 'Rules' }] }), { status: 200 });
    },
  });
  const request = await definition.validate({ action: 'list', parameters: { scope: 'both' } });
  const result = await definition.executor(request, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].target, URL);
  assert.equal(requests[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(requests[0].options.body), { tool: 'openchamber_memory',
    input: { action: 'memory.list', parameters: { scope: 'both' } }, contextDirectory: 'C:\\managed\\project' });
  assert.deepEqual(JSON.parse(result.content), { memory: [{ memoryId: 'm_1', title: 'Rules' }] });
  assert.equal(result.metadata.surface, 'nnd-managed-memory');
});

test('memory executor turns errors into bounded recovery messages and rejects bad or oversized replies', async () => {
  const definition = nndMemoryDefinition(CALLBACK, { contextDirectory: 'C:\\managed\\project', fetcher: async () => new Response('bad') });
  const unavailable = nndMemoryDefinition(CALLBACK, { contextDirectory: null, fetcher: async () => assert.fail('not called') });
  await assert.rejects(unavailable.executor({ args: { action: 'list', parameters: {} } }, undefined), {
    code: 'nnd_agent_tool_unavailable',
  });
  await assert.rejects(definition.executor({ args: { action: 'list', parameters: {} } }, undefined), {
    code: 'nnd_agent_tool_reply_invalid',
  });
  const errors = nndMemoryDefinition(CALLBACK, { contextDirectory: 'C:\\managed\\project', fetcher: async () =>
    new Response(JSON.stringify({ error: 'x'.repeat(600) }), { status: 503 }) });
  await assert.rejects(errors.executor({ args: { action: 'list', parameters: {} } }, undefined), {
    code: 'nnd_agent_tool_failed',
  });
  const large = nndMemoryDefinition(CALLBACK, { contextDirectory: 'C:\\managed\\project', fetcher: async () => new Response('x'.repeat(262145)) });
  await assert.rejects(large.executor({ args: { action: 'list', parameters: {} } }, undefined), {
    code: 'nnd_agent_tool_reply_large',
  });
});
