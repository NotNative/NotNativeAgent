// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationWork } from '../src/conversation-work.js';
import { ToolRegistry } from '../src/tool-registry.js';

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-canonical-tools-'));
  const work = new ConversationWork();
  const registry = new ToolRegistry(root, { boundedToWorkspace: true, conversationWork: work, ...options });
  await registry.initialize();
  return { root, work, registry, async close() { await registry.close(); await rm(root, { recursive: true, force: true }); } };
}

test('canonical filesystem tools list names, read snapshots, and preserve content-search separation', async () => {
  const item = await fixture();
  try {
    const directory = item.registry.definition('fs.directory');
    const create = await directory.validate({ action: 'create', path: 'src/components/widgets' });
    await directory.executor({ ...create, toolName: 'fs.directory' }, new AbortController().signal);
    await writeFile(join(item.root, 'src', 'components', 'widgets', 'button.js'), 'export const marker = true;\n');

    const list = item.registry.definition('fs.list');
    const listed = await list.validate({ path: '.', pattern: '**/*button*', depth: 8 });
    const listResult = await list.executor(listed, new AbortController().signal);
    assert.match(listResult.content, /file\tsrc\/components\/widgets\/button\.js/u);

    const read = item.registry.definition('fs.read');
    const complete = await read.validate({ path: 'src/components/widgets/button.js' });
    assert.equal((await read.executor(complete, new AbortController().signal)).content, 'export const marker = true;\n');
    const window = await read.validate({ path: 'src/components/widgets/button.js', start_line: 1, line_count: 1 });
    assert.match((await read.executor(window, new AbortController().signal)).content, /1: export const marker = true;/u);

    const search = item.registry.definition('fs.search_text');
    const searched = await search.validate({ path: '.', query: 'marker' });
    assert.match((await search.executor(searched, new AbortController().signal)).content, /button\.js:1/u);
  } finally { await item.close(); }
});

test('fs.directory removes only reviewed bounded trees and refuses protected workspace roots', async () => {
  const item = await fixture();
  try {
    const directory = item.registry.definition('fs.directory');
    await assert.rejects(directory.validate({ action: 'remove', path: '.', recursive: true }), { code: 'tool_protected_path' });
    const create = await directory.validate({ action: 'create', path: 'empty/nested' });
    await directory.executor(create, new AbortController().signal);
    const remove = await directory.validate({ action: 'remove', path: 'empty', recursive: true });
    await directory.executor(remove, new AbortController().signal);
    await assert.rejects(readFile(join(item.root, 'empty')), { code: 'ENOENT' });
  } finally { await item.close(); }
});

test('work.plan atomically replaces the durable goal and ordered tasks', async () => {
  const item = await fixture();
  try {
    const plan = item.registry.definition('work.plan');
    const initial = await plan.validate({
      objective: 'Ship the canonical tool surface',
      tasks: [{ title: 'Implement tools', status: 'in_progress' }, { title: 'Verify behavior' }],
    });
    const first = JSON.parse((await plan.executor(initial, new AbortController().signal)).content);
    assert.equal(first.tasks.length, 2);
    const completed = await plan.validate({
      objective: first.goal.objective, goal_status: 'completed', goal_evidence: 'Focused tests passed',
      tasks: first.tasks.map((task) => ({ id: task.id, title: task.title, status: 'completed', detail: `${task.title} verified` })),
    });
    const final = JSON.parse((await plan.executor(completed, new AbortController().signal)).content);
    assert.equal(final.goal.status, 'completed');
    assert.equal(final.tasks.every((task) => task.status === 'completed'), true);
    assert.equal(final.revision, 2);
  } finally { await item.close(); }
});

test('agent.run is task-activated only when a usable root subagent route exists', async () => {
  const item = await fixture({
    subagentControl: { workspaceRoot: process.cwd(), run: async () => ({ session_id: 'child', outcome: 'completed', text: 'done' }) },
  });
  try {
    assert.equal(item.registry.providerDefinitions().some((entry) => entry.function.name === 'agent.run'), false);
    assert.equal(item.registry.providerDefinitions('delegate this bounded task to a specialist')
      .some((entry) => entry.function.name === 'agent.run'), true);
  } finally { await item.close(); }
});
