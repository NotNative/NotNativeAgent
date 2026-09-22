// SPDX-License-Identifier: Apache-2.0
/**
 * Tray controller (P12a tray slice) — Electron port of the reference
 * launcher pattern found in row-bot (src/row_bot/launcher.py):
 *   • tray icon owns service status feedback (running / stopped / starting)
 *   • "Open <App>" is the DEFAULT item — restores/creates the desktop window
 *   • "Open Web UI in Browser" hands the local origin to the default browser
 *   • Quit tears the service down deliberately (graceful dispose + watchdog)
 * The window close button HIDES to tray while a tray is active so the
 * service keeps running — full exit only happens through the tray Quit.
 */
import { Menu, nativeImage, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const ICON_FILES = {
  running: 'tray-running.png',
  stopped: 'tray-stopped.png',
  starting: 'tray-stopped.png',
};

function statusLabel(status, origin) {
  if (status === 'running' && origin) return `Server running on ${origin}`;
  if (status === 'running') return 'Server running';
  if (status === 'stopped') return 'Server stopped (see the tray menu: Open App / Quit)';
  return 'Server starting…';
}

/** Load one of the generated PNGs; null when assets are missing/invalid. */
function loadIcon(assetsDir, status) {
  const file = path.join(assetsDir, ICON_FILES[status] ?? 'tray-stopped.png');
  try {
    if (!fs.existsSync(file)) return null;
    const image = nativeImage.createFromPath(file);
    return image.isEmpty() ? null : image;
  } catch {
    return null; // tray is a UX nicety — never a boot blocker
  }
}

export function createTrayController(input) {
  const title = input.title ?? 'NotNativeDesktop';
  let status = 'starting';
  let origin = input.origin ?? '';
  let tray = null;

  function rebuild() {
    if (!tray) return;
    const running = status === 'running' && origin !== '';
    const menu = Menu.buildFromTemplate([
      { label: `Open ${title}`, click: () => input.ensureMainWindow() },
      { label: 'Open Web UI in Browser', enabled: running, click: () => {
        if (origin === '') return;
        shell.openExternal(origin).catch(() => { /* browser open is best-effort */ });
      } },
      { type: 'separator' },
      { label: statusLabel(status, origin), enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => input.onQuit() },
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`${title} — ${status === 'running' ? 'running' : status === 'starting' ? 'starting' : 'stopped'}`);
  }

  function create() {
    const image = loadIcon(input.assetsDir, status);
    if (!image) return false;
    try {
      tray = new Tray(image);
    } catch {
      tray = null;
      return false;
    }
    tray.on('double-click', () => input.ensureMainWindow());
    rebuild();
    return true;
  }

  return {
    create,
    setStatus(next, nextOrigin) {
      if (!tray) return;
      status = next;
      if (typeof nextOrigin === 'string') origin = nextOrigin;
      const image = loadIcon(input.assetsDir, status);
      if (image) tray.setImage(image);
      rebuild();
    },
    destroy() {
      if (!tray) return;
      try { tray.destroy(); } catch { /* already gone */ }
      tray = null;
    },
    get active() {
      return tray !== null;
    },
  };
}
