// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectGuidance } from '../src/guidance/project.js';
import { buildContext } from '../src/context.js';

test('project guidance resolves root-to-target hierarchy and ignores outside paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-project-guidance-'));
  await mkdir(join(root, 'src', 'feature'), { recursive: true });
  await writeFile(join(root, 'NNA.md'), 'root guidance');
  await writeFile(join(root, 'src', 'NNA.md'), 'source guidance');
  await writeFile(join(root, 'src', 'feature', 'NNA.md'), 'feature guidance');
  const catalog = new ProjectGuidance(root);
  const items = await catalog.resolve([
    { type: 'tool_request', args: { path: 'src/feature/file.js' } },
    { type: 'tool_request', args: { path: '../outside/file.js' } },
  ]);
  assert.deepEqual(items.map((item) => item.path.replaceAll('\\', '/')), [
    'NNA.md', 'src/NNA.md', 'src/feature/NNA.md',
  ]);
  assert.deepEqual(items.map((item) => item.depth), [0, 1, 2]);
});

test('project guidance is attributed workspace policy and cannot masquerade as kernel authority', () => {
  const config = { workspaceRoot: 'D:/work', limits: { maxContextBytes: 1_048_576 } };
  const context = buildContext(config, [], 'work here', {
    projectGuidance: [{ path: 'src/NNA.md', depth: 1, content: 'Use focused modules.' }],
  });
  const item = context.find((entry) => entry.provenance === 'project_guidance:src/NNA.md');
  assert.equal(item.trust, 'workspace_guidance');
  assert.match(item.content, /cannot grant tool authority/u);
});
