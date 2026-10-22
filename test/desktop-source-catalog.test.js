// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectProductionSources } from '../desktop/scripts/source-catalog.js';

test('desktop source catalog includes production files and skips generated and test files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-sources-'));
  for (const path of ['packages/ui/src', 'packages/web/src', 'scripts', 'packages/ui/src/__tests__']) {
    await mkdir(join(root, path), { recursive: true });
  }
  for (const path of ['packages/ui/src/component.tsx', 'packages/web/src/server.ts', 'scripts/gate.js',
    'packages/ui/src/component.test.tsx', 'packages/web/src/types.d.ts', 'packages/ui/src/__tests__/hidden.ts']) {
    await writeFile(join(root, path), '', 'utf8');
  }
  const files = await collectProductionSources(root);
  assert.deepEqual(files.map((path) => path.slice(root.length + 1).replaceAll('\\', '/')).sort(),
    ['packages/ui/src/component.tsx', 'packages/web/src/server.ts', 'scripts/gate.js']);
});

test('desktop source catalog fails when a required root is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-missing-'));
  await mkdir(join(root, 'packages/ui/src'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await assert.rejects(collectProductionSources(root), /cannot inspect required source directory .*packages[\\/]web[\\/]src/u);
});
