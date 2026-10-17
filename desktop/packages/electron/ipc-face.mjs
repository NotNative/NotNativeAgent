// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal desktop invoke face (doc 09 §11.1 v1 + D-09-3). Extracted from
 * main.mjs for file-cap hygiene: sender framing + the command allowlist
 * (desktop_open_external / desktop_get_boot_info / browser-control IPC /
 * relay dev-tunnel selection / tray boot-health retry). Unknown commands never
 * throw raw — every path answers { ok, error }.
 */
import { matchesDesktopLocalOrigin, matchesTrustedOrigin } from './trusted-origin.mjs';
import { createDirectoryPicker } from './directory-picker.mjs';

// Native alpha permits shell chrome, attachment reads, and status observation.
// New desktop commands remain closed until their native ownership is reviewed.
const NATIVE_ALPHA_ALLOWED_COMMANDS = new Set([
  'desktop_focus_window', 'desktop_is_window_fullscreen', 'desktop_set_window_title',
  'desktop_get_app_version', 'desktop_close_current_window', 'desktop_minimize_current_window',
  'desktop_toggle_current_window_maximized', 'desktop_get_current_window_state',
  'desktop_set_window_pinned', 'desktop_boot_config_get', 'desktop_notify', 'desktop_get_launch_at_login',
  'desktop_retry_server', 'desktop_open_external', 'desktop_get_boot_info',
  'desktop_pick_directory',
  'desktop_native_host',
  'desktop_continuity_ack',
]);

export function nativeAlphaDesktopActionUnavailable(command) {
  return !NATIVE_ALPHA_ALLOWED_COMMANDS.has(command);
}

export function senderFrameUrls(event) {
  const urls = [];
  for (const frame of event.frames ?? []) {
    if (frame && typeof frame.url === 'string') urls.push(frame.url);
  }
  const own = event.senderFrame && typeof event.senderFrame.url === 'string' ? event.senderFrame.url : '';
  if (!urls.includes(own) && own) urls.push(own);
  return urls;
}

function stringifyError(error) {
  try { return error instanceof Error ? `${error.stack ?? error.message}` : String(error); } catch { return '[unstringifiable]'; }
}

