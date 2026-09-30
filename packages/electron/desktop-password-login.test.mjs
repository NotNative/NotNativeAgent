// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDesktopPasswordLogin } from './desktop-password-login.mjs';

function dependencies(overrides = {}) {
  let config = {
    hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', apiUrl: 'https://remote.example', requestHeaders: { 'x-instance': 'one', accept: 'text/plain', 'content-type': 'text/plain' } }],
    defaultHostId: 'remote-1', initialHostChoiceCompleted: true,
  };
  const writes = [];
  const calls = [];
  const login = createDesktopPasswordLogin({
    getHosts: () => config,
    writeHosts: (value) => { config = value; writes.push(value); },
    getLocalOrigin: () => 'http://127.0.0.1:57123',
    getInstallId: () => 'install-1',
    getAppVersion: () => '20260930-65',
    getPlatform: () => 'win32',
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ authenticated: true, clientToken: 'token-1' }), { status: 200 }); },
    ...overrides,
  });
  return { login, calls, writes, getConfig: () => config };
}

test('remote password login resolves a saved host and persists its issued device token', async () => {
  const state = dependencies();
  const result = await state.login({ runtimeKey: 'host:remote-1', password: 'secret', trustDevice: true });
  assert.deepEqual(result, { ok: true, status: 200, locked: false, tunnelLocked: false, retryAfterSeconds: null, clientToken: 'token-1' });
  assert.equal(state.calls[0].url, 'https://remote.example/auth/session');
  assert.deepEqual(JSON.parse(state.calls[0].init.body), {
    password: 'secret', trustDevice: true, issueClientToken: true,
    clientLabel: 'NotNativeDesktop', clientKind: 'desktop', dedupeKey: 'desktop:install-1',
    devicePlatform: 'win32', appVersion: '20260930-65',
  });
  assert.equal(state.calls[0].init.headers['x-instance'], 'one');
  assert.equal(state.calls[0].init.headers.accept, 'application/json');
  assert.equal(state.calls[0].init.headers['content-type'], 'application/json');
  assert.equal(state.getConfig().hosts[0].clientToken, 'token-1');
});

test('local password login persists only the local client token', async () => {
  const state = dependencies();
  await state.login({ runtimeKey: 'local', password: 'secret', trustDevice: false });
  assert.equal(state.calls[0].url, 'http://127.0.0.1:57123/auth/session');
  assert.equal(JSON.parse(state.calls[0].init.body).clientKind, 'desktop-local');
  assert.equal(JSON.parse(state.calls[0].init.body).dedupeKey, 'desktop-local');
  assert.equal(state.getConfig().localClientToken, 'token-1');
  assert.equal(state.getConfig().hosts[0].clientToken, undefined);
});

test('renderer cannot supply an arbitrary login URL or target a relay-only saved host', async () => {
  const state = dependencies();
  assert.equal((await state.login({ runtimeKey: 'url:https://attacker.example', password: 'secret', trustDevice: false })).status, 400);
  assert.equal(state.calls.length, 0);
  assert.equal((await state.login({ runtimeKey: 'host:missing', password: 'secret', trustDevice: false })).status, 404);
  assert.equal(state.calls.length, 0);
});

test('login does not send credentials while another operation owns the host catalog', async () => {
  const state = dependencies({ isCatalogBusy: () => true });
  assert.equal((await state.login({ runtimeKey: 'host:remote-1', password: 'secret', trustDevice: true })).status, 409);
  assert.equal(state.calls.length, 0);
  assert.equal(state.writes.length, 0);
});

test('login does not write a token if a catalog operation starts while the request is in flight', async () => {
  let busy = false;
  const state = dependencies({
    isCatalogBusy: () => busy,
    fetchImpl: async () => {
      busy = true;
      return new Response(JSON.stringify({ authenticated: true, clientToken: 'token-1' }), { status: 200 });
    },
  });
  const result = await state.login({ runtimeKey: 'host:remote-1', password: 'secret', trustDevice: true });
  assert.equal(result.status, 409);
  assert.equal(result.error, 'host-catalog-busy');
  assert.equal(state.writes.length, 0);
  assert.equal(state.getConfig().hosts[0].clientToken, undefined);
});

test('login does not persist a token if the saved endpoint changes during the network request', async () => {
  let current = {
    hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', apiUrl: 'https://remote.example' }],
    defaultHostId: 'remote-1', initialHostChoiceCompleted: true,
  };
  const login = createDesktopPasswordLogin({
    getHosts: () => current,
    writeHosts: (value) => { current = value; },
    getLocalOrigin: () => 'http://127.0.0.1:57123', getInstallId: () => 'install-1',
    getAppVersion: () => '20260930-65', getPlatform: () => 'win32',
    fetchImpl: async () => {
      current = { ...current, hosts: [{ ...current.hosts[0], apiUrl: 'https://changed.example' }] };
      return new Response(JSON.stringify({ authenticated: true, clientToken: 'token-1' }), { status: 200 });
    },
  });
  assert.equal((await login({ runtimeKey: 'host:remote-1', password: 'secret', trustDevice: true })).status, 409);
  assert.equal(current.hosts[0].clientToken, undefined);
});

test('client token fallback uses the session cookie and posts device identity', async () => {
  const calls = [];
  const state = dependencies({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) return new Response('{"authenticated":true}', { status: 200, headers: { 'set-cookie': 'session=abc; Path=/; HttpOnly' } });
      return new Response(JSON.stringify({ token: 'fallback-token' }), { status: 201 });
    },
  });
  const result = await state.login({ runtimeKey: 'host:remote-1', password: 'secret', trustDevice: true });
  assert.equal(result.clientToken, 'fallback-token');
  assert.equal(calls[1].init.headers.cookie, 'session=abc');
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    label: 'NotNativeDesktop',
    clientLabel: 'NotNativeDesktop', clientKind: 'desktop', dedupeKey: 'desktop:install-1',
    devicePlatform: 'win32', appVersion: '20260930-65',
  });
});

test('does not accept a token from a 200 response that did not authenticate', async () => {
  const state = dependencies({
    fetchImpl: async () => new Response(JSON.stringify({ authenticated: false, clientToken: 'attacker-token' }), { status: 200 }),
  });
  const result = await state.login({ runtimeKey: 'host:remote-1', password: 'secret', trustDevice: true });
  assert.equal(result.status, 502);
  assert.equal(result.ok, false);
  assert.equal(state.getConfig().hosts[0].clientToken, undefined);
});

test('rejects token whitespace that would differ after native config sanitization', async () => {
  const state = dependencies({
    fetchImpl: async () => new Response(JSON.stringify({ authenticated: true, clientToken: ' token-1 ' }), { status: 200 }),
  });
  const result = await state.login({ runtimeKey: 'host:remote-1', password: 'secret', trustDevice: true });
  assert.equal(result.status, 502);
  assert.equal(result.ok, false);
  assert.equal(state.getConfig().hosts[0].clientToken, undefined);
});
