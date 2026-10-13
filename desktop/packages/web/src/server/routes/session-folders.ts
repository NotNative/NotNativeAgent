// SPDX-License-Identifier: Apache-2.0
/**
 * P4-3 session-folders (doc 03 §5.22): one snapshot JSON per runtime+
 * user-shape at `<data-dir>/session-folders.json`; last-writer-wins by
 * updatedAt (older POST answers `{success:true, ignored:true}`); 4 MiB cap
 * after parse; malformed stored shape → 500 with the documented strings;
 * synchronized write queue (single in-flight write promise).
 */
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import type { Hono } from 'hono';
import { ENV } from '../env.ts';

const CAP = 4 * 1024 * 1024;
const SNAPSHOT_FILE = joinPath(ENV.dataDir, 'session-folders.json');

interface Snapshot {
  version: 1;
  foldersMap: Record<string, { id: string; name: string; sessionIds: string[]; createdAt: number; parentId?: string }[]>;
  collapsedFolderIds: string[];
  updatedAt: number;
  exists?: true;
}

function stored(): Snapshot | null {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

function shapeValid(snapshot: unknown): snapshot is Snapshot {
  const bag = snapshot as Snapshot | null;
  if (!bag || typeof bag !== 'object' || bag.version !== 1) return false;
  if (typeof bag.updatedAt !== 'number') return false;
  if (!bag.foldersMap || typeof bag.foldersMap !== 'object' || Array.isArray(bag.foldersMap)) return false;
  if (!Array.isArray(bag.collapsedFolderIds)) return false;
  return true;
}

let writeQueue: Promise<void> = Promise.resolve();

export function registerSessionFoldersRoutes(app: Hono): void {
  app.get('/api/session-folders', (c) => {
    if (!existsSync(SNAPSHOT_FILE)) {
      return c.json({ version: 1, exists: false });
    }
    const parsed = stored();
    if (parsed === null) return c.json({ error: 'Stored session folders have an invalid shape' }, 500);
    if (!shapeValid(parsed)) return c.json({ error: 'Stored session folders are malformed' }, 500);
    // §5.22 doc-verbatim warm shape: `{version, foldersMap, collapsedFolderIds,
    // updatedAt, exists:true}` — stored verbatim, returned verbatim.
    return c.json(parsed);
  });

  app.post('/api/session-folders', async (c) => {
    let raw: string;
    try { raw = await c.req.text(); } catch { return c.json({ error: 'body read failed' }, 400); }
    if (raw.length > CAP) return c.json({ error: 'Payload too large' }, 413);
    let snapshot: unknown;
    try { snapshot = JSON.parse(raw); } catch { return c.json({ error: 'Body must be JSON' }, 400); }
    if (!shapeValid(snapshot)) return c.json({ error: 'session folders snapshot has an invalid shape' }, 400);
    const incoming = snapshot as Snapshot;
    const payload = JSON.stringify({ ...incoming, version: 1, exists: true });
    if (payload.length > CAP) return c.json({ error: 'Payload too large' }, 413);
    if (!existsSync(ENV.dataDir)) mkdirSync(ENV.dataDir, { recursive: true });
    // LWW + persistence run INSIDE the single-flight queue (review F1/F2):
    // staleness is verified at write time, failures fail the call, and a
    // dropped-stale write answers `ignored` per §5.22.
    const result = { outcome: 'written' as 'written' | 'stale', failed: false };
    writeQueue = writeQueue.then(async () => {
      const current = stored();
      if (current && shapeValid(current) && current.updatedAt > incoming.updatedAt) {
        result.outcome = 'stale'; // drop stale write
        return;
      }
      const tmp = `${SNAPSHOT_FILE}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, SNAPSHOT_FILE);
    }).catch(() => { result.failed = true; });
    await writeQueue;
    if (result.failed) return c.json({ error: 'Failed to persist session folders' }, 500);
    if (result.outcome === 'stale') return c.json({ success: true, ignored: true });
    return c.json({ success: true });
  });
}

function omitExists(snapshot: Snapshot): Omit<Snapshot, 'exists'> {
  const { exists: _e, ...rest } = snapshot;
  void _e;
  return rest;
}
