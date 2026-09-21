// SPDX-License-Identifier: Apache-2.0
/**
 * Reverse-proxy origin consumption (doc 08 §9, checklist step 14): when a
 * browser sends an Origin header, host equality decides - the PROTOCOL is
 * never compared (TLS terminates at the edge, the hop to the app is http).
 * Candidates: the Host header, x-forwarded-host (first hop), the configured
 * publicOrigin, and the packaged-client origins. Absent Origin passes:
 * same-origin fetches and non-browser clients omit it.
 */

export interface OriginCheckRequest {
  origin: string | null | undefined;
  host: string | null | undefined;
  forwardedHost?: string | null | undefined;
}

export const PUBLIC_ORIGIN_SETTING_KEY = 'publicOrigin';

/** §10.1 packaged-client origins ride pre-allowed. */
export const PACKAGED_CLIENT_ORIGINS = [
  'openchamber-ui://app',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
] as const;

const BARE_HOST = /^(\[[0-9a-f:.]+\]|[a-z0-9.\-]+)(?::(\d+))?$/u;

function hostOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    if (url.host !== '') return url.host.toLowerCase();
  } catch {
    // fall through to the bare-host shape
  }
  // A Host/forwarded-host header is a bare host (optionally :port) with no
  // scheme; "host:443" parses as a URL scheme and must stay the literal
  // host. Bracketed IPv6 literals ([::1]:8080) ride the bracket arm - without
  // it an IPv6 Host header never matched its Origin and the gate stayed
  // fail-closed for every IPv6 dial. The port is canonicalized like WHATWG
  // (":080" == ":80"), and the scheme defaults (80/443) drop everywhere:
  // WHATWG already stripped the origin's, so an edge-terminated :443 hop
  // must not mismatch.
  const groups = BARE_HOST.exec(trimmed.toLowerCase()) ?? [];
  const host = groups[1];
  const portText = groups[2];
  if (host === undefined) return null;
  if (portText === undefined) return host;
  const port = String(Number(portText));
  if (port === '80' || port === '443') return host;
  return `${host}:${port}`;
}

/** host equality only (never the protocol); x-forwarded-host applies when
 *  Host was rewritten by the hop (§9: the browser origin survives there). */
export function originHostPasses(input: OriginCheckRequest, publicOrigin?: string | null): boolean {
  const origin = typeof input.origin === 'string' ? input.origin.trim() : '';
  if (origin === '') return true;
  const originHost = hostOf(origin);
  if (originHost === null) return false;
  if ((PACKAGED_CLIENT_ORIGINS as readonly string[]).includes(origin.toLowerCase())) return true;
  const candidates = [
    hostOf(input.forwardedHost),
    hostOf(input.host),
    hostOf(publicOrigin ?? null),
  ];
  return candidates.some((candidate) => candidate !== null && candidate === originHost);
}

/** Headers-shaped variant for the upgrade gate (Headers owns the names). */
export function originAdmittedByHeaders(request: {
  originHeader: string | null | undefined;
  hostHeader: string | null | undefined;
  forwardedHostHeader: string | null | undefined;
}, publicOrigin?: string | null): boolean {
  return originHostPasses(
    {
      origin: request.originHeader,
      host: request.hostHeader,
      forwardedHost: request.forwardedHostHeader,
    },
    publicOrigin,
  );
}