export function createInvokeFace(input, dependencies) {
  if (!dependencies?.ipcMain || !dependencies?.shell) throw new TypeError('ipcMain and shell dependencies are required');
  const browserReleases = new Map();
  const pickDirectory = createDirectoryPicker(input.dialog);

  function isDesktopMainSender(event) {
    const contents = input.mainContents();
    const frame = event.senderFrame;
    const main = contents?.mainFrame;
    return contents && event.sender === contents && frame && main
      && frame.processId === main.processId && frame.routingId === main.routingId
      && isLocalSender(event);
  }

  function isDesktopWindowMainSender(event) {
    const frame = event.senderFrame;
    const main = event.sender?.mainFrame;
    return frame && main
      && frame.processId === main.processId && frame.routingId === main.routingId
      && matchesDesktopLocalOrigin(frame.url, input.origin(), input.uiOrigin?.());
  }

  function isDesktopLocalMainSender(event) {
    const contents = input.mainContents();
    const frame = event.senderFrame;
    const main = contents?.mainFrame;
    if (!contents || event.sender !== contents || !frame || !main
      || frame.processId !== main.processId || frame.routingId !== main.routingId) return false;
    // Authorize the actual invoking main frame URL. event.frames can contain
    // trusted child frames and must not make a remote top-level page local.
    return matchesDesktopLocalOrigin(frame.url, input.origin(), input.uiOrigin?.());
  }

  function dropBrowserClient(contents) {
    const registration = browserReleases.get(contents.id);
    if (!registration) return;
    browserReleases.delete(contents.id);
    contents.removeListener('destroyed', registration.onDestroyed);
    contents.removeListener('render-process-gone', registration.onGone);
    contents.removeListener('did-start-navigation', registration.onNavigation);
    registration.release();
  }

  function browserCommand(command, payload, event) {
    if (!isDesktopMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
    const broker = input.browserControl();
    if (!broker) return { ok: false, error: 'browser-control-unavailable' };
    const id = String(event.sender.id);
    if (command === 'desktop_browser_register') {
      dropBrowserClient(event.sender);
      const release = broker.registerClient(id, true, (request) => event.sender.send('nnd:browser-request', request));
      const onDestroyed = () => dropBrowserClient(event.sender);
      const onGone = () => dropBrowserClient(event.sender);
      const onNavigation = (navigationEvent, info) => {
        const navigation = info ?? navigationEvent;
        if (navigation?.isMainFrame === true && navigation.isInPlace !== true) dropBrowserClient(event.sender);
      };
      browserReleases.set(event.sender.id, { release, onDestroyed, onGone, onNavigation });
      event.sender.on('destroyed', onDestroyed);
      event.sender.on('render-process-gone', onGone);
      event.sender.on('did-start-navigation', onNavigation);
      return { ok: true };
    }
    if (command === 'desktop_browser_unregister') {
      dropBrowserClient(event.sender);
      return { ok: true };
    }
    if (!browserReleases.has(event.sender.id)) return { ok: false, error: 'browser-client-not-registered' };
    const requestId = payload?.requestId;
    if (typeof requestId !== 'string' || !/^browser-[0-9a-f-]{36}$/u.test(requestId))
      return { ok: false, error: 'invalid-browser-request-id' };
    if (command === 'desktop_browser_claim') return { ok: true, result: { granted: broker.claim(requestId, id) } };
    if (command === 'desktop_browser_result') {
      const result = payload?.result;
      if (!result || typeof result !== 'object' || (result.ok !== true && result.ok !== false))
        return { ok: false, error: 'invalid-browser-result' };
      if (result.ok === false && (typeof result.error !== 'string' || result.error.length > 1000))
        return { ok: false, error: 'invalid-browser-result' };
      let size;
      try { size = JSON.stringify(result).length; } catch { return { ok: false, error: 'invalid-browser-result' }; }
      if (size > 2 * 1024 * 1024) return { ok: false, error: 'browser-result-too-large' };
      return { ok: true, result: { matched: broker.resolve(requestId, id, result) } };
    }
    return { ok: false, error: 'unknown-command' };
  }

  function isLocalSender(event) {
    const origin = `${input.origin()}/`;
    const appPrefix = input.appPathPrefix();
    const urls = senderFrameUrls(event);
    if (urls.length === 0) return false;
    const uiOrigin = input.uiOrigin?.();
    return urls.some((url) => {
      if (url.startsWith(origin) || url === origin.replace(/\/$/u, '')
        || url.startsWith('data:text/html') || url.startsWith(appPrefix)) return true;
      return matchesTrustedOrigin(url, uiOrigin);
    });
  }

  async function runInvokeCommand(command, payload, event) {
    if (input.nativeAlpha?.() && nativeAlphaDesktopActionUnavailable(command)) {
      return { ok: false, error: 'native-alpha-desktop-action-unavailable' };
    }
    if (command === 'desktop_focus_window' || command === 'desktop_is_window_fullscreen'
      || command === 'desktop_set_window_title' || command === 'desktop_get_app_version'
      || command === 'desktop_close_current_window' || command === 'desktop_minimize_current_window'
      || command === 'desktop_toggle_current_window_maximized' || command === 'desktop_get_current_window_state'
      || command === 'desktop_set_window_pinned') {
      // Window controls must come from the top-level renderer. isLocalSender
      // also considers ancestor frames for compatibility with other IPC, so
      // it alone would let an embedded frame control its containing window.
      if (!isDesktopWindowMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
    }
    if (command === 'desktop_focus_window') {
      const win = input.windowForSender?.(event) ?? input.mainWindow?.();
      if (!win || win.isDestroyed?.()) return { ok: true, result: false };
      input.focusApp?.();
      if (win.isMinimized?.()) win.restore();
      win.show?.();
      win.focus?.();
      return { ok: true, result: true };
    }
    if (command === 'desktop_is_window_fullscreen') {
      const win = input.windowForSender?.(event);
      return { ok: true, result: Boolean(win && !win.isDestroyed?.() && win.isFullScreen?.()) };
    }
    if (command === 'desktop_set_window_title') {
      const title = payload?.title;
      if (typeof title !== 'string' || title.trim() === '' || title.length > 200 || /[\u0000-\u001f\u007f]/u.test(title)) {
        return { ok: false, error: 'invalid-window-title' };
      }
      const win = input.windowForSender?.(event);
      if (!win || win.isDestroyed?.()) return { ok: false, error: 'desktop-window-unavailable' };
      win.setTitle(title.trim());
      return { ok: true, result: null };
    }
    if (command === 'desktop_get_app_version') {
      return { ok: true, result: String(input.appVersion?.() ?? '') };
    }
    if (command === 'desktop_close_current_window' || command === 'desktop_minimize_current_window'
      || command === 'desktop_toggle_current_window_maximized' || command === 'desktop_get_current_window_state') {
      const win = input.windowForSender?.(event);
      if (!win || win.isDestroyed?.()) return { ok: false, error: 'desktop-window-unavailable' };
      if (command === 'desktop_close_current_window') {
        win.close();
        return { ok: true, result: null };
      }
      if (command === 'desktop_minimize_current_window') {
        win.minimize();
        return { ok: true, result: null };
      }
      if (command === 'desktop_toggle_current_window_maximized') {
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
      }
      return { ok: true, result: { maximized: Boolean(win.isMaximized()), pinned: win.__nndPinned === true } };
    }
    if (command === 'desktop_set_window_pinned') {
      if (typeof payload?.pinned !== 'boolean') return { ok: false, error: 'invalid-pinned-value' };
      const win = input.windowForSender?.(event);
      if (!win || win.isDestroyed?.()) return { ok: false, error: 'desktop-window-unavailable' };
      if (win.__nndMiniChat !== true) return { ok: false, error: 'pinning-is-only-available-for-mini-chat' };
      win.setAlwaysOnTop(payload.pinned, 'floating');
      if (input.platform?.() === 'darwin') win.setVisibleOnAllWorkspaces(payload.pinned);
      win.__nndPinned = payload.pinned;
      return { ok: true, result: { pinned: payload.pinned } };
    }
    if (command === 'desktop_read_file' || command === 'desktop_save_markdown_file') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      const files = input.fileUtilities?.();
      if (!files) return { ok: false, error: 'file-utilities-unavailable' };
      if (command === 'desktop_read_file') {
        return { ok: true, result: await files.readFile(payload?.path) };
      }
      return { ok: true, result: await files.saveMarkdown(payload?.defaultFileName, payload?.content) };
    }
    if (command === 'desktop_open_path' || command === 'desktop_reveal_path') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      const paths = input.localPathUtilities?.();
      if (!paths) return { ok: false, error: 'local-path-utilities-unavailable' };
      if (command === 'desktop_open_path') return { ok: true, result: await paths.open(payload?.path, payload?.app) };
      return { ok: true, result: await paths.reveal(payload?.path) };
    }
    if (command === 'desktop_hosts_get') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      const hostConfig = input.hostConfig?.get?.();
      if (!hostConfig) return { ok: false, error: 'desktop-hosts-unavailable' };
      const sshIds = new Set((input.sshInstances?.get?.() ?? []).map((instance) => instance.id));
      for (const host of hostConfig.hosts) if (host.transport === 'ssh') sshIds.add(host.id);
      return { ok: true, result: {
        ...hostConfig,
        hosts: hostConfig.hosts.filter((host) => host.transport !== 'ssh' && !sshIds.has(host.id)),
        defaultHostId: hostConfig.hosts.some((host) => host.id === hostConfig.defaultHostId && host.transport === 'ssh')
          || sshIds.has(hostConfig.defaultHostId) ? 'local' : hostConfig.defaultHostId,
        localOrigin: input.localOrigin(),
      } };
    }
    if (command === 'desktop_host_probe') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (typeof payload?.hostId !== 'string' || !input.hostProbe) return { ok: false, error: 'desktop-host-probe-unavailable' };
      const host = input.hostConfig?.get?.()?.hosts?.find((entry) => entry.id === payload.hostId);
      if (!host) return { ok: false, error: 'desktop-host-not-found' };
      let url = typeof host?.apiUrl === 'string' ? host.apiUrl : typeof host?.url === 'string' ? host.url : '';
      if (host.transport === 'ssh') {
        const status = input.sshTransport?.getStatus?.(host.id);
        if (status?.phase !== 'ready' || typeof status.localUrl !== 'string') {
          return { ok: false, error: 'desktop-ssh-not-connected' };
        }
        url = status.localUrl;
      }
      if (!url || url.startsWith('relay://')) return { ok: false, error: 'desktop-host-not-direct' };
      return { ok: true, result: await input.hostProbe({
        url, clientToken: host.clientToken, requestHeaders: host.requestHeaders, expectedServerId: host.serverId,
      }) };
    }
    if (command === 'desktop_ssh_instances_get') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.sshInstances?.get) return { ok: false, error: 'desktop-ssh-unavailable' };
      return { ok: true, result: { instances: input.sshInstances.get() } };
    }
    if (command === 'desktop_ssh_instances_set') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.sshInstances?.set || !payload?.config || !Array.isArray(payload.config.instances)) {
        return { ok: false, error: 'desktop-ssh-unavailable' };
      }
      const result = input.sshInstances.set(payload.config.instances);
      if (result?.ok === false && typeof result.error === 'string') return result;
      return { ok: true, result };
    }
    if (command === 'desktopSshConfig') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.sshInstances?.get) return { ok: false, error: 'desktop-ssh-unavailable' };
      return { ok: true, result: { instances: input.sshInstances.get() } };
    }
    if (command === 'desktopSshReadConfig') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.sshInstances?.readSshConfig) return { ok: false, error: 'desktop-ssh-unavailable' };
      try { return { ok: true, result: await input.sshInstances.readSshConfig() }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'desktop-ssh-config-read-failed' }; }
    }
    if (command === 'desktopSshUpsertInstance') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.sshInstances?.upsert || !payload?.instance || typeof payload.instance !== 'object') {
        return { ok: false, error: 'desktop-ssh-unavailable' };
      }
      const saved = await input.sshInstances.upsert(payload.instance);
      // Validate and persist before disrupting a live tunnel. A malformed edit
      // must not disconnect an instance whose saved configuration is intact.
      if (saved?.ok === false) return saved;
      if (input.sshTransport && typeof payload.instance.id === 'string') {
        const disconnected = input.sshTransport.disconnect(payload.instance.id);
        if (disconnected?.ok === false) return disconnected;
      }
      return saved;
    }
    if (command === 'desktopSshCreateFromCommand') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.sshInstances?.createFromCommand || typeof payload?.sshCommand !== 'string') {
        return { ok: false, error: 'desktop-ssh-unavailable' };
      }
      return input.sshInstances.createFromCommand(payload.sshCommand, payload.nickname);
    }
    if (command === 'desktopSshRemoveInstance') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.sshInstances?.remove || typeof payload?.id !== 'string') {
        return { ok: false, error: 'desktop-ssh-unavailable' };
      }
      if (input.sshTransport) {
        const disconnected = input.sshTransport.disconnect(payload.id);
        if (disconnected?.ok === false) return disconnected;
      }
      const removed = input.sshInstances.remove(payload.id);
      if (removed?.ok !== false) input.sshTransport?.forgetStatus?.(payload.id);
      return removed;
    }
    if (command === 'desktopSshConnect' || command === 'desktopSshDisconnect'
      || command === 'desktopSshCancelConnecting' || command === 'desktopSshRetry'
      || command === 'desktopSshRefreshStatuses') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      const transport = input.sshTransport;
      if (!transport) return { ok: false, error: 'desktop-ssh-transport-unavailable' };
      if (command === 'desktopSshRefreshStatuses') return { ok: true, result: transport.getStatuses() };
      if (typeof payload?.id !== 'string' || payload.id.length === 0 || payload.id.length > 128) {
        return { ok: false, error: 'desktop-ssh-instance-id-invalid' };
      }
      if (command === 'desktopSshConnect') return await transport.connect(payload.id);
      if (command === 'desktopSshRetry') return await transport.connect(payload.id, { retryAttempt: 1 });
      if (command === 'desktopSshDisconnect') return transport.disconnect(payload.id);
      return transport.cancel(payload.id);
    }
    if (command === 'desktop_pairing_redeem_relay_complete') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      const bridge = input.relayPairingBridge;
      if (!bridge) return { ok: false, error: 'relay-pairing-unavailable' };
      return bridge.complete(payload?.requestId, payload?.result);
    }
    if (command === 'desktop_boot_config_get') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      const bootConfig = input.bootConfig?.(event);
      if (!bootConfig) return { ok: false, error: 'desktop-boot-config-unavailable' };
      return { ok: true, result: bootConfig };
    }
    if (command === 'desktop_host_switch') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (typeof payload?.hostId !== 'string' || !input.hostSwitch) return { ok: false, error: 'desktop-host-switch-unavailable' };
      return input.hostSwitch(payload.hostId);
    }
    if (command === 'desktop_open_mini_chat') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.miniChat?.open) return { ok: false, error: 'desktop-mini-chat-unavailable' };
      return input.miniChat.open(payload);
    }
    if (command === 'desktop_remote_password_login') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.remotePasswordLogin) return { ok: false, error: 'desktop-password-login-unavailable' };
      return { ok: true, result: await input.remotePasswordLogin(payload) };
    }
    if (command === 'desktop_host_set_relay_default') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (typeof payload?.hostId !== 'string' || !input.relayHostSelect) return { ok: false, error: 'desktop-host-switch-unavailable' };
      return input.relayHostSelect(payload.hostId, payload.expectedHost, payload.restoringDefault === true);
    }
    if (command === 'desktop_hosts_set') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.hostConfig?.set || !payload?.input) return { ok: false, error: 'desktop-hosts-unavailable' };
      const result = input.hostConfig.set(payload.input);
      if (result?.ok === false && typeof result.error === 'string') return result;
      return { ok: true, result: result?.ok === true && Object.hasOwn(result, 'result') ? result.result : result };
    }
    if (command === 'desktop_local_client_token_get') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.identity?.getLocalClientToken) return { ok: false, error: 'desktop-identity-unavailable' };
      return { ok: true, result: input.identity.getLocalClientToken() };
    }
    if (command === 'desktop_install_id_get') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.identity?.getInstallId) return { ok: false, error: 'desktop-identity-unavailable' };
      return { ok: true, result: input.identity.getInstallId() };
    }
    if (command === 'desktop_notify') {
      if (!isDesktopMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      const result = input.nativeNotifications?.notify(payload);
      return result ? { ok: true, result } : { ok: false, error: 'native-notifications-unavailable' };
    }
    if (command === 'desktop_get_launch_at_login') {
      if (!isDesktopMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      return { ok: true, result: input.loginItem?.get?.() ?? { supported: false, enabled: false } };
    }
    if (command === 'desktop_native_host') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.nativeHost) return { ok: false, error: 'native-host-unavailable' };
      if (!payload || Object.keys(payload).some(key => !['action', 'value'].includes(key))
        || !['read', 'preferences', 'login', 'browser', 'restart'].includes(payload.action)) return { ok: false, error: 'native-host-input-invalid' };
      if (['read', 'browser', 'restart'].includes(payload.action) && payload.value != null) return { ok: false, error: 'native-host-input-invalid' };
      try { return { ok: true, result: await input.nativeHost(payload.action, payload.value) }; }
      catch (error) { return { ok: false, error: /^[a-z][a-z0-9-]{1,80}$/u.test(error.message) ? error.message : 'native-host-operation-failed' }; }
    }
    if (command === 'desktop_continuity_ack') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (payload != null) return { ok: false, error: 'native-host-input-invalid' };
      input.continuityApplied?.(event);
      return { ok: true, result: null };
    }
    if (command === 'desktop_set_launch_at_login') {
      if (!isDesktopMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (typeof payload?.enabled !== 'boolean') return { ok: false, error: 'invalid-enabled-value' };
      return { ok: true, result: input.loginItem?.set?.(payload.enabled) ?? { supported: false, enabled: false } };
    }
    if (command === 'desktop_updater_check') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.updater?.check) return { ok: false, error: 'desktop-updater-unavailable' };
      return { ok: true, result: await input.updater.check() };
    }
    if (command === 'desktop_updater_download') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.updater?.download) return { ok: false, error: 'desktop-updater-unavailable' };
      return { ok: true, result: await input.updater.download() };
    }
    if (command === 'desktop_updater_install') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.updater?.install) return { ok: false, error: 'desktop-updater-unavailable' };
      return { ok: true, result: await input.updater.install() };
    }
    if (command === 'desktop_retry_server') {
      if (!isDesktopMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.retryServer) return { ok: false, error: 'server-unavailable' };
      return input.retryServer();
    }
    if (command.startsWith('desktop_browser_')) return browserCommand(command, payload, event);
    if (command === 'desktop_dev_tunnel_open') {
      if (payload?.relay !== true) return { ok: false, error: 'direct-dev-tunnel-unavailable' };
      const bridge = input.relayDevTunnel?.();
      if (!bridge) return { ok: false, error: 'relay-dev-tunnel-unavailable' };
      try {
        const result = await bridge.open({
          targetKey: payload.targetKey,
          remotePort: payload.remotePort,
          webContents: event.sender,
        });
        return { ok: true, result };
      } catch (error) { return { ok: false, error: stringifyError(error) }; }
    }
    if (command === 'desktop_dev_tunnel_close') {
      if (payload?.relay !== true) return { ok: false, error: 'direct-dev-tunnel-unavailable' };
      const bridge = input.relayDevTunnel?.();
      if (!bridge) return { ok: false, error: 'relay-dev-tunnel-unavailable' };
      try { return { ok: true, result: bridge.close({ targetKey: payload.targetKey, remotePort: payload.remotePort, webContents: event.sender }) }; }
      catch (error) { return { ok: false, error: stringifyError(error) }; }
    }
    if (command === 'desktop_relay_dev_tunnel_close_all') {
      const bridge = input.relayDevTunnel?.();
      if (!bridge) return { ok: false, error: 'relay-dev-tunnel-unavailable' };
      bridge.closeAll();
      return { ok: true, result: { closed: true } };
    }
    if (command === 'desktop_open_external') {
      const target = payload && typeof payload.url === 'string' ? payload.url : '';
      try {
        const parsed = new URL(target);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'url-must-be-http-or-https' };
        dependencies.shell.openExternal(parsed.href).catch(() => { /* browser open is best-effort */ });
        return { ok: true };
      } catch { return { ok: false, error: 'invalid-url' }; }
    }
    if (command === 'desktop_get_boot_info') {
      return { ok: true, result: input.bootInfo() };
    }
    // Workspace model (b): native open-directory chooser for adding a
    // workspace. Only the desktop main frame may open this app-modal dialog.
    if (command === 'desktop_pick_directory') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (!input.dialog) return { ok: false, error: 'dialog-unavailable' };
      return pickDirectory(input.windowForSender?.(event) ?? undefined, event.sender);
    }
    return { ok: false, error: 'unknown-command' }; // never throws raw (§11.1)
  }

  return {
    /** Wire the ipcMain listener exactly once. */
    register() {
      dependencies.ipcMain.on('nnd:desktop-invoke', async (event, envelope) => {
        const seq = envelope && typeof envelope.seq === 'number' ? envelope.seq : -1;
        const reply = (result) => {
          try { event.sender.send('nnd:desktop-reply', { seq, ...result }); } catch { /* frame gone */ }
        };
        let result;
        try {
          if (!isLocalSender(event)) {
            console.warn(`[shell] invoke rejected for sender: ${JSON.stringify(senderFrameUrls(event))}`);
            result = { ok: false, error: 'sender-not-allowed' };
          } else {
            result = await runInvokeCommand(String(envelope?.command ?? ''), envelope?.payload, event);
          }
        } catch (error) {
          result = { ok: false, error: stringifyError(error) };
        }
        reply(result);
      });
    },
  };
}
