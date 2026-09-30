// SPDX-License-Identifier: Apache-2.0
type InvokeResult = { ok: boolean; result?: unknown; error?: string };
type DesktopPathWindow = Pick<Window, '__NOTNATIVE_ELECTRON__' | '__NOTNATIVE_DESKTOP_INVOKE__' | '__NOTNATIVE_LOCAL_ORIGIN__' | 'location'>;

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/u, '');
  return value === 'localhost' || value === '127.0.0.1' || value === '[::1]' || value === '::1';
}

export function isDesktopLocalOriginActive(windowRef: DesktopPathWindow): boolean {
  if (windowRef.__NOTNATIVE_ELECTRON__?.runtime !== 'electron'
    || typeof windowRef.__NOTNATIVE_DESKTOP_INVOKE__ !== 'function'
    || typeof windowRef.__NOTNATIVE_LOCAL_ORIGIN__ !== 'string') return false;
  try {
    const active = new URL(windowRef.location.href);
    if (active.protocol === 'notnative-ui:' && active.host === 'app') return true;
    const local = new URL(windowRef.__NOTNATIVE_LOCAL_ORIGIN__);
    if (active.origin === local.origin) return true;
    return isLoopback(active.hostname) && isLoopback(local.hostname)
      && active.port === local.port && active.protocol === local.protocol;
  } catch { return false; }
}

export function createDesktopPathApi(windowRef: DesktopPathWindow) {
  async function invoke(command: 'desktop_open_path' | 'desktop_reveal_path', payload: unknown): Promise<boolean | null> {
    if (!isDesktopLocalOriginActive(windowRef)) return null;
    try {
      const result: InvokeResult = await windowRef.__NOTNATIVE_DESKTOP_INVOKE__!(command, payload);
      return result.ok;
    } catch { return false; }
  }
  return {
    open(path: string, app?: string): Promise<boolean | null> {
      return invoke('desktop_open_path', { path, ...(app === undefined ? {} : { app }) });
    },
    reveal(path: string): Promise<boolean | null> {
      return invoke('desktop_reveal_path', { path });
    },
  };
}
