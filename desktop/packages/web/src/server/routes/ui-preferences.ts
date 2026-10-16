// SPDX-License-Identifier: Apache-2.0
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { NATIVE_PREFERENCE_DEFAULTS, parseNativePreferencePatch } from '@notnative/ui/lib/settings/native-registry.ts';
import { ENV } from '../env.ts';
import { withConfigLock } from '../scheduled/config-lock.ts';
import { readJsonBodyBounded } from '../lib/http/read-bounded.ts';

type Preferences = { revision: number; settings: Record<string, unknown> };
async function read(path: string): Promise<Preferences> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 32768) throw new Error('UI preference storage exceeds its limit.');
    const row = JSON.parse(await readFile(path, 'utf8')) as Preferences;
    const settings = parseNativePreferencePatch(row.settings);
    if (!Number.isSafeInteger(row.revision) || row.revision < 0 || !settings) throw new Error('UI preference storage is invalid.');
    return { revision: row.revision, settings: { ...NATIVE_PREFERENCE_DEFAULTS, ...settings } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 0, settings: { ...NATIVE_PREFERENCE_DEFAULTS } };
    throw error;
  }
}

/** Security: authenticated presentation writes use a separate store, never the engine configuration route. */
export function registerUiPreferenceRoutes(app: Hono): void {
  const file = () => join(ENV.dataDir, 'ui-preferences.json');
  app.get('/api/ui-preferences', async c => c.json(await read(file()), 200, { 'cache-control': 'no-store' }));
  app.put('/api/ui-preferences', async c => {
    const body = await readJsonBodyBounded(c.req.raw, 32768);
    const patch = parseNativePreferencePatch(body?.settings);
    if (!patch || !Number.isSafeInteger(body?.expected_revision) || Number(body?.expected_revision) < 0) return c.json({ error: 'UI preference update is invalid.' }, 400);
    const path = file();
    const result = await withConfigLock(path, async () => {
      const current = await read(path);
      if (current.revision !== body!.expected_revision) return null;
      const next = { revision: current.revision + 1, settings: { ...current.settings, ...patch } };
      await mkdir(ENV.dataDir, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
      return next;
    });
    return result ? c.json(result) : c.json({ error: 'Settings changed in another window. Reload saved settings before editing again.' }, 409);
  });
}
