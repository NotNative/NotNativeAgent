// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { consumeNndBrowserCallbackFromEnvironment, nndBrowserCallbackFromEnvironment, nndBrowserDefinition } from '../src/nnd-browser-tool.js';

const token = 's'.repeat(43);
const url = 'http://127.0.0.1:4172/api/browser-control/request';
const observationId = '00000000-0000-4000-8000-000000000007';

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
    const snapshot = JSON.parse(options.body).action === 'browser.snapshot';
    return new Response(JSON.stringify({ ok: true, data: {
      url: 'https://example.org/', title: 'Example', ...(snapshot ? { observationRevision: 7, observationId } : {}),
    } }), { headers: { 'content-type': 'application/json' } });
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
  await assert.rejects(definition.validate({ action: 'scroll', direction: 'down' }));
  await assert.rejects(definition.validate({ action: 'type', selector: '#query', text: 'x' }));
  await assert.rejects(definition.validate({ action: 'type', selector: '#query', expectedUrl: 'https://example.org/' }));
  await assert.rejects(definition.validate({ action: 'type', selector: '#query', expectedUrl: 'https://example.org/', text: 'x'.repeat(2001) }));
  await assert.rejects(definition.validate({ action: 'type', selector: '#query', expectedUrl: 'https://example.org/', text: 'x', direction: 'down' }));
  assert.deepEqual((await definition.validate({ action: 'type', selector: '#query', expectedUrl: 'https://example.org/', text: '' })).args,
    { action: 'type', selector: '#query', expectedUrl: 'https://example.org/', text: '' });
  assert.deepEqual((await definition.validate({ action: 'scroll', direction: 'down', expectedUrl: 'https://example.org/' })).args,
    { action: 'scroll', direction: 'down', expectedUrl: 'https://example.org/' });
  assert.deepEqual((await definition.validate({ action: 'click', selector: '#send', expectedUrl: 'https://example.org/' })).args,
    { action: 'click', selector: '#send', expectedUrl: 'https://example.org/' });
  const click = await definition.validate({ action: 'click', selector: '#send', expectedUrl: 'https://example.org/' });
  await assert.rejects(definition.executor(click, new AbortController().signal), /fresh snapshot/u);
  const scroll = await definition.validate({ action: 'scroll', direction: 'down', expectedUrl: 'https://example.org/' });
  await assert.rejects(definition.executor(scroll, new AbortController().signal), /fresh snapshot/u);
  const type = await definition.validate({ action: 'type', selector: '#query', expectedUrl: 'https://example.org/', text: 'hello' });
  await assert.rejects(definition.executor(type, new AbortController().signal), /fresh snapshot/u);
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
  assert.deepEqual(JSON.parse(calls[3].options.body), { action: 'browser.click', parameters: { selector: '#send', expectedUrl: 'https://example.org/', observationRevision: 7, observationId } });
  await assert.rejects(definition.executor(click, signal), /fresh snapshot/u);
  assert.equal(calls.length, 4);
  await definition.executor(await definition.validate({ action: 'snapshot' }), signal);
  await definition.executor(scroll, signal);
  assert.deepEqual(JSON.parse(calls[5].options.body), { action: 'browser.scroll', parameters: { direction: 'down', expectedUrl: 'https://example.org/', observationRevision: 7, observationId } });
  await assert.rejects(definition.executor(scroll, signal), /fresh snapshot/u);
  await definition.executor(await definition.validate({ action: 'snapshot' }), signal);
  await definition.executor(type, signal);
  assert.deepEqual(JSON.parse(calls[7].options.body), { action: 'browser.type', parameters: {
    selector: '#query', expectedUrl: 'https://example.org/', text: 'hello', observationRevision: 7, observationId,
  } });
  await assert.rejects(definition.executor(type, signal), /fresh snapshot/u);
});

