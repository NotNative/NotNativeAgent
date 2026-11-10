// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedBrowserTransport, hostedBrowserBindingFrom, hostedBrowserBindingFromEnvironment,
  readHostedBrowserBinding, resolveHostedBrowserBinding } from '../src/hosted-browser-client.js';

const token = 't'.repeat(43);
const url = 'http://127.0.0.1:4豆/api/openchamber/nna/browser';
const good = `http://127.0.0.1:4172/api/openchamber/nna/browser`;

test('a binding is accepted only on the pane route at a loopback address', () => {
  assert.deepEqual(hostedBrowserBindingFrom({ url: good, token }), { url: good, token });
  // Why loopback only: the pane runs pages with the operator's live logins.
  assert.equal(hostedBrowserBindingFrom({ url: 'http://10.0.0.5:4172/api/openchamber/nna/browser', token }), null);
  assert.equal(hostedBrowserBindingFrom({ url: 'https://127.0.0.1:4172/api/openchamber/nna/browser', token }), null);
  assert.equal(hostedBrowserBindingFrom({ url: 'http://127.0.0.1:4172/api/other', token }), null);
  assert.equal(hostedBrowserBindingFrom({ url: `${good}?x=1`, token }), null);
  assert.equal(hostedBrowserBindingFrom({ url: good, token: 'short' }), null);
  assert.equal(hostedBrowserBindingFrom({ url: good, token, extra: true }).token, token);
  assert.equal(hostedBrowserBindingFrom(null), null);
});

test('the environment binding is absent by default and refused when malformed', () => {
  assert.equal(hostedBrowserBindingFromEnvironment({}), null);
  assert.throws(() => hostedBrowserBindingFromEnvironment({ NNA_OPENCHAMBER_BROWSER_URL: 'http://evil.example/x', NNA_OPENCHAMBER_BROWSER_TOKEN: token }),
    { code: 'hosted_browser_binding_invalid' });
  assert.deepEqual(hostedBrowserBindingFromEnvironment({ NNA_OPENCHAMBER_BROWSER_URL: good, NNA_OPENCHAMBER_BROWSER_TOKEN: token }),
    { url: good, token });
});

test('the capability file is optional: a missing or broken file means no pane here', async () => {
  assert.equal(await readHostedBrowserBinding('/nowhere/nna-browser.json'), null);
  assert.equal(await readHostedBrowserBinding('/x', { read: async () => 'not json' }), null);
  assert.equal(await readHostedBrowserBinding('/x', { read: async () => JSON.stringify({ url: good }) }), null);
  assert.deepEqual(await readHostedBrowserBinding('/x', { read: async () => JSON.stringify({ url: good, token }) }),
    { url: good, token });
});

test('resolution prefers the launched binding over the published file', async () => {
  let readCalls = 0;
  const fromFile = await resolveHostedBrowserBinding({
    environment: { NNA_OPENCHAMBER_BROWSER_URL: good, NNA_OPENCHAMBER_BROWSER_TOKEN: token },
    capabilityPath: '/x',
    read: async () => { readCalls += 1; return JSON.stringify({ url: good, token: 'u'.repeat(43) }); },
  });
  assert.equal(fromFile.token, token);
  // Why: a launcher that handed the binding down is authoritative, and reading the
  // file as well would let a stale instance win over the one NNA just started.
  assert.equal(readCalls, 0);
  const onlyFile = await resolveHostedBrowserBinding({
    environment: {}, capabilityPath: '/x',
    read: async () => { readCalls += 1; return JSON.stringify({ url: good, token }); },
  });
  assert.deepEqual(onlyFile, { url: good, token });
  assert.equal(readCalls, 1);
});

function transportWith(reply, capture = []) {
  return createHostedBrowserTransport({ url: good, token }, {
    createId: () => 'req-1',
    fetcher: async (target, options) => {
      capture.push({ target, options });
      return typeof reply === 'function' ? reply(target, options) : reply;
    },
  });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an action sends its bearer, its parameters and the calling scope', async () => {
  const calls = [];
  const transport = transportWith(json({ ok: true, data: { clicked: '#save', label: 'Save', url: 'https://example.org/' } }), calls);
  const data = await transport.send('browser.click', { selector: '#save', tabId: 'tab-2' },
    { context: { directory: 'D:/repo', sessionId: 'ses_1' } });
  assert.deepEqual(data, { clicked: '#save', label: 'Save', url: 'https://example.org/' });
  assert.equal(calls[0].target, good);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.requestId, 'req-1');
  assert.equal(body.action, 'browser.click');
  assert.deepEqual(body.parameters, { selector: '#save', tabId: 'tab-2' });
  // Why the session travels: the pane scopes tabs to the chat, so another
  // session's page is never acted on by accident.
  assert.deepEqual(body.context, { directory: 'D:/repo', sessionId: 'ses_1' });
});

test('an action outside the pane list is refused before any request', async () => {
  const calls = [];
  const transport = transportWith(json({ ok: true, data: {} }), calls);
  await assert.rejects(transport.send('browser.explode', {}), { code: 'hosted_browser_action_unsupported' });
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
  await assert.rejects(transportWith(json({ ok: true, data: {} })).send('browser.click', {}, { signal: controller.signal }),
    { code: 'tool_cancelled' });
});

test('a refused action carries the pane message, and a malformed reply is refused', async () => {
  await assert.rejects(transportWith(json({ ok: false, error: 'No element matches #x' })).send('browser.click', { selector: '#x' }),
    (error) => error.code === 'hosted_browser_failed' && /No element matches #x/u.test(error.message));
  await assert.rejects(transportWith(new Response('not json', { status: 200 })).send('browser.snapshot', {}),
    { code: 'hosted_browser_reply_invalid' });
  await assert.rejects(transportWith(json({ data: {} })).send('browser.snapshot', {}),
    { code: 'hosted_browser_reply_invalid' });
});

test('an oversized reply is refused instead of buffered', async () => {
  const huge = new Response('x'.repeat(12_000_001), { status: 200 });
  await assert.rejects(transportWith(huge).send('browser.snapshot', {}), { code: 'hosted_browser_reply_large' });
});

test('an oversized request is refused before it is sent', async () => {
  const calls = [];
  const transport = transportWith(json({ ok: true, data: {} }), calls);
  await assert.rejects(transport.send('browser.type', { selector: '#q', value: 'x'.repeat(70_000) }),
    { code: 'hosted_browser_request_large' });
  assert.equal(calls.length, 0);
});
