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

test('filesystem mutations accept unambiguous common argument spellings and retain canonical sealed requests', async () => {
  const item = await fixture();
  try {
    const directory = item.registry.definition('fs.directory');
    const created = await directory.validate({ operation: 'create', directoryPath: 'src/generated' });
    assert.deepEqual(created.args, { action: 'create', path: 'src/generated', recursive: true });
    await directory.executor(created, new AbortController().signal);

    const write = item.registry.definition('fs.write_text');
    const written = await write.validate({ filePath: 'src/generated/value.txt', text: 'before' });
    assert.equal(written.args.path, 'src/generated/value.txt');
    assert.equal(written.args.content, 'before');
    assert.equal(Object.hasOwn(written.args, 'filePath'), false);
    await write.executor(written, new AbortController().signal);

    const edit = item.registry.definition('fs.edit_text');
    const edited = await edit.validate({
      file_path: 'src/generated/value.txt', oldString: 'before', newString: 'after', replaceAll: false,
    });
    assert.deepEqual({
      path: edited.args.path, old_text: edited.args.old_text,
      new_text: edited.args.new_text, replace_all: edited.args.replace_all,
    }, { path: 'src/generated/value.txt', old_text: 'before', new_text: 'after', replace_all: false });
    await edit.executor(edited, new AbortController().signal);
    assert.equal(await readFile(join(item.root, 'src', 'generated', 'value.txt'), 'utf8'), 'after');

    await assert.rejects(write.validate({ path: 'one.txt', filePath: 'two.txt', content: 'x' }), {
      code: 'tool_schema_invalid',
    });
  } finally { await item.close(); }
});

test('fs.edit_text exposes one forgiving contract for exact and line-range edits', async () => {
  const item = await fixture();
  try {
    const exposed = item.registry.providerDefinitions('edit a project file')
      .find((entry) => entry.function.name === 'fs.edit_text').function.parameters;
    assert.deepEqual(exposed.required, ['path', 'content']);
    assert.deepEqual(Object.keys(exposed.properties), ['path', 'content', 'find', 'start_line', 'end_line', 'all']);

    const path = join(item.root, 'editable.txt');
    await writeFile(path, 'one\r\ntwo\r\nthree\r\n', 'utf8');
    const edit = item.registry.definition('fs.edit_text');
    const exact = await edit.validate({ path: 'editable.txt', search: 'one\ntwo', text: 'ONE\nTWO' });
    assert.equal(exact.args.edit_mode, 'exact');
    assert.equal(exact.args.old_text, 'one\r\ntwo');
    await edit.executor(exact, new AbortController().signal);
    assert.equal(await readFile(path, 'utf8'), 'ONE\nTWO\r\nthree\r\n');

    const lines = await edit.validate({ path: 'editable.txt', line: 2, text: 'SECOND' });
    assert.deepEqual([lines.args.start_line, lines.args.end_line], [2, 2]);
    assert.equal(lines.args.edit_mode, 'lines');
    await edit.executor(lines, new AbortController().signal);
    assert.equal(await readFile(path, 'utf8'), 'ONE\r\nSECOND\r\nthree\r\n');
  } finally { await item.close(); }
});

test('fs.edit_text rejects ambiguous selectors and revalidates line content after review', async () => {
  const item = await fixture();
  try {
    const path = join(item.root, 'editable.txt');
    await writeFile(path, 'one\ntwo\nthree\n', 'utf8');
    const edit = item.registry.definition('fs.edit_text');
    await assert.rejects(edit.validate({ path: 'editable.txt', content: 'x' }), { code: 'tool_schema_invalid' });
    await assert.rejects(edit.validate({
      path: 'editable.txt', content: 'x', find: 'one', start_line: 1,
    }), { code: 'tool_schema_invalid' });
    await assert.rejects(edit.validate({
      path: 'editable.txt', content: 'x', start_line: 1, all: true,
    }), { code: 'tool_schema_invalid' });

    const prepared = await edit.validate({ path: 'editable.txt', content: 'TWO', start_line: 2 });
    await writeFile(path, 'one\nexternally changed\nthree\n', 'utf8');
    await assert.rejects(edit.executor(prepared, new AbortController().signal), { code: 'tool_revalidation_drift' });
  } finally { await item.close(); }
});

test('approved same-batch file mutations advance across NNA-authored states without accepting external drift', async () => {
  const item = await fixture();
  try {
    const context = {
      policyVersion: 1, authority: { id: 'authority', version: 1, restrictionVersion: 0 },
      stepId: 'step', caller: 'primary', surface: 'test',
    };
    const first = await item.registry.seal({
      providerCallId: 'write-first', name: 'fs.write_text', args: { path: 'result.txt', content: 'alpha beta' },
    }, context);
    const second = await item.registry.seal({
      providerCallId: 'write-second', name: 'fs.write_text', args: { path: 'result.txt', content: 'alpha beta gamma' },
    }, context);
    const write = item.registry.definition('fs.write_text');
    await write.executor(first, new AbortController().signal);
    const secondResult = await write.executor(second, new AbortController().signal);
    assert.equal(secondResult.metadata.advanced_from_authored_state, true);

    const editAlpha = await item.registry.seal({
      providerCallId: 'edit-alpha', name: 'fs.edit_text',
      args: { path: 'result.txt', old_text: 'alpha', new_text: 'ALPHA' },
    }, context);
    const editBeta = await item.registry.seal({
      providerCallId: 'edit-beta', name: 'fs.edit_text',
      args: { path: 'result.txt', old_text: 'beta', new_text: 'BETA' },
    }, context);
    const edit = item.registry.definition('fs.edit_text');
    await edit.executor(editAlpha, new AbortController().signal);
    const betaResult = await edit.executor(editBeta, new AbortController().signal);
    assert.equal(betaResult.metadata.advanced_from_authored_state, true);
    assert.equal(await readFile(join(item.root, 'result.txt'), 'utf8'), 'ALPHA BETA gamma');

    const stale = await item.registry.seal({
      providerCallId: 'external-drift', name: 'fs.edit_text',
      args: { path: 'result.txt', old_text: 'gamma', new_text: 'GAMMA' },
    }, context);
    await writeFile(join(item.root, 'result.txt'), 'external replacement', 'utf8');
    await assert.rejects(edit.executor(stale, new AbortController().signal), { code: 'tool_revalidation_drift' });
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
