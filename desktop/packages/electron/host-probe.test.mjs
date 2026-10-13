// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { probeDesktopHost, probeElectronHostWithDeadline } from './host-probe.mjs';

const compatible = {
  status: 'ok',
  compatibility: { apiVersion: 1, minClientApiVersion: 1, capabilities: ['api.runtime-url.v1'] },
};

test('probes version and authenticated session with bounded, sanitized credentials', async () => {
  const calls = [];
  const result = await probeElectronHostWithDeadline({
    url: 'https://remote.example/base/', clientToken: 'client-token',
    requestHeaders: { 'x-device': 'desktop', Authorization: 'untrusted', cookie: 'nope' },
    chromiumFetch: async (url, options) => {
      calls.push({ url, options });
      return url.endsWith('/api/version') ? Response.json(compatible) : Response.json({ status: 'ok' });
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(calls[0].url, 'https://remote.example/base/api/version');
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer client-token');
  assert.equal(calls[0].options.headers.get('x-device'), 'desktop');
  assert.equal(calls[0].options.headers.has('cookie'), false);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[1].url, 'https://remote.example/base/auth/session');
});

test('host URL query parameters are not carried into API requests', async () => {
  const calls = [];
  const result = await probeElectronHostWithDeadline({
    url: 'https://remote.example/base/?ticket=browser-secret#section',
    chromiumFetch: async (url) => {
      calls.push(url);
      return Response.json(compatible);
    },
  });
  assert.equal(result.status, 'ok');
  assert.deepEqual(calls, [
    'https://remote.example/base/api/version',
    'https://remote.example/base/auth/session',
  ]);
});

test('expected server identity is checked before any credential-bearing request', async () => {
  const calls = [];
  const result = await probeElectronHostWithDeadline({
    url: 'https://remote.example', expectedServerId: 'expected', clientToken: 'secret',
    chromiumFetch: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true, serverId: 'different' });
    },
  });
  assert.deepEqual(result.status, 'wrong-service');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://remote.example/health');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(new Headers(calls[0].options.headers).has('authorization'), false);
});

test('expected server identity fails closed when a successful health response omits identity', async (t) => {
  for (const body of [{ ok: true }, { ok: true, serverId: null }]) {
    await t.test(JSON.stringify(body), async () => {
      const calls = [];
      const result = await probeElectronHostWithDeadline({
        url: 'https://remote.example', expectedServerId: 'expected', clientToken: 'secret',
        chromiumFetch: async (url) => {
          calls.push(url);
          return Response.json(body);
        },
      });
      assert.equal(result.status, 'wrong-service');
      assert.deepEqual(calls, ['https://remote.example/health']);
    });
  }
});

test('classifies redirects, auth failures, incompatible APIs, and future minimum versions', async (t) => {
  const probe = (response) => probeElectronHostWithDeadline({
    url: 'https://remote.example', chromiumFetch: async () => response,
  });
  await t.test('redirect', async () => {
    const result = await probe({ ok: false, status: 302, redirected: true });
    assert.equal(result.status, 'unreachable');
  });
  await t.test('auth required', async () => assert.equal((await probe(new Response('', { status: 401 }))).status, 'auth'));
  await t.test('missing capability', async () => assert.equal((await probe(Response.json({ status: 'ok', compatibility: { apiVersion: 1, capabilities: [] } }))).status, 'incompatible'));
  await t.test('newer minimum', async () => assert.equal((await probe(Response.json({ status: 'ok', compatibility: { apiVersion: 1, minClientApiVersion: 2, capabilities: ['api.runtime-url.v1'] } }))).status, 'update-recommended'));
  await t.test('wrong service body', async () => assert.equal((await probe(Response.json({ html: true }))).status, 'wrong-service'));
});

test('retry policy retries only unreachable and uses the documented deadlines', async () => {
  const timeouts = [];
  let attempts = 0;
  const result = await probeDesktopHost({
    url: 'https://remote.example', chromiumFetch: async (_url, options) => {
      timeouts.push(options.signal.aborted);
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return Response.json(compatible);
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(attempts, 3); // version then session on retry
});

test('deadline aborts a stalled response and returns unreachable', async () => {
  let signal;
  const result = await probeElectronHostWithDeadline({
    url: 'https://remote.example', timeoutMs: 10,
    chromiumFetch: async (_url, options) => {
      signal = options.signal;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  });
  assert.equal(result.status, 'unreachable');
  assert.equal(signal.aborted, true);
});

test('unready app and invalid targets fail without issuing requests', async () => {
  let calls = 0;
  const fetch = async () => { calls += 1; return Response.json(compatible); };
  assert.equal((await probeElectronHostWithDeadline({ url: 'https://remote.example', chromiumFetch: fetch, isReady: () => false })).status, 'unreachable');
  assert.equal((await probeElectronHostWithDeadline({ url: 'file:///tmp/x', chromiumFetch: fetch })).status, 'wrong-service');
  assert.equal(calls, 0);
});
