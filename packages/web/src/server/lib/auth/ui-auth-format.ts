// SPDX-License-Identifier: Apache-2.0
import type { RemoteClientRecord } from './remote-clients.ts';
const UI_SESSION_COOKIE = 'oc_ui_session';
export function parseClientIp(headers: Headers, remoteAddress?: string): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== null) {
    const first = forwarded.split(',')[0]?.trim() ?? '';
    if (first !== '') return first;
  }
  return typeof remoteAddress === 'string' ? remoteAddress : '';
}

export function parseCookieHeader(header: string | undefined | null): Map<string, string> {
  const jar = new Map<string, string>();
  if (header === null || header === undefined || header === '') return jar;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== '') jar.set(name, value);
  }
  return jar;
}

export function sessionCookieHeaderValue(token: string, ttlMs: number, nowMs: number, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
  const expires = new Date(nowMs + ttlMs).toUTCString();
  return `${UI_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}; Expires=${expires}${secure ? '; Secure' : ''}`;
}

export function secureFromHeaders(headers: Headers, url: URL): boolean {
  if (url.protocol === 'https:') return true;
  const forwarded = headers.get('x-forwarded-proto');
  return forwarded !== null && forwarded.split(',').some((hop) => hop.trim() === 'https');
}

export function sanitizeOutboundClient(client: RemoteClientRecord): Record<string, unknown> {
  const { tokenHash: _secret, ...rest } = client as RemoteClientRecord & { tokenHash?: string };
  void _secret;
  return { ...rest };
}

