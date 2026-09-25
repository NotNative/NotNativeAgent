// SPDX-License-Identifier: Apache-2.0
/** URL policy for the unprivileged, user-driven preview pane. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
  // A terminal dot is a valid DNS spelling of localhost. URL canonicalizes
  // alternate IPv4 spellings (127.1, hex/octal) but preserves that dot.
  return LOOPBACK_HOSTS.has(hostname.toLowerCase().replace(/\.$/u, ''));
}

export function normalizePreviewUrl(input: string, appOrigin: string): string | null {
  const value = input.trim();
  if (!value || value.startsWith('//')) return null;
  let candidate = value;
  if (!/^https?:\/\//iu.test(value)) {
    if (value.includes('://') || /^(?:javascript|data|file|blob|about|mailto):/iu.test(value)) return null;
    const authority = value.split(/[/?#]/u, 1)[0] ?? '';
    const host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':', 1)[0] ?? '';
    candidate = `${isLoopbackHost(host) ? 'http' : 'https'}://${value}`;
  }
  try {
    const url = new URL(candidate);
    const own = new URL(appOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    // A preview can neither be the NND app itself nor an alias to its local
    // listener. This keeps app auth and UI code out of the guest frame.
    if (url.origin === own.origin || (
      isLoopbackHost(url.hostname)
      && isLoopbackHost(own.hostname)
      && url.port === own.port && url.protocol === own.protocol
    )) return null;
    return url.href;
  } catch {
    return null;
  }
}
