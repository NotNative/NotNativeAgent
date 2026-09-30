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

test('window IPC controls the calling BrowserWindow and validates mutable titles', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const calls = [];
  const win = {
    isDestroyed: () => false, isMinimized: () => true, isFullScreen: () => true,
    isMaximized: () => false, restore: () => calls.push('restore'), show: () => calls.push('show'),
    focus: () => calls.push('focus'), close: () => calls.push('close'), minimize: () => calls.push('minimize'),
    maximize: () => { calls.push('maximize'); win.isMaximized = () => true; },
    unmaximize: () => { calls.push('unmaximize'); win.isMaximized = () => false; },
    setTitle: (title) => calls.push(['title', title]),
  };
  let focusedApp = 0;
  const invoke = registeredInvoke({ contents, windowForSender: (event) => {
    assert.equal(event.sender, contents);
    return win;
  }, focusApp: () => { focusedApp += 1; }, appVersion: () => '20260930.0.54' });
  const local = (command, payload) => invoke(ipcEvent(contents, 'notnative-ui://app/index.html'), command, payload);
  assert.equal((await local('desktop_focus_window')).result, true);
  assert.equal(focusedApp, 1);
  assert.deepEqual(calls.splice(0), ['restore', 'show', 'focus']);
  assert.equal((await local('desktop_is_window_fullscreen')).result, true);
  assert.deepEqual(await local('desktop_set_window_title', { title: '  Remote Studio  ' }), {
    seq: 7, ok: true, result: null,
  });
  assert.deepEqual(calls.splice(0), [['title', 'Remote Studio']]);
  for (const title of ['', '   ', 'bad\ntitle', 'x'.repeat(201)]) {
    const result = await local('desktop_set_window_title', { title });
    assert.equal(result.error, 'invalid-window-title');
  }
  assert.equal((await local('desktop_get_app_version')).result, '20260930.0.54');
  assert.equal((await local('desktop_minimize_current_window')).ok, true);
  assert.deepEqual(calls.splice(0), ['minimize']);
  assert.deepEqual(await local('desktop_toggle_current_window_maximized'), { seq: 7, ok: true, result: { maximized: true } });
  assert.deepEqual(calls.splice(0), ['maximize']);
  assert.deepEqual(await local('desktop_toggle_current_window_maximized'), { seq: 7, ok: true, result: { maximized: false } });
  assert.deepEqual(calls.splice(0), ['unmaximize']);
  assert.deepEqual(await local('desktop_get_current_window_state'), { seq: 7, ok: true, result: { maximized: false } });
  assert.equal((await local('desktop_close_current_window')).ok, true);
  assert.deepEqual(calls.splice(0), ['close']);
});

test('window controls reject embedded frames even when their parent is trusted', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  let windowActions = 0;
  const win = {
    isDestroyed: () => false, isMinimized: () => false, isMaximized: () => false,
    show: () => { windowActions += 1; }, focus: () => { windowActions += 1; },
    close: () => { windowActions += 1; }, setTitle: () => { windowActions += 1; },
  };
  const invoke = registeredInvoke({ contents, windowForSender: () => win, appVersion: () => '1.0' });
  const embedded = {
    ...ipcEvent(contents, 'https://untrusted-frame.example/', [
      { url: 'notnative-ui://app/index.html' },
      { url: 'https://untrusted-frame.example/' },
    ]),
    senderFrame: { processId: 1, routingId: 2, url: 'https://untrusted-frame.example/' },
  };
  for (const command of [
    'desktop_focus_window', 'desktop_is_window_fullscreen', 'desktop_set_window_title',
    'desktop_get_app_version', 'desktop_close_current_window', 'desktop_minimize_current_window',
    'desktop_toggle_current_window_maximized', 'desktop_get_current_window_state',
  ]) {
    const result = await invoke(embedded, command, { title: 'Compromised frame' });
    assert.equal(result.ok, false, command);
    assert.equal(result.error, 'desktop-main-frame-required', command);
  }
  assert.equal(windowActions, 0);
});

