// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consumeNndBrowserCallbackFromEnvironment, nndBrowserCallbackFromEnvironment, nndBrowserDefinition } from '../src/nnd-browser-tool.js';

const token = 's'.repeat(43);
const url = 'http://127.0.0.1:4172/api/browser-control/request';

test('desktop callback is absent by default and rejects non-loopback authority', () => {
  assert.equal(nndBrowserCallbackFromEnvironment({}), null);
  assert.throws(() => nndBrowserCallbackFromEnvironment({ NNA_NND_BROWSER_URL: 'http://evil.example:4172/api/browser-control/request', NNA_NND_BROWSER_TOKEN: token }));
  assert.throws(() => nndBrowserCallbackFromEnvironment({ NNA_NND_BROWSER_URL: url }));
  assert.deepEqual(nndBrowserCallbackFromEnvironment({ NNA_NND_BROWSER_URL: url, NNA_NND_BROWSER_TOKEN: token }), { url, token });
});

test('NND child consumes callback credentials from its process environment', () => {
  const previousUrl = process.env.NNA_NND_BROWSER_URL;
  const previousToken = process.env.NNA_NND_BROWSER_TOKEN;
  try {
    process.env.NNA_NND_BROWSER_URL = url;
    process.env.NNA_NND_BROWSER_TOKEN = token;
    assert.deepEqual(consumeNndBrowserCallbackFromEnvironment(process.env), { url, token });
    assert.equal(process.env.NNA_NND_BROWSER_URL, undefined);
    assert.equal(process.env.NNA_NND_BROWSER_TOKEN, undefined);
    process.env.NNA_NND_BROWSER_URL = 'http://evil.example/api/browser-control/request';
    process.env.NNA_NND_BROWSER_TOKEN = token;
    assert.throws(() => consumeNndBrowserCallbackFromEnvironment(process.env));
    assert.equal(process.env.NNA_NND_BROWSER_URL, undefined);
    assert.equal(process.env.NNA_NND_BROWSER_TOKEN, undefined);
  } finally {
    if (previousUrl === undefined) delete process.env.NNA_NND_BROWSER_URL;
    else process.env.NNA_NND_BROWSER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.NNA_NND_BROWSER_TOKEN;
    else process.env.NNA_NND_BROWSER_TOKEN = previousToken;
  }
});

test('governed browser tool validates narrow actions and forwards cancellation', async () => {
  const calls = [];
  const definition = nndBrowserDefinition({ url, token }, { fetcher: async (target, options) => {
    calls.push({ target, options });
    return new Response(JSON.stringify({ ok: true, data: { title: 'Example' } }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(definition.sideEffect, 'unknown');
  assert.deepEqual((await definition.validate({ action: 'snapshot' })).args, { action: 'snapshot' });
  await assert.rejects(definition.validate({ action: 'snapshot', url: 'https://example.com' }));
  await assert.rejects(definition.validate({ action: 'open', url: 'http://example.com' }));
  await assert.rejects(definition.validate({ action: 'open', url: 'https://user:pass@example.com' }));
  const request = await definition.validate({ action: 'open', url: 'https://example.com' });
  const signal = new AbortController().signal;
  const result = await definition.executor(request, signal);
  assert.deepEqual(JSON.parse(result.content), { title: 'Example' });
  assert.equal(calls[0].target, url);
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers['x-nnd-browser-token'], token);
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'browser.open', parameters: { url: 'https://example.com' } });
});

test('browser tool refuses oversized replies and failed desktop outcomes', async () => {
  const args = await nndBrowserDefinition({ url, token }).validate({ action: 'snapshot' });
  const large = nndBrowserDefinition({ url, token }, { fetcher: async () => new Response('x'.repeat(262145)) });
  await assert.rejects(large.executor(args, new AbortController().signal), /bound/u);
  const failed = nndBrowserDefinition({ url, token }, { fetcher: async () => new Response(JSON.stringify({ ok: false, error: 'desktop refused' })) });
  await assert.rejects(failed.executor(args, new AbortController().signal), /desktop refused/u);
});
