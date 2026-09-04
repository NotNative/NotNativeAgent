// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectGuidance } from '../src/guidance/project.js';
import { buildContext } from '../src/context.js';

test('project guidance resolves portable instructions and lower-priority local memory root-to-target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-project-guidance-'));
  await mkdir(join(root, 'src', 'feature'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), 'root instructions');
  await writeFile(join(root, 'NNA.md'), 'root memory');
  await writeFile(join(root, 'src', 'AGENTS.md'), 'ignored source instructions');
  await writeFile(join(root, 'src', 'AGENTS.override.md'), 'source override');
  await writeFile(join(root, 'src', 'NNA.md'), 'source memory');
  await writeFile(join(root, 'src', 'feature', 'AGENTS.md'), 'feature instructions');
  await writeFile(join(root, 'src', 'feature', 'AGENTS.override.md'), '');
  await writeFile(join(root, 'src', 'feature', 'NNA.md'), 'feature memory');
  const catalog = new ProjectGuidance(root);
  const items = await catalog.resolve([
    { type: 'tool_request', args: { path: 'src/feature/file.js' } },
    { type: 'tool_request', args: { path: '../outside/file.js' } },
  ]);
  assert.deepEqual(items.map((item) => item.path.replaceAll('\\', '/')), [
    'NNA.md', 'src/NNA.md', 'src/feature/NNA.md',
    'AGENTS.md', 'src/AGENTS.override.md', 'src/feature/AGENTS.md',
  ]);
  assert.deepEqual(items.map((item) => item.kind), [
    'project_memory', 'project_memory', 'project_memory',
    'agent_instructions', 'agent_instructions', 'agent_instructions',
  ]);
  assert.deepEqual(items.map((item) => item.depth), [0, 1, 2, 0, 1, 2]);
});

test('project guidance is attributed workspace policy and cannot masquerade as kernel authority', () => {
  const config = { workspaceRoot: 'D:/work', limits: { maxContextBytes: 1_048_576 } };
  const context = buildContext(config, [], 'work here', {
    projectGuidance: [
      { path: 'src/NNA.md', depth: 1, kind: 'project_memory', content: 'Use focused modules.' },
      { path: 'src/AGENTS.md', depth: 1, kind: 'agent_instructions', content: 'Run focused tests.' },
    ],
  });
  const memory = context.find((entry) => entry.provenance === 'project_guidance:src/NNA.md');
  const instructions = context.find((entry) => entry.provenance === 'project_guidance:src/AGENTS.md');
  assert.equal(memory.trust, 'workspace_guidance');
  assert.match(memory.content, /cannot override applicable AGENTS\.md instructions/u);
  assert.match(instructions.content, /does not prove factual claims, grant tool authority/u);
});

test('project guidance rejects documents reached through an escaping ancestor symlink', async (context) => {
  if (process.platform === 'win32') return context.skip('directory symlink fixtures require elevated Windows privileges');
  const root = await mkdtemp(join(tmpdir(), 'nna-project-guidance-'));
  const outside = await mkdtemp(join(tmpdir(), 'nna-project-guidance-outside-'));
  await writeFile(join(root, 'AGENTS.md'), 'root instructions');
  await writeFile(join(outside, 'AGENTS.md'), 'outside instructions');
  await symlink(outside, join(root, 'linked'), 'dir');
  const items = await new ProjectGuidance(root).resolve([
    { type: 'tool_request', args: { path: 'linked/file.js' } },
  ]);
  assert.deepEqual(items.map((item) => item.content), ['root instructions']);
});