test('window controls work in another trusted local BrowserWindow', async () => {
  const mainContents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const secondaryContents = { mainFrame: { processId: 2, routingId: 9 }, send() {} };
  let minimized = 0;
  const secondaryWindow = { isDestroyed: () => false, minimize: () => { minimized += 1; } };
  const invoke = registeredInvoke({ contents: mainContents, windowForSender: (event) => {
    assert.equal(event.sender, secondaryContents);
    return secondaryWindow;
  } });
  const result = await invoke({
    ...ipcEvent(secondaryContents, 'notnative-ui://app/mini-chat.html'),
    senderFrame: { processId: 2, routingId: 9, url: 'notnative-ui://app/mini-chat.html' },
  }, 'desktop_minimize_current_window');
  assert.equal(result.ok, true);
  assert.equal(minimized, 1);
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

test('host probe uses only saved host credentials and cannot target an arbitrary URL', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const calls = [];
  const host = {
    id: 'saved-studio', url: 'https://studio.example/ui', apiUrl: 'https://studio.example/api',
    clientToken: 'stored-token', requestHeaders: { 'x-tenant': 'studio' }, serverId: 'server-1',
  };
  const invoke = registeredInvoke({ contents,
    hostConfig: { get: () => ({ hosts: [host] }) },
    hostProbe: async (options) => { calls.push(options); return { status: 'ok', latencyMs: 12 }; },
  });
  const local = await invoke(ipcEvent(contents, 'notnative-ui://app/index.html'), 'desktop_host_probe', { hostId: 'saved-studio' });
  assert.deepEqual(local, { seq: 7, ok: true, result: { status: 'ok', latencyMs: 12 } });
  assert.deepEqual(calls, [{ url: host.apiUrl, clientToken: 'stored-token', requestHeaders: { 'x-tenant': 'studio' }, expectedServerId: 'server-1' }]);
  const missing = await invoke(ipcEvent(contents, 'notnative-ui://app/index.html'), 'desktop_host_probe', { hostId: 'attacker-url' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'desktop-host-not-found');
  const remote = await invoke(ipcEvent(contents, 'https://remote.example/'), 'desktop_host_probe', { hostId: 'saved-studio' });
  assert.equal(remote.ok, false);
  assert.equal(calls.length, 1);
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

test('relay default selection is available only to the desktop local main frame', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const selected = [];
  const expectedHost = { relayUrl: 'wss://relay.example/ws', serverId: 'server-1' };
  const invoke = registeredInvoke({ contents, relayHostSelect: async (hostId, expected, restoringDefault) => {
    selected.push([hostId, expected, restoringDefault]);
    return { ok: true, result: { activeHostId: hostId } };
  } });
  const local = await invoke(ipcEvent(contents, 'notnative-ui://app/index.html'), 'desktop_host_set_relay_default', { hostId: 'relay-1', expectedHost });
  assert.equal(local.ok, true);
  assert.deepEqual(selected, [['relay-1', expectedHost, false]]);
  const remote = await invoke(ipcEvent(contents, 'https://remote.example/'), 'desktop_host_set_relay_default', { hostId: 'relay-2' });
  assert.equal(remote.ok, false);
  assert.equal(remote.error, 'sender-not-allowed');
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

test('relay pairing completion accepts responses only from the desktop local main frame', async () => {
  const contents = { mainFrame: { processId: 1, routingId: 1 }, send() {} };
  const calls = [];
  const invoke = registeredInvoke({ contents, relayPairingBridge: {
    complete: (requestId, result) => { calls.push({ requestId, result }); return { ok: true, result: { accepted: true } }; },
  } });
  const local = await invoke(ipcEvent(contents, 'notnative-ui://app/index.html'), 'desktop_pairing_redeem_relay_complete', {
    requestId: 'request-1', result: { ok: true, clientToken: 'token' },
  });
  assert.deepEqual(local, { seq: 7, ok: true, result: { accepted: true } });
  const remote = await invoke(ipcEvent(contents, 'https://remote.example/'), 'desktop_pairing_redeem_relay_complete', {
    requestId: 'request-2', result: { ok: true, clientToken: 'stolen-token' },
  });
  assert.equal(remote.ok, false);
  assert.equal(remote.error, 'sender-not-allowed');
  assert.deepEqual(calls, [{ requestId: 'request-1', result: { ok: true, clientToken: 'token' } }]);
});
