// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { runProviderConformance } from '../scripts/provider-conformance.js';

function document() {
  return { schema_version: 1, providers: [
    {
      id: 'alpha', implementation: 'server-alpha', implementation_version: '1.0',
      endpoint: 'http://127.0.0.1:10001/v1', model: 'model-alpha', trust_zone: 'loopback',
    },
    {
      id: 'beta', implementation: 'server-beta', implementation_version: '2.0',
      endpoint: 'http://127.0.0.1:10002/v1', model: 'model-beta', trust_zone: 'loopback', tool_call_mode: 'batch',
    },
  ] };
}

test('PROV-012 harness runs identical content-free cases against two declared independent servers', async () => {
  const requests = [];
  const fetch = async (url, options = {}) => {
    const model = url.includes('10001') ? 'model-alpha' : 'model-beta';
    if (url.endsWith('/models')) return Response.json({ data: [{ id: model }] });
    const body = JSON.parse(options.body); requests.push({
      model, hasTools: body.tools?.length === 1,
      parallelToolCalls: Object.hasOwn(body, 'parallel_tool_calls') ? body.parallel_tool_calls : null,
    });
    const delta = body.tools ? {
      tool_calls: [{ index: 0, id: `call-${model}`, function: {
        name: 'nna_conformance_echo', arguments: '{"text":"provider-ok"}',
      } }],
    } : { content: 'ok' };
    return new Response([
      `data: ${JSON.stringify({ choices: [{ delta, finish_reason: body.tools ? 'tool_calls' : 'stop' }] })}`,
      '', 'data: [DONE]', '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const report = await runProviderConformance(document(), {
    fetch, now: () => new Date('2026-08-03T12:00:00.000Z'),
  });
  assert.equal(report.passed, true);
  assert.equal(report.providers.length, 2);
  assert.deepEqual(report.providers.map((item) => item.cases.map((entry) => entry.name)), [
    ['model_enumeration', 'streaming_text', 'streaming_tool_call'],
    ['model_enumeration', 'streaming_text', 'streaming_tool_call'],
  ]);
  assert.deepEqual(requests, [
    { model: 'model-alpha', hasTools: false, parallelToolCalls: null },
    { model: 'model-alpha', hasTools: true, parallelToolCalls: false },
    { model: 'model-beta', hasTools: false, parallelToolCalls: null },
    { model: 'model-beta', hasTools: true, parallelToolCalls: null },
  ]);
  assert.deepEqual(report.providers.map((item) => item.tool_call_mode), ['single', 'batch']);
  assert.equal(JSON.stringify(report).includes('provider-ok'), false);
  assert.equal(JSON.stringify(report).includes('conformance check'), false);
});

test('PROV-012 harness rejects duplicate implementation claims before network access', async () => {
  const value = document(); value.providers[1].implementation = value.providers[0].implementation;
  let called = false;
  await assert.rejects(runProviderConformance(value, { fetch: async () => { called = true; } }), {
    code: 'provider_conformance_independence_invalid',
  });
  assert.equal(called, false);
});

test('PROV-012 harness records stable failure codes without provider content', async () => {
  const fetch = async (url) => {
    const model = url.includes('10001') ? 'model-alpha' : 'model-beta';
    if (url.endsWith('/models')) return Response.json({ data: [{ id: model }] });
    return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  const report = await runProviderConformance(document(), { fetch });
  assert.equal(report.passed, false);
  assert.deepEqual(report.providers.map((item) => item.cases[1].error_code), [
    'provider_empty_text', 'provider_empty_text',
  ]);
});

test('PROV-012 harness rejects a tool call with the wrong conformance value', async () => {
  const fetch = async (url, options = {}) => {
    const model = url.includes('10001') ? 'model-alpha' : 'model-beta';
    if (url.endsWith('/models')) return Response.json({ data: [{ id: model }] });
    const body = JSON.parse(options.body);
    const delta = body.tools ? { tool_calls: [{ index: 0, id: `call-${model}`, function: {
      name: 'nna_conformance_echo', arguments: '{"text":"wrong"}',
    } }] } : { content: 'ok' };
    return new Response([
      `data: ${JSON.stringify({ choices: [{ delta, finish_reason: body.tools ? 'tool_calls' : 'stop' }] })}`,
      '', 'data: [DONE]', '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const report = await runProviderConformance(document(), { fetch });
  assert.equal(report.passed, false);
  assert.deepEqual(report.providers.map((item) => item.cases[2].error_code), [
    'provider_tool_call_missing', 'provider_tool_call_missing',
  ]);
});
