// SPDX-License-Identifier: Apache-2.0
/** Path-bound, short-lived raw grants for rendering verified outside files. */

import { randomUUID } from 'node:crypto';

const GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_GRANTS = 1024;

type OutsideFileGrant = { path: string; scope: 'raw'; expiresAt: number };
const grants = new Map<string, OutsideFileGrant>();

export type OutsideFileGrantReply = { token: string; path: string; expiresAt: number };

export function mintOutsideFileGrant(path: string): OutsideFileGrantReply | null {
  const normalized = path.trim();
  if (normalized === '') return null;
  const token = randomUUID();
  const expiresAt = Date.now() + GRANT_TTL_MS;
  while (grants.size >= MAX_GRANTS) {
    const oldest = grants.keys().next().value;
    if (oldest === undefined) break;
    grants.delete(oldest);
  }
  grants.set(token, { path: normalized, scope: 'raw', expiresAt });
  return { token, path: normalized, expiresAt };
}

export function resolveOutsideFileGrant(token: unknown, requestedPath: string): {
  path: string; expiresAt: number;
} | null {
  if (!isUuid(token) || requestedPath === '') return null;
  const grant = grants.get(token);
  if (grant === undefined || grant.scope !== 'raw' || grant.expiresAt <= Date.now()) {
    if (grant !== undefined) grants.delete(token);
    return null;
  }
  return grant.path === requestedPath ? { path: grant.path, expiresAt: grant.expiresAt } : null;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
