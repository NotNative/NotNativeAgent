// SPDX-License-Identifier: Apache-2.0
/**
 * Per-request rp + origin derivation (doc 08 section 2.4): x-forwarded-host
 * (first hop) else Host else the request URL; the rpID is the lowercased
 * bracket-stripped PORT-STRIPPED host, while the expected origin keeps the
 * browser-visible port when it is not the scheme default (WebAuthn
 * clientDataJSON.origins carry the port; @simplewebauthn compares them as
 * exact strings) and re-brackets IPv6 hosts. Scheme rides x-forwarded-proto
 * first hop else the URL protocol.
 */
import { readPublicOrigin } from '../settings-store.ts';
import { normalizedPublicOrigin } from '../../push/registration-origin.ts';

const SCHEME_DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' };

export interface RpContext {
  rpID: string;
  expectedOrigins: string[];
}

interface SplitHost {
  host: string; // lowercased, bracket-stripped, port-stripped
  port: string; // '' when absent
  bracketed: boolean;
}

export function deriveRpContext(headers: Headers, url: URL, publicOrigin: unknown = readPublicOrigin()): RpContext {
  const forwardedHost = headers.get('x-forwarded-host');
  const hostSource = forwardedHost !== null
    ? forwardedHost.split(',')[0]?.trim() ?? ''
    : headers.get('host') ?? url.host;
  const scheme = headers.get('x-forwarded-proto')?.split(',')[0]?.trim()?.toLowerCase() ?? url.protocol.replace(/:$/u, '');
  const split = splitHostPort(hostSource);
  const suffix = split.port !== '' && SCHEME_DEFAULT_PORTS[scheme] !== split.port ? `:${split.port}` : '';
  const mapped = split.bracketed ? `[${split.host}]` : split.host;
  const requestOrigin = `${scheme}://${mapped}${suffix}`;
  const configured = normalizedPublicOrigin(publicOrigin);
  return { rpID: split.host, expectedOrigins: configured && configured !== requestOrigin
    ? [requestOrigin, configured] : [requestOrigin] };
}

export function normalizedRpId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const split = splitHostPort(value.trim());
  return split.host;
}

export function isLocalRpId(rpID: string): boolean {
  return rpID === 'localhost' || rpID === '127.0.0.1' || rpID === '::1';
}

/** Bracket-aware host:port splitter ('[::1]:5180' keeps the brackets out of
 * the host and reports the port; a stray multi-colon host keeps everything). */
function splitHostPort(value: string): SplitHost {
  const raw = value.trim().toLowerCase();
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return { host: raw.slice(1), port: '', bracketed: true };
    return { host: raw.slice(1, end), port: raw.slice(end + 1).replace(/^:/u, ''), bracketed: true };
  }
  const colon = raw.lastIndexOf(':');
  if (colon > 0 && raw.indexOf(':') === colon) {
    return { host: raw.slice(0, colon), port: raw.slice(colon + 1), bracketed: false };
  }
  return { host: raw, port: '', bracketed: false };
}
