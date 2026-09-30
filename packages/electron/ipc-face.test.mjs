// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createInvokeFace } from './ipc-face.mjs';
import { matchesDesktopLocalOrigin, matchesTrustedOrigin } from './trusted-origin.mjs';

test('matches trusted custom and network origins without accepting lookalikes', () => {
  assert.equal(matchesTrustedOrigin('notnative-ui://app/index.html', 'notnative-ui://app'), true);
  assert.equal(matchesTrustedOrigin('notnative-ui://app.evil/index.html', 'notnative-ui://app'), false);
  assert.equal(matchesTrustedOrigin('notnative-ui://user@app/index.html', 'notnative-ui://app'), false);
  assert.equal(matchesTrustedOrigin('http://127.0.0.1:43123/chat', 'http://127.0.0.1:43123'), true);
  assert.equal(matchesTrustedOrigin('http://127.0.0.1:43124/chat', 'http://127.0.0.1:43123'), false);
});

test('desktop-local origin excludes network UI origins and requires the invoking frame itself', () => {
  const localOrigin = 'http://127.0.0.1:43123';
  const remoteUiOrigin = 'https://remote.example';
  const packagedUiOrigin = 'notnative-ui://app';
  assert.equal(matchesDesktopLocalOrigin('https://remote.example/index.html', localOrigin, remoteUiOrigin), false);
  assert.equal(matchesDesktopLocalOrigin('http://127.0.0.1:43123/index.html', localOrigin, remoteUiOrigin), true);
  assert.equal(matchesDesktopLocalOrigin('notnative-ui://app/index.html', localOrigin, packagedUiOrigin), true);
  // A remote top-level caller stays remote even if event.frames also contains
  // a trusted local iframe; the IPC policy must pass senderFrame.url, not the
  // full frame list, to this origin matcher.
  assert.equal(matchesDesktopLocalOrigin('https://remote.example/index.html', localOrigin, packagedUiOrigin), false);
});

function registeredInvoke(input) {
  let handler;
  const face = createInvokeFace({
    origin: () => 'http://127.0.0.1:57123',
    uiOrigin: () => 'notnative-ui://app',
    appPathPrefix: () => 'file:///desktop',
    localOrigin: () => 'http://127.0.0.1:57123',
    bootInfo: () => ({}),
    mainContents: () => input.contents,
    ...input,
  }, { ipcMain: { on: (_channel, callback) => { handler = callback; } }, shell: { openExternal: async () => {} } });
  face.register();
  return async (event, command, payload) => {
    let reply;
    event.sender.send = (_channel, value) => { reply = value; };
    await handler(event, { seq: 7, command, payload });
    return reply;
  };
}

function ipcEvent(contents, url, frames = [{ url }]) {
  return {
    sender: contents,
    senderFrame: { processId: 1, routingId: 1, url },
    frames,
    senderFrameId: 1,
  };
}

test('host config IPC reads and writes only from the desktop local main frame', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  let stored = { hosts: [], defaultHostId: null, initialHostChoiceCompleted: false };
  const invoke = registeredInvoke({ contents, hostConfig: {
    get: () => stored,
    set: (value) => { stored = value; return value; },
  } });
  const local = await invoke(ipcEvent(contents, 'notnative-ui://app/index.html'), 'desktop_hosts_get');
  assert.equal(local.ok, true);
  assert.equal(local.result.localOrigin, 'http://127.0.0.1:57123');
  const write = await invoke(ipcEvent(contents, 'http://127.0.0.1:57123/'), 'desktop_hosts_set', {
    input: { hosts: [], defaultHostId: 'local', initialHostChoiceCompleted: true },
  });
  assert.equal(write.ok, true);
  assert.equal(stored.defaultHostId, 'local');
  const remote = await invoke(ipcEvent(contents, 'https://remote.example/'), 'desktop_hosts_get');
  assert.equal(remote.ok, false);
  assert.equal(remote.error, 'sender-not-allowed');
});

test('boot runtime configuration is returned only to the desktop local main frame', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const bootConfig = { apiBaseUrl: 'https://remote.example', clientToken: 'active-token', runtimeKey: 'host:remote' };
  const invoke = registeredInvoke({ contents, bootConfig: () => bootConfig });
  assert.deepEqual((await invoke(ipcEvent(contents, 'notnative-ui://app/index.html'), 'desktop_boot_config_get')).result, bootConfig);
  const remote = await invoke(ipcEvent(contents, 'https://remote.example/'), 'desktop_boot_config_get');
  assert.equal(remote.ok, false);
  assert.equal(remote.error, 'sender-not-allowed');
});

test('host switching delegates only validated local-main-frame IPC requests', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const selections = [];
  const invoke = registeredInvoke({ contents, hostSwitch: async (hostId) => {
    selections.push(hostId);
    return { ok: true, result: { activeHostId: hostId } };
  } });
  const local = await invoke(ipcEvent(contents, 'notnative-ui://app/index.html'), 'desktop_host_switch', { hostId: 'host-1' });
  assert.deepEqual(local, { seq: 7, ok: true, result: { activeHostId: 'host-1' } });
  const remote = await invoke(ipcEvent(contents, 'https://remote.example/'), 'desktop_host_switch', { hostId: 'host-2' });
  assert.equal(remote.ok, false);
  assert.equal(remote.error, 'sender-not-allowed');
  const malformed = await invoke(ipcEvent(contents, 'http://127.0.0.1:57123/'), 'desktop_host_switch', {});
  assert.deepEqual({ ok: malformed.ok, error: malformed.error }, { ok: false, error: 'desktop-host-switch-unavailable' });
  assert.deepEqual(selections, ['host-1']);
});

test('host config IPC returns the explicit busy response while pairing reserves the catalog', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const invoke = registeredInvoke({ contents, hostConfig: {
    get: () => ({ hosts: [] }),
    set: () => ({ ok: false, error: 'desktop-hosts-busy' }),
  } });
  const reply = await invoke(ipcEvent(contents, 'http://127.0.0.1:57123/'), 'desktop_hosts_set', { input: { hosts: [] } });
  assert.deepEqual({ ok: reply.ok, error: reply.error }, { ok: false, error: 'desktop-hosts-busy' });
});

test('a remote top-level frame cannot borrow a trusted local child frame for host access', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const invoke = registeredInvoke({ contents, hostConfig: { get: () => ({ hosts: [] }) } });
  const reply = await invoke(ipcEvent(contents, 'https://remote.example/', [
    { url: 'https://remote.example/' }, { url: 'notnative-ui://app/iframe' },
  ]), 'desktop_hosts_get');
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'desktop-main-frame-required');
});

test('local identity commands expose the saved token and install id only to the local main frame', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const invoke = registeredInvoke({ contents, identity: {
    getLocalClientToken: () => 'local-secret',
    getInstallId: () => 'install-id',
  } });
  assert.equal((await invoke(ipcEvent(contents, 'notnative-ui://app/index.html'), 'desktop_local_client_token_get')).result, 'local-secret');
  assert.equal((await invoke(ipcEvent(contents, 'http://127.0.0.1:57123/'), 'desktop_install_id_get')).result, 'install-id');
  const remote = await invoke(ipcEvent(contents, 'https://remote.example/'), 'desktop_local_client_token_get');
  assert.equal(remote.ok, false);
  assert.equal(remote.error, 'sender-not-allowed');
});
