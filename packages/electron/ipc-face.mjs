// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal desktop invoke face (doc 09 §11.1 v1 + D-09-3). Extracted from
 * main.mjs for file-cap hygiene: sender framing + the command allowlist
 * (desktop_open_external / desktop_get_boot_info / browser-control IPC /
 * relay dev-tunnel selection / tray boot-health retry). Unknown commands never
 * throw raw — every path answers { ok, error }.
 */
import { matchesDesktopLocalOrigin, matchesTrustedOrigin } from './trusted-origin.mjs';

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

  function isDesktopMainSender(event) {
    const contents = input.mainContents();
    const frame = event.senderFrame;
    const main = contents?.mainFrame;
    return contents && event.sender === contents && frame && main
      && frame.processId === main.processId && frame.routingId === main.routingId
      && isLocalSender(event);
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
      return { ok: true, result: { ...hostConfig, localOrigin: input.localOrigin() } };
    }
    if (command === 'desktop_pairing_redeem_relay_complete') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      const bridge = input.relayPairingBridge;
      if (!bridge) return { ok: false, error: 'relay-pairing-unavailable' };
      return bridge.complete(payload?.requestId, payload?.result);
    }
    if (command === 'desktop_boot_config_get') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      const bootConfig = input.bootConfig?.();
      if (!bootConfig) return { ok: false, error: 'desktop-boot-config-unavailable' };
      return { ok: true, result: bootConfig };
    }
    if (command === 'desktop_host_switch') {
      if (!isDesktopLocalMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (typeof payload?.hostId !== 'string' || !input.hostSwitch) return { ok: false, error: 'desktop-host-switch-unavailable' };
      return input.hostSwitch(payload.hostId);
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
    if (command === 'desktop_set_launch_at_login') {
      if (!isDesktopMainSender(event)) return { ok: false, error: 'desktop-main-frame-required' };
      if (typeof payload?.enabled !== 'boolean') return { ok: false, error: 'invalid-enabled-value' };
      return { ok: true, result: input.loginItem?.set?.(payload.enabled) ?? { supported: false, enabled: false } };
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
