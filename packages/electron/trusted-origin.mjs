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
