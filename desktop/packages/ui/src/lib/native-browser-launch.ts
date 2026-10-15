// SPDX-License-Identifier: Apache-2.0
let pending: { origin: string; ticket: string; expires: number } | null = null;
/** The one-use launch code never enters HTTP URLs, persisted settings, or the clipboard. */
export function captureNativeBrowserLaunch(): void {
  const match = /^#nna-access=([A-Za-z0-9_-]{32,128})$/u.exec(window.location.hash);
  if (!match) return;
  const origin = window.location.origin;
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  if (window.location.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(window.location.hostname)) pending = { origin, ticket: match[1]!, expires: Date.now() + 60_000 };
}
export function peekNativeBrowserLaunch(origin: string): string { return pending?.origin === origin && pending.expires > Date.now() ? pending.ticket : ''; }
export function consumeNativeBrowserLaunch(origin: string): string {
  const value = peekNativeBrowserLaunch(origin); pending = null; return value;
}
