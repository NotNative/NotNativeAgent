// SPDX-License-Identifier: Apache-2.0
/**
 * Shell/platform classification (doc 01 §3.5). Electron + VS Code detection
 * become live when their phases land; behavior is identical to false today.
 */

export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  return window.__NOTNATIVE_ELECTRON__?.runtime === 'electron';
}

export function isVSCodeRuntime(): boolean {
  // __NOTNATIVE_VSCODE_CONFIG__ (doc 01 §3.1) is injected by the extension host;
  // extension surface long-term deferred.
  return false;
}

export function isMobileSurfaceRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return window.__NOTNATIVE_SURFACE__ === 'mobile';
}

export function isWebRuntime(): boolean {
  return !isDesktopShell() && !isVSCodeRuntime();
}

/** §I.1 platform split: mod = Cmd on macOS else Ctrl (affects the dispatcher
 * event-chord derivation, the recorder strokes, and display glyphs). */
export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/u.test(navigator.userAgent) === true
    && !(/iPhone|iPad/u.test(navigator.userAgent) && navigator.maxTouchPoints > 2 && /Macintosh/u.test(navigator.userAgent));
}

export function getClientPlatform(): 'ios' | 'android' | 'vscode' | 'desktop' | 'web' {
  if (isDesktopShell()) return 'desktop';
  if (isVSCodeRuntime()) return 'vscode';
  return 'web';
}
