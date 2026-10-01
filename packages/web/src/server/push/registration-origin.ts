// SPDX-License-Identifier: Apache-2.0
import { originHostPasses } from '../lib/http/request-security.ts';
import { isIP } from 'node:net';
import { isLoopbackHostname } from '../lib/auth/pairing-candidates.ts';
import { PushStoreError } from './subscription-store.ts';

export function pushRegistrationOrigin(value: unknown, request: Request): string | null {
  if (value === undefined) return null;
  const origin = normalizedPublicOrigin(value);
  const header = request.headers.get('origin');
  const target = new URL(request.url);
  if (!origin || (header !== null && normalizedPublicOrigin(header) !== origin)
    || !originHostPasses({ origin, host: request.headers.get('host') ?? target.host,
      forwardedHost: request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() }, null, false)) {
    throw new PushStoreError('Push origin must match the registering application', 400);
  }
  return origin;
}

export function normalizedPublicOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const loopback = isLoopbackHostname(url.hostname) || isIP(url.hostname) === 4 && url.hostname.startsWith('127.');
    return (url.protocol === 'https:' || url.protocol === 'http:' && loopback)
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : null;
  } catch { return null; }
}
