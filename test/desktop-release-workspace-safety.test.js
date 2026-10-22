// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkWorkspaceSafety } from '../desktop/scripts/release-workspace-safety.mjs';

test('release safety requires every package manifest and private:true', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-desktop-release-safety-'));
  try {
    await mkdir(join(root, 'packages', 'ui'), { recursive: true });
    await mkdir(join(root, 'packages', 'web'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"private":true}');
    await writeFile(join(root, 'packages', 'ui', 'package.json'), '{"private":true}');
    await writeFile(join(root, 'packages', 'web', 'package.json'), '{"private":true}');
    const errors = [];
    await checkWorkspaceSafety(root, errors);
    assert.deepEqual(errors, []);

    // A manifest can change while the slower build gates are running.
    await writeFile(join(root, 'packages', 'web', 'package.json'), '{"private":false}');
    await checkWorkspaceSafety(root, errors);
    assert.match(errors.join('\n'), /packages\/web\/package.json must stay private:true/u);
    errors.length = 0;
    await writeFile(join(root, 'packages', 'web', 'package.json'), '{"private":true}');

    await rm(join(root, 'packages', 'ui', 'package.json'));
    await writeFile(join(root, 'packages', 'web', 'package.json'), '{invalid');
    await checkWorkspaceSafety(root, errors);
    assert.match(errors.join('\n'), /packages\/ui\/package.json could not be read as JSON/u);
    assert.match(errors.join('\n'), /packages\/web\/package.json could not be read as JSON/u);

    errors.length = 0;
    await writeFile(join(root, 'packages', 'ui', 'package.json'), '[]');
    await writeFile(join(root, 'packages', 'web', 'package.json'), '{"private":false}');
    await checkWorkspaceSafety(root, errors);
    assert.match(errors.join('\n'), /packages\/ui\/package.json must contain a JSON object/u);
    assert.match(errors.join('\n'), /packages\/web\/package.json must stay private:true/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

