// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../src/context.js';
import { ProjectIntake, shouldInspectProject } from '../src/project-intake.js';

test('project intake reports bounded repository structure and package metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-project-intake-'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'README.md'), '# Example');
  await writeFile(join(root, 'src', 'cli.js'), 'export {};');
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'example', type: 'module', bin: { example: 'src/cli.js' },
    scripts: { test: 'node --test' }, engines: { node: '>=24' },
  }));
  const result = await new ProjectIntake(root).inspect();
  assert.equal(result.repository, 'git');
  assert.deepEqual(result.manifests, ['package.json']);
  assert.deepEqual(result.source_directories, ['src']);
  assert.deepEqual(result.test_directories, ['test']);
  assert.deepEqual(result.entry_points, ['src/cli.js']);
  assert.deepEqual(result.package.scripts, ['test']);
  assert.equal(result.package.engines.node, '>=24');
});

test('project intake activates only for explicit workspace references', () => {
  assert.equal(shouldInspectProject('Please audit this codebase.'), true);
  assert.equal(shouldInspectProject('What is the weather today?'), false);
});

test('project intake is attributed as deterministic observation', () => {
  const context = buildContext({ workspaceRoot: 'D:/work', limits: { maxContextBytes: 1_048_576 } }, [], 'audit this repo', {
    projectIntake: { workspace: 'D:/work', repository: 'git', manifests: ['package.json'] },
  });
  const message = context.find((item) => item.provenance === 'project_intake');
  assert.equal(message.trust, 'engine_observation');
  assert.match(message.content, /inspect file contents before asserting details/u);
});
