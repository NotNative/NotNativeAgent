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
/** Stable first-party origin of the NotNativeDesktop packaged renderer. */
export const NOTNATIVE_DESKTOP_UI_ORIGIN = 'notnative-ui://app';

/** §10.1 packaged-client origins ride pre-allowed. */
export const PACKAGED_CLIENT_ORIGINS = [
  NOTNATIVE_DESKTOP_UI_ORIGIN,
  'openchamber-ui://app',
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
] as const;

export function isTrustedDesktopUiOrigin(origin: string | null | undefined, configuredOrigin?: string): boolean {
  return typeof origin === 'string'
    && (origin === NOTNATIVE_DESKTOP_UI_ORIGIN || (Boolean(configuredOrigin) && origin === configuredOrigin));
}

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
export function originHostPasses(input: OriginCheckRequest, publicOrigin?: string | null, allowPackagedClientOrigins = true): boolean {
  const origin = typeof input.origin === 'string' ? input.origin.trim() : '';
  if (origin === '') return true;
  const originHost = hostOf(origin);
  if (originHost === null) return false;
  if (allowPackagedClientOrigins && (PACKAGED_CLIENT_ORIGINS as readonly string[]).includes(origin.toLowerCase())) return true;
  const candidates = [
    hostOf(input.forwardedHost),
    hostOf(input.host),
    hostOf(publicOrigin ?? null),
  ];
  return candidates.some((candidate) => candidate !== null && candidate === originHost);
}

/** Unsafe browser writes may use cookies (or open-auth) but never trust a
 * guest page's ambient access to the local listener. Explicit bearer clients
 * are authenticated by the normal API gate; browsers cannot send that header
 * cross-origin without a CORS preflight. */
export function browserMutationAllowed(request: Request, validatedBearer = false, trustedOrigin?: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return true;
  if (validatedBearer) return true;
  const origin = request.headers.get('origin');
  if (isTrustedDesktopUiOrigin(origin, trustedOrigin)) return true;
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') return false;
  if (origin === null || origin === '') return true; // non-browser clients
  // Opaque sandboxed pages serialize their Origin as `null`; treating that
  // token as a bare hostname could otherwise match a Host/forwarded host.
  if (origin.trim().toLowerCase() === 'null') return false;
  const url = new URL(request.url);
  return originHostPasses({
    origin,
    host: request.headers.get('host') ?? url.host,
    forwardedHost: request.headers.get('x-forwarded-host')?.split(',')[0]?.trim(),
  }, null, false);
}

/** Headers-shaped variant for the upgrade gate (Headers owns the names). */
export function originAdmittedByHeaders(request: {
  originHeader: string | null | undefined;
  hostHeader: string | null | undefined;
  forwardedHostHeader: string | null | undefined;
}, publicOrigin?: string | null, trustedOrigin?: string): boolean {
  if (trustedOrigin && request.originHeader === trustedOrigin) return true;
  return originHostPasses(
    {
      origin: request.originHeader,
      host: request.hostHeader,
      forwardedHost: request.forwardedHostHeader,
    },
    publicOrigin,
  );
}
