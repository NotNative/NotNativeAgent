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
    return new Response(JSON.stringify({ ok: true, data: { url: 'https://example.org/', title: 'Example' } }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal(definition.sideEffect, 'unknown');
  assert.deepEqual((await definition.validate({ action: 'snapshot' })).args, { action: 'snapshot' });
  await assert.rejects(definition.validate({ action: 'snapshot', url: 'https://example.com' }));
  await assert.rejects(definition.validate({ action: 'open', url: 'http://example.com' }));
  await assert.rejects(definition.validate({ action: 'open', url: 'https://user:pass@example.com' }));
  await assert.rejects(definition.validate({ action: 'inspect' }));
  await assert.rejects(definition.validate({ action: 'inspect', selector: '#send', url: 'https://example.com' }));
  assert.deepEqual((await definition.validate({ action: 'inspect', selector: '#send' })).args, { action: 'inspect', selector: '#send' });
  await assert.rejects(definition.validate({ action: 'click', selector: '#send' }));
  await assert.rejects(definition.validate({ action: 'click', selector: '#send', expectedUrl: 'http://remote.example/' }));
  assert.deepEqual((await definition.validate({ action: 'click', selector: '#send', expectedUrl: 'https://example.org/' })).args,
    { action: 'click', selector: '#send', expectedUrl: 'https://example.org/' });
  const click = await definition.validate({ action: 'click', selector: '#send', expectedUrl: 'https://example.org/' });
  await assert.rejects(definition.executor(click, new AbortController().signal), /fresh snapshot/u);
  const request = await definition.validate({ action: 'open', url: 'https://example.com' });
  const signal = new AbortController().signal;
  const result = await definition.executor(request, signal);
  assert.deepEqual(JSON.parse(result.content), { url: 'https://example.org/', title: 'Example' });
  assert.equal(calls[0].target, url);
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.headers['x-nnd-browser-token'], token);
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: 'browser.open', parameters: { url: 'https://example.com' } });
  await definition.executor(await definition.validate({ action: 'inspect', selector: '#send' }), signal);
  assert.deepEqual(JSON.parse(calls[1].options.body), { action: 'browser.inspect', parameters: { selector: '#send' } });
  await definition.executor(await definition.validate({ action: 'snapshot' }), signal);
  await definition.executor(await definition.validate({ action: 'click', selector: '#send', expectedUrl: 'https://example.org/' }), signal);
  assert.deepEqual(JSON.parse(calls[3].options.body), { action: 'browser.click', parameters: { selector: '#send', expectedUrl: 'https://example.org/' } });
  await assert.rejects(definition.executor(click, signal), /fresh snapshot/u);
  assert.equal(calls.length, 4);
});

test('a later open consumes observation and an old snapshot cannot reauthorize a click', async () => {
  let finishSnapshot;
  const calls = [];
  const definition = nndBrowserDefinition({ url, token }, { fetcher: async (_target, options) => {
    const action = JSON.parse(options.body).action;
    calls.push(action);
    if (action === 'browser.snapshot') return new Promise((resolve) => { finishSnapshot = () => resolve(new Response(JSON.stringify({
      ok: true, data: { url: 'https://example.org/' },
    }))); });
    return new Response(JSON.stringify({ ok: true, data: { opened: true } }));
  } });
  const signal = new AbortController().signal;
  const snapshot = definition.executor(await definition.validate({ action: 'snapshot' }), signal);
  await definition.executor(await definition.validate({ action: 'open', url: 'https://example.net/' }), signal);
  finishSnapshot();
  await snapshot;
  await assert.rejects(definition.executor(await definition.validate({ action: 'click', selector: '#send',
    expectedUrl: 'https://example.org/' }), signal), /fresh snapshot/u);
  assert.deepEqual(calls, ['browser.snapshot', 'browser.open']);
});

test('browser tool refuses oversized replies and failed desktop outcomes', async () => {
  const args = await nndBrowserDefinition({ url, token }).validate({ action: 'snapshot' });
  const large = nndBrowserDefinition({ url, token }, { fetcher: async () => new Response('x'.repeat(262145)) });
  await assert.rejects(large.executor(args, new AbortController().signal), /bound/u);
  const failed = nndBrowserDefinition({ url, token }, { fetcher: async () => new Response(JSON.stringify({ ok: false, error: 'desktop refused' })) });
  await assert.rejects(failed.executor(args, new AbortController().signal), /desktop refused/u);
});

test('a disconnected desktop after click dispatch remains an uncertain outcome', async () => {
  const definition = nndBrowserDefinition({ url, token }, { fetcher: async (_target, options) =>
    JSON.parse(options.body).action === 'browser.snapshot'
      ? new Response(JSON.stringify({ ok: true, data: { url: 'https://example.org/' } }))
      : new Response(JSON.stringify({ error: 'desktop disconnected' }), { status: 503 }) });
  const signal = new AbortController().signal;
  await definition.executor(await definition.validate({ action: 'snapshot' }), signal);
  const click = await definition.validate({ action: 'click', selector: '#send', expectedUrl: 'https://example.org/' });
  await assert.rejects(definition.executor(click, signal), /outcome is uncertain/u);
  await assert.rejects(definition.executor(click, signal), /fresh snapshot/u);
});
