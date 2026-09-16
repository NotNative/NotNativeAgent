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

export function getClientPlatform(): 'ios' | 'android' | 'vscode' | 'desktop' | 'web' {
  if (isDesktopShell()) return 'desktop';
  if (isVSCodeRuntime()) return 'vscode';
  return 'web';
}
