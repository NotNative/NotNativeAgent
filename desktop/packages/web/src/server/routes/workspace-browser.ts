// SPDX-License-Identifier: Apache-2.0
import { opendir, realpath, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Hono } from 'hono';
import { ENV } from '../env.ts';

/** Directory names for the authenticated operator's folder chooser; this grants no execution access. */
export function registerWorkspaceBrowserRoutes(app: Hono): void {
  app.post('/api/workspace-default', async context => {
    const directory = resolve(ENV.dataDir, 'workspaces', 'default');
    await mkdir(directory, { recursive: true });
    const canonical = await realpath(directory);
    if ((process.platform === 'win32' ? canonical.toLowerCase() !== directory.toLowerCase() : canonical !== directory)) {
      return context.json({ error: 'The default workspace must use its original folder, without links.' }, 400);
    }
    return context.json({ directory: canonical });
  });
  app.get('/api/workspace-browser', async context => {
    const requested = context.req.query('path') || homedir();
    if (requested.length > 4096 || !isAbsolute(requested) || /[\u0000-\u001f]/u.test(requested)) {
      return context.json({ error: 'Choose an absolute folder path.' }, 400);
    }
    try {
      const path = await realpath(requested);
      const same = process.platform === 'win32' ? path.toLowerCase() === resolve(requested).toLowerCase() : path === resolve(requested);
      if (!same) return context.json({ error: 'Choose the original folder instead of a link.' }, 400);
      const entries: { name: string; path: string }[] = [];
      const query = (context.req.query('query') ?? '').slice(0, 128).toLocaleLowerCase();
      let scanned = 0, truncated = false;
      for await (const entry of await opendir(path)) {
        scanned += 1;
        if (scanned > 5000 || entries.length >= 200) { truncated = true; break; }
        if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name.toLocaleLowerCase().includes(query)) {
          entries.push({ name: entry.name, path: resolve(path, entry.name) });
        }
      }
      const roots = process.platform === 'win32'
        ? Array.from({ length: 26 }, (_, i) => `${String.fromCharCode(65 + i)}:\\`).filter(root => existsSync(root)) : ['/'];
      return context.json({ path, parent: dirname(path), home: homedir(), roots,
        entries: entries.sort((a, b) => a.name.localeCompare(b.name)), truncated });
    } catch {
      return context.json({ error: 'Could not open this folder. Check that it exists and is readable.' }, 400);
    }
  });
}
