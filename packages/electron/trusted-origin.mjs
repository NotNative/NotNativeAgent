// SPDX-License-Identifier: Apache-2.0
export function matchesTrustedOrigin(rawUrl, rawOrigin) {
  if (typeof rawUrl !== 'string' || typeof rawOrigin !== 'string' || rawOrigin === '') return false;
  try {
    const url = new URL(rawUrl);
    const trusted = new URL(`${rawOrigin}/`);
    if (url.username !== '' || url.password !== '') return false;
    if (url.origin !== 'null' || trusted.origin !== 'null') return url.origin === trusted.origin;
    return url.protocol === trusted.protocol && url.host === trusted.host;
  } catch { return false; }
}

/**
 * Machine-local renderer operations are available to the local server origin
 * or the app's non-network UI protocol. Network UI origins are intentionally
 * excluded even when they are trusted for ordinary renderer IPC.
 */
export function matchesDesktopLocalOrigin(rawUrl, localOrigin, uiOrigin = '') {
  let localUiOrigin = false;
  try {
    const protocol = new URL(uiOrigin).protocol;
    localUiOrigin = protocol !== 'http:' && protocol !== 'https:';
  } catch { /* no separate local UI origin */ }
  return matchesTrustedOrigin(rawUrl, localOrigin)
    || (localUiOrigin && matchesTrustedOrigin(rawUrl, uiOrigin));
}
