// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanNndLegacyOwners } from '../src/nnd-legacy-census.js';

test('historical alternate renamed Node cannot evade census after selected Node changes',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nnd historical node '));
    const executable = join(root, 'historical-custom-runtime.exe');
    const cli = join(root, 'cli.js');
    try {
      await copyFile(process.execPath, executable);
      await writeFile(cli, "process.stdout.write('ready');setInterval(()=>{},1000)");
      for (const mode of ['tui', 'nnd']) {
        const child = spawn(executable, [cli, mode, ...(mode === 'nnd' ? ['serve'] : [])],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const exited = once(child, 'exit');
        try {
          await once(child.stdout, 'data');
          if (mode === 'nnd') {
            await assert.rejects(scanNndLegacyOwners({ node: process.execPath }), { code: 'nnd_owner_unverified' });
          } else assert.equal((await scanNndLegacyOwners({ node: process.execPath })).legacy, 0);
        } finally { child.kill(); await exited; }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
