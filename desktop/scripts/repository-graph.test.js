// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rmdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { buildRepositoryGraph } from './repository-graph.js';

test('repository graph resolves workspace and extensionless imports with stable source digests', async () => {
  const temporaryRoot = resolve(tmpdir());
  const fixtureRoot = resolve(await mkdtemp(join(temporaryRoot, 'nnd-graph-')));
  assert.ok(fixtureRoot.startsWith(`${temporaryRoot}${sep}`));
  try {
    await mkdir(join(fixtureRoot, 'packages/ui/src/lib'), { recursive: true });
    await mkdir(join(fixtureRoot, 'packages/web/src/folder'), { recursive: true });
    await mkdir(join(fixtureRoot, 'scripts'));
    await writeFile(join(fixtureRoot, 'packages/ui/src/lib/util.ts'), 'export const value = 1;\n');
    await writeFile(join(fixtureRoot, 'packages/web/src/main.tsx'), [
      "import '@notnative/ui/lib/util.ts';",
      "import './helper';",
      "import './folder';",
      '',
    ].join('\n'));
    const helperPath = join(fixtureRoot, 'packages/web/src/helper.ts');
    await writeFile(helperPath, 'export const helper = 1;\r\n');
    await writeFile(join(fixtureRoot, 'packages/web/src/folder/index.ts'), 'export const index = 1;\n');

    const first = await buildRepositoryGraph(fixtureRoot);
    const main = first.modules.find((module) => module.path === 'packages/web/src/main.tsx');
    assert.deepEqual(main?.imports, [
      'packages/ui/src/lib/util.ts',
      'packages/web/src/folder/index.ts',
      'packages/web/src/helper.ts',
    ]);

    await writeFile(helperPath, (await readFile(helperPath, 'utf8')).replaceAll('\r\n', '\n'));
    const second = await buildRepositoryGraph(fixtureRoot);
    assert.equal(second.source_digest, first.source_digest);

    await rmdir(join(fixtureRoot, 'scripts'));
    await assert.rejects(buildRepositoryGraph(fixtureRoot), /cannot inspect/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
