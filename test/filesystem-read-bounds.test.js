// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationWork } from '../src/conversation-work.js';
import { ToolRegistry } from '../src/tool-registry.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nna-read-bound-'));
  const registry = new ToolRegistry(root, { boundedToWorkspace: true, conversationWork: new ConversationWork() });
  await registry.initialize();
  return { root, registry, async close() { await registry.close(); await rm(root, { recursive: true, force: true }); } };
}

const line = (index) => `export const value${index} = ${index};\n`;

test('a file within the repository size discipline is returned complete', async () => {
  const item = await fixture();
  try {
    const body = Array.from({ length: 500 }, (_, index) => line(index)).join('');
    await writeFile(join(item.root, 'gate-sized.js'), body);
    const read = item.registry.definition('fs_read');
    const request = await read.validate({ path: 'gate-sized.js' });
    const result = await read.executor(request, new AbortController().signal);
    assert.equal(result.content, body, 'a 500-line file arrives whole, with no notice');
    assert.equal(result.metadata.full, undefined, 'the complete path reports no window metadata');
  } finally { await item.close(); }
});

test('a file beyond the size discipline returns one window with a cursor', async () => {
  const item = await fixture();
  try {
    const body = Array.from({ length: 3_631 }, (_, index) => line(index)).join('');
    await writeFile(join(item.root, 'large.md'), body);
    const read = item.registry.definition('fs_read');
    const request = await read.validate({ path: 'large.md' });
    assert.equal(request.resolved.readMode, 'full', 'the request shape stays a complete read');
    const result = await read.executor(request, new AbortController().signal);
    assert.equal(result.metadata.full, false);
    assert.equal(result.metadata.total_lines, 3_631);
    assert.equal(result.metadata.end_line, 400);
    assert.equal(result.metadata.next_start_line, 401);
    assert.match(result.content, /File is 3631 lines; showing 1-400/u);
    assert.match(result.content, /Prefer fs_search_text/u);
    assert.ok(result.content.length < body.length / 4, 'the response is bounded, not the whole file');
  } finally { await item.close(); }
});

test('a windowed default read still covers the range it showed for a later edit', async () => {
  const item = await fixture();
  try {
    const body = Array.from({ length: 900 }, (_, index) => line(index)).join('');
    await writeFile(join(item.root, 'editable.js'), body);
    const read = item.registry.definition('fs_read');
    const request = await read.validate({ path: 'editable.js' });
    const result = await read.executor(request, new AbortController().signal);
    assert.equal(result.metadata.end_line, 400);
    // The receipt exists and names the shown range, so an edit inside it is admissible.
    assert.match(result.content, /snapshot sha256:[0-9a-f]{64} lines 1-400 of 900/u);
    assert.equal(typeof result.metadata.read_receipt, 'string');
  } finally { await item.close(); }
});

test('an empty file is complete rather than windowed', async () => {
  const item = await fixture();
  try {
    await writeFile(join(item.root, 'empty.txt'), '');
    const read = item.registry.definition('fs_read');
    const request = await read.validate({ path: 'empty.txt' });
    const result = await read.executor(request, new AbortController().signal);
    assert.equal(result.content, '');
  } finally { await item.close(); }
});
