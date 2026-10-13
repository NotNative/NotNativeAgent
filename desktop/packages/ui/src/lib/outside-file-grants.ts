// SPDX-License-Identifier: Apache-2.0
/** Doc 15 §G.5: cache explicit, host-backed grants for outside-file reads. */
import { workspaceRelativePath } from './files/workspace-paths.ts';
import { normalizeDirectory } from './nnd/client.ts';

export const OUTSIDE_FILE_GRANT_RENEWAL_MS = 5_000;
export const OUTSIDE_FILE_GRANT_RUNTIME = 'local';

export interface OutsideFileGrantHost {
  requestExistingFileAccess(path: string): Promise<{
    success?: boolean;
    path?: unknown;
    outsideFileGrant?: unknown;
    expiresAt?: unknown;
  }>;
}

export type OutsideFileReadOptions = {
  allowOutsideWorkspace: boolean;
  outsideFileGrant?: string;
};

type GrantReply = Awaited<ReturnType<OutsideFileGrantHost['requestExistingFileAccess']>>;
type CacheEntry = { grant: string; expiresAt: number };
type PendingGrant = Promise<OutsideFileReadOptions | null>;

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//u.test(path);
}

const grants = new Map<string, CacheEntry>();
const pending = new Map<string, PendingGrant>();

export function resetOutsideFileGrantCache(): void {
  grants.clear();
  pending.clear();
}

async function requestGrant(
  normalizedPath: string,
  host: OutsideFileGrantHost,
): Promise<OutsideFileReadOptions | null> {
  const cacheKey = `${OUTSIDE_FILE_GRANT_RUNTIME}:${normalizedPath}`;
  const cached = grants.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + OUTSIDE_FILE_GRANT_RENEWAL_MS) {
    return { allowOutsideWorkspace: true, outsideFileGrant: cached.grant };
  }
  if (cached) grants.delete(cacheKey);
  const inflight = pending.get(normalizedPath);
  if (inflight) return await inflight;

  const requested = (async (): Promise<OutsideFileReadOptions | null> => {
    let reply: GrantReply;
    try {
      reply = await host.requestExistingFileAccess(normalizedPath);
    } catch {
      return null;
    }
    if (reply?.success !== true) return null;
    const grantedPath = typeof reply.path === 'string' ? normalizeDirectory(reply.path) : '';
    const grant = typeof reply.outsideFileGrant === 'string' ? reply.outsideFileGrant : '';
    const expiresAt = typeof reply.expiresAt === 'number' && Number.isSafeInteger(reply.expiresAt)
      ? reply.expiresAt : 0;
    if (!grantedPath || !grant || expiresAt <= Date.now()) return null;
    const grantedKey = `${OUTSIDE_FILE_GRANT_RUNTIME}:${grantedPath}`;
    grants.set(grantedKey, { grant, expiresAt });
    if (grantedPath !== normalizedPath) grants.set(cacheKey, { grant, expiresAt });
    return { allowOutsideWorkspace: true, outsideFileGrant: grant };
  })();
  pending.set(normalizedPath, requested as PendingGrant);
  try {
    return await requested;
  } finally {
    if (pending.get(normalizedPath) === requested) pending.delete(normalizedPath);
  }
}

export async function resolveOutsideFileReadOptions(
  path: string,
  workspaceRoot: string,
  enabled: boolean,
  host?: OutsideFileGrantHost,
): Promise<OutsideFileReadOptions> {
  const requested = normalizeDirectory(path);
  const root = normalizeDirectory(workspaceRoot);
  if (!enabled || !requested || !isAbsolutePath(requested) ||
      workspaceRelativePath(root, requested) !== null) {
    return { allowOutsideWorkspace: false };
  }
  if (!host) return { allowOutsideWorkspace: false };
  return await requestGrant(requested, host) ?? { allowOutsideWorkspace: false };
}
