// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createHostedBrowserTransport, hostedBrowserBindingFrom, hostedBrowserBindingFromEnvironment,
  hostedBrowserStateRoots, probeHostedBrowser, readHostedBrowserBinding } from '../src/hosted-browser-client.js';

const token = 't'.repeat(43);
const route = '/api/openchamber/control';
const good = `http://127.0.0.1:4172${route}`;

test('a binding is accepted only on the control route at a loopback address', () => {
  assert.equal(hostedBrowserBindingFrom({ url: good })?.url, good);
  // A local control route needs no credential; one that was issued is kept.
  assert.equal(hostedBrowserBindingFrom({ url: good, token })?.token, token);
  assert.equal(hostedBrowserBindingFrom({ url: good })?.token, null);
  // Why loopback only: the pane runs pages with the operator's live logins.
  assert.equal(hostedBrowserBindingFrom({ url: `http://10.0.0.5:4172${route}` }), null);
  assert.equal(hostedBrowserBindingFrom({ url: `https://127.0.0.1:4172${route}` }), null);
  assert.equal(hostedBrowserBindingFrom({ url: 'http://127.0.0.1:4172/api/other' }), null);
  assert.equal(hostedBrowserBindingFrom({ url: `${good}?x=1` }), null);
  assert.equal(hostedBrowserBindingFrom({ url: good, token: 'short' }), null);
  assert.equal(hostedBrowserBindingFrom(null), null);
});

test('the environment binding is absent by default and refused when malformed', () => {
  assert.equal(hostedBrowserBindingFromEnvironment({}), null);
  assert.throws(() => hostedBrowserBindingFromEnvironment({ NNA_OPENCHAMBER_BROWSER_URL: 'http://evil.example/x' }),
    { code: 'hosted_browser_binding_invalid' });
  assert.equal(hostedBrowserBindingFromEnvironment({ NNA_OPENCHAMBER_BROWSER_URL: good }).url, good);
});

test('state roots come from OpenChamber convention, not NNA data', () => {
  const roots = hostedBrowserStateRoots({ APPDATA: 'C:/Roaming' }, 'C:/home');
  assert.equal(roots.length, 2);
  assert.ok(roots[0].endsWith('openchamber'));
  assert.ok(roots[1].endsWith('OpenChamber'));
  // A relocated data root wins, and is honoured as given.
  const configured = hostedBrowserStateRoots({ OPENCHAMBER_DATA_DIR: 'D:/oc-data' }, 'C:/home');
  assert.equal(configured[0], resolve('D:/oc-data'));
});

test('a capability file is optional, and a broken one is simply absent', async () => {
  assert.equal(await readHostedBrowserBinding('/nowhere/nna-browser.json'), null);
  assert.equal(await readHostedBrowserBinding('/x', { read: async () => 'not json' }), null);
  assert.equal(await readHostedBrowserBinding('/x', { read: async () => JSON.stringify({ url: 'https://e.org' }) }), null);
  assert.equal((await readHostedBrowserBinding('/x', { read: async () => JSON.stringify({ url: good }) })).url, good);
});

test('a port that answers the control route is usable, and a silent one is not', async () => {
  const answered = await probeHostedBrowser({ ports: [1234], fetcher: async (url) => {
    assert.match(url, /127\.0\.0\.1:1234\/api\/openchamber\/control$/u);
    return new Response('{"defaultModel":null}', { status: 200 });
  } });
  assert.equal(answered.url, `http://127.0.0.1:1234${route}`);
  assert.equal(answered.token, null);
  const silent = await probeHostedBrowser({ ports: [1234], fetcher: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(silent, null);
  assert.equal(await probeHostedBrowser({ ports: [] }), null);
});

function transportWith(reply, capture = []) {
  return createHostedBrowserTransport({ url: good, token: null }, {
    fetcher: async (target, options) => {
      capture.push({ target, options });
      return typeof reply === 'function' ? reply(target, options) : reply;
    },
  });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an action carries its inputs and the calling scope in one body', async () => {
  const calls = [];
  const transport = transportWith(json({ clicked: 'html > body > a', label: 'Learn more', url: 'https://example.com/' }), calls);
  const data = await transport.send('browser.click', { selector: 'a', tabId: 'tab-2' },
    { context: { directory: 'D:/repo', sessionId: 'ses_1' } });
  assert.deepEqual(data, { clicked: 'html > body > a', label: 'Learn more', url: 'https://example.com/' });
  assert.equal(calls[0].target, good);
  assert.equal(calls[0].options.method, 'POST');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.action, 'browser.click');
  assert.deepEqual(body.input, { selector: 'a', tabId: 'tab-2', action: 'browser.click' });
  // Why the session travels: the pane scopes tabs to the chat.
  assert.equal(body.contextSessionId, 'ses_1');
  assert.equal(body.contextDirectory, 'D:/repo');
});

test('an action outside the pane list is refused before any request', async () => {
  const calls = [];
  const transport = transportWith(json({}), calls);
  await assert.rejects(transport.send('browser.explode', {}), { code: 'hosted_browser_action_unsupported' });
  await assert.rejects(transport.send('secret.run', {}), { code: 'hosted_browser_action_unsupported' });
  assert.equal(calls.length, 0);
});

test('an unauthenticated or unreachable pane is reported as such', async () => {
  await assert.rejects(transportWith(json({ error: 'Unauthorized' }, 401)).send('browser.snapshot', {}),
    { code: 'hosted_browser_unauthorized' });
  await assert.rejects(transportWith(() => { throw new Error('ECONNREFUSED'); }).send('browser.snapshot', {}),
    { code: 'hosted_browser_unreachable' });
});

test('a cancelled action is a cancellation, not a pane failure', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transportWith(json({})).send('browser.click', {}, { signal: controller.signal }),
    { code: 'tool_cancelled' });
});

test('a refused action carries the pane message, and a malformed reply is refused', async () => {
  // The pane answers a refusal with `{ error }`, sometimes with a status and
  // sometimes, as the host route does, in a 200 body. Both must read as refusals.
  await assert.rejects(transportWith(json({ error: 'No element matches #x' }, 400)).send('browser.click', { selector: '#x' }),
    (error) => error.code === 'hosted_browser_failed' && /No element matches #x/u.test(error.message));
  await assert.rejects(transportWith(json({ error: 'This browser.close did not come from a session' })).send('browser.close', {}),
    (error) => error.code === 'hosted_browser_failed' && /did not come from a session/u.test(error.message));
  await assert.rejects(transportWith(new Response('not json', { status: 200 })).send('browser.snapshot', {}),
    { code: 'hosted_browser_reply_invalid' });
});

test('an oversized reply is refused instead of buffered', async () => {
  await assert.rejects(transportWith(new Response('x'.repeat(12_000_001), { status: 200 })).send('browser.snapshot', {}),
    { code: 'hosted_browser_reply_large' });
});

test('an oversized request is refused before it is sent', async () => {
  const calls = [];
  const transport = transportWith(json({}), calls);
  await assert.rejects(transport.send('browser.type', { selector: '#q', value: 'x'.repeat(70_000) }),
    { code: 'hosted_browser_request_large' });
  assert.equal(calls.length, 0);
});