test('a later open consumes observation and an old snapshot cannot reauthorize a click', async () => {
  let finishSnapshot;
  const calls = [];
  const definition = nndBrowserDefinition({ url, token }, { fetcher: async (_target, options) => {
    const action = JSON.parse(options.body).action;
    calls.push(action);
    if (action === 'browser.snapshot') return new Promise((resolve) => { finishSnapshot = () => resolve(new Response(JSON.stringify({
      ok: true, data: { url: 'https://example.org/', observationRevision: 7, observationId },
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
  const noRevision = nndBrowserDefinition({ url, token }, { fetcher: async () => new Response(JSON.stringify({
    ok: true, data: { url: 'https://example.org/' },
  })) });
  await assert.rejects(noRevision.executor(args, new AbortController().signal), /safe observation/u);
});

test('a disconnected desktop after click dispatch remains an uncertain outcome', async () => {
  const definition = nndBrowserDefinition({ url, token }, { fetcher: async (_target, options) =>
    JSON.parse(options.body).action === 'browser.snapshot'
      ? new Response(JSON.stringify({ ok: true, data: { url: 'https://example.org/', observationRevision: 7, observationId } }))
      : new Response(JSON.stringify({ error: 'desktop disconnected' }), { status: 503 }) });
  const signal = new AbortController().signal;
  await definition.executor(await definition.validate({ action: 'snapshot' }), signal);
  const click = await definition.validate({ action: 'click', selector: '#send', expectedUrl: 'https://example.org/' });
  await assert.rejects(definition.executor(click, signal), /outcome is uncertain/u);
  await assert.rejects(definition.executor(click, signal), /fresh snapshot/u);
});

test('a timed-out scroll consumes its observation even when the desktop outcome is unknown', async () => {
  const calls = [];
  const definition = nndBrowserDefinition({ url, token }, { fetcher: async (_target, options) => {
    const action = JSON.parse(options.body).action;
    calls.push(action);
    return action === 'browser.snapshot'
      ? new Response(JSON.stringify({ ok: true, data: { url: 'https://example.org/', observationRevision: 7, observationId } }))
      : new Response(JSON.stringify({ error: 'timed out' }), { status: 504 });
  } });
  const signal = new AbortController().signal;
  const snapshot = await definition.validate({ action: 'snapshot' });
  const scroll = await definition.validate({ action: 'scroll', direction: 'down', expectedUrl: 'https://example.org/' });
  await definition.executor(snapshot, signal);
  await assert.rejects(definition.executor(scroll, signal), /outcome is uncertain/u);
  await assert.rejects(definition.executor(scroll, signal), /fresh snapshot/u);
  assert.deepEqual(calls, ['browser.snapshot', 'browser.scroll']);
});

test('a failed type dispatch consumes its observation and reports uncertainty', async () => {
  const calls = [];
  const definition = nndBrowserDefinition({ url, token }, { fetcher: async (_target, options) => {
    const action = JSON.parse(options.body).action;
    calls.push(action);
    return action === 'browser.snapshot'
      ? new Response(JSON.stringify({ ok: true, data: { url: 'https://example.org/', observationRevision: 7, observationId } }))
      : new Response(JSON.stringify({ error: 'timeout' }), { status: 504 });
  } });
  const signal = new AbortController().signal;
  const type = await definition.validate({ action: 'type', selector: '#query', expectedUrl: 'https://example.org/', text: 'hello' });
  await definition.executor(await definition.validate({ action: 'snapshot' }), signal);
  await assert.rejects(definition.executor(type, signal), /outcome is uncertain/u);
  await assert.rejects(definition.executor(type, signal), /fresh snapshot/u);
  assert.deepEqual(calls, ['browser.snapshot', 'browser.type']);
});

test('capture requires a single-use observation and saves only a validated bounded image', async () => {
  const captureRoot = await mkdtemp(join(tmpdir(), 'nna-browser-capture-'));
  const calls = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  try {
    const definition = nndBrowserDefinition({ url, token }, { captureRoot, fetcher: async (_target, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      return new Response(JSON.stringify({ ok: true, data: body.action === 'browser.snapshot'
        ? { url: 'https://example.org/', observationRevision: 7, observationId }
        : { url: 'https://example.org/', mime: 'image/jpeg', width: 800, height: 600, base64: jpeg.toString('base64') } }));
    } });
    const capture = await definition.validate({ action: 'capture', expectedUrl: 'https://example.org/' });
    await assert.rejects(definition.executor(capture, new AbortController().signal), /fresh snapshot/u);
    await assert.rejects(definition.validate({ action: 'capture', expectedUrl: 'https://example.org/', selector: '#x' }));
    await definition.executor(await definition.validate({ action: 'snapshot' }), new AbortController().signal);
    const receipt = await definition.executor(capture, new AbortController().signal);
    const path = receipt.metadata.path;
    assert.match(receipt.content, /Use image_inspect with this exact path/u);
    assert.deepEqual(await readFile(path), jpeg);
    assert.deepEqual(calls.at(-1), { action: 'browser.capture', parameters: {
      expectedUrl: 'https://example.org/', observationRevision: 7, observationId,
    } });
    await assert.rejects(definition.executor(capture, new AbortController().signal), /fresh snapshot/u);
  } finally { await rm(captureRoot, { recursive: true, force: true }); }
});

test('malformed capture reply is never persisted', async () => {
  const captureRoot = await mkdtemp(join(tmpdir(), 'nna-browser-capture-'));
  try {
    const definition = nndBrowserDefinition({ url, token }, { captureRoot, fetcher: async (_target, options) => {
      const action = JSON.parse(options.body).action;
      return new Response(JSON.stringify({ ok: true, data: action === 'browser.snapshot'
        ? { url: 'https://example.org/', observationRevision: 7, observationId }
        : { url: 'https://example.org/', mime: 'image/jpeg', width: 800, height: 600, base64: Buffer.from('not a jpeg').toString('base64') } }));
    } });
    const signal = new AbortController().signal;
    await definition.executor(await definition.validate({ action: 'snapshot' }), signal);
    await assert.rejects(definition.executor(await definition.validate({ action: 'capture', expectedUrl: 'https://example.org/' }), signal), /capture image was invalid/u);
    assert.deepEqual(await readdir(captureRoot), []);
  } finally { await rm(captureRoot, { recursive: true, force: true }); }
});

test('capture quota preserves prior screenshots and refuses unbounded session growth', async () => {
  const captureRoot = await mkdtemp(join(tmpdir(), 'nna-browser-capture-'));
  try {
    await Promise.all(Array.from({ length: 256 }, (_, index) => writeFile(join(captureRoot,
      `capture-${String(index).padStart(8, '0')}-0000-4000-8000-000000000000.jpg`), 'retained')));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const definition = nndBrowserDefinition({ url, token }, { captureRoot, fetcher: async (_target, options) =>
      new Response(JSON.stringify({ ok: true, data: JSON.parse(options.body).action === 'browser.snapshot'
        ? { url: 'https://example.org/', observationRevision: 7, observationId }
        : { url: 'https://example.org/', mime: 'image/jpeg', width: 800, height: 600,
          base64: jpeg.toString('base64') } })) });
    const signal = new AbortController().signal;
    await definition.executor(await definition.validate({ action: 'snapshot' }), signal);
    await assert.rejects(definition.executor(await definition.validate({ action: 'capture',
      expectedUrl: 'https://example.org/' }), signal), { code: 'nnd_browser_capture_limit' });
    assert.equal((await readdir(captureRoot)).length, 256);
  } finally { await rm(captureRoot, { recursive: true, force: true }); }
});
