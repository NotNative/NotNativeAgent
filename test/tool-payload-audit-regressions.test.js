// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/tool-registry.js';
import { schemaShapeValidator } from '../src/tools/schema.js';

const context = { authority: { id: 'authority', version: 1, restrictionVersion: 0 },
  policyVersion: 1, stepId: 'step', caller: 'primary', surface: 'test' };
test('write overflow identifies byte or character bounds and guides splitting without echoing payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-payload-repair-')); const registry = new ToolRegistry(root);
  try {
    await registry.initialize();
    for (const content of ['x'.repeat(32769), 'é'.repeat(16385)]) {
      await assert.rejects(registry.seal({ name: 'fs_write_text', providerCallId: `large-${content.length}`,
        args: { path: 'large.txt', content } }, context), (error) => {
        assert.equal(error.code, 'tool_schema_invalid');
        assert.match(error.message, /32768/u);
        assert.match(error.message, /Split larger implementations across files or use subsequent anchored edits/u);
        assert.equal(error.message.includes(content.slice(0, 100)), false);
        assert.equal(error.toolMetadata.issue, 'bound_violation');
        return true;
      });
    }
    await assert.rejects(readFile(join(root, 'large.txt')), { code: 'ENOENT' });
  } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
});
test('bounded writes and anchored edits can produce a file larger than one payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-payload-split-')); const registry = new ToolRegistry(root);
  const signal = new AbortController().signal;
  try {
    await registry.initialize();
    const write = await registry.seal({ name: 'fs_write_text', providerCallId: 'write',
      args: { path: 'large.txt', content: `${'a'.repeat(32767)}Z` } }, context);
    await registry.definition('fs_write_text').executor(write, signal);
    const edit = await registry.seal({ name: 'fs_edit_text', providerCallId: 'edit',
      args: { path: 'large.txt', find: 'Z', content: `Z${'b'.repeat(32767)}` } }, context);
    await registry.definition('fs_edit_text').executor(edit, signal);
    assert.equal(Buffer.byteLength(await readFile(join(root, 'large.txt'), 'utf8')), 65535);
  } finally { await registry.close(); await rm(root, { recursive: true, force: true }); }
});
test('payload repair descriptions stay bounded independently of external schema size', async () => {
  const validate = schemaShapeValidator({ type: 'object', additionalProperties: false, required: ['content'],
    properties: { content: { type: 'string', maxUtf8Bytes: 1, description: 'Repair '.repeat(1000) } } });
  await assert.rejects(validate({ content: 'private payload' }), (error) => {
    assert.ok(error.message.length < 400);
    assert.equal(error.message.includes('private payload'), false);
    assert.equal(error.toolMetadata.received, 15);
    return true;
  });
});
