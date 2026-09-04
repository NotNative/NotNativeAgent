// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeToolReasonCode } from '../src/tools/reason-code.js';
import { schemaShapeValidator } from '../src/tools/schema.js';
import { replaceText } from '../src/tools/text-edit-helpers.js';
import { withPreparedWriteTarget } from '../src/tools/write-target.js';
import { createZip } from '../src/zip-archive.js';
import { subagentDefinition } from '../src/subagent-tool.js';

test('reason codes terminate cycles and do not execute code getters', () => {
  const circular = {}; circular.code = circular;
  assert.equal(normalizeToolReasonCode(circular, 'tool_failed'), 'tool_failed');
  assert.equal(normalizeToolReasonCode({ get code() { throw new Error('getter'); } }, 'tool_failed'), 'tool_failed');
  assert.equal(normalizeToolReasonCode({ code: { code: 'ENOENT' } }, 'tool_failed'), 'tool_target_not_found');
});

test('empty-string keys are checked at top-level and nested schema boundaries', async () => {
  for (const nested of [false, true]) {
    for (const missing of [false, true]) {
      const rule = { type: 'object', properties: missing ? { '': { type: 'number' } } : {},
        required: missing ? [''] : [], additionalProperties: false };
      const schema = nested ? { type: 'object', properties: { child: rule } } : rule;
      const value = missing ? {} : { '': 1 };
      await assert.rejects(schemaShapeValidator(schema)(nested ? { child: value } : value), { code: 'tool_schema_invalid' });
    }
  }
});

test('numeric schemas reject nonfinite values and unsupported constraints at admission', async () => {
  const validate = schemaShapeValidator({ type: 'object', properties: { n: { type: 'number' } } });
  for (const n of [NaN, Infinity, -Infinity]) await assert.rejects(validate({ n }), { code: 'tool_schema_invalid' });
  for (const keyword of ['exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    assert.throws(() => schemaShapeValidator({ type: 'object', properties: { n: { type: 'number', [keyword]: 2 } } }),
      { code: 'invalid_external_schema' });
  }
});

test('empty search is rejected without blocking the event loop', () => {
  const module = new URL('../src/tools/text-edit-helpers.js', import.meta.url).href;
  const code = `import { countOccurrences } from ${JSON.stringify(module)}; try { countOccurrences('abc', ''); process.exit(2); } catch (error) { process.exit(error.code === 'tool_schema_invalid' ? 0 : 3); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 2000 });
  assert.equal(child.status, 0, child.error?.message);
});

test('replacement text is literal in both modes and empty needles are rejected', () => {
  for (const all of [false, true]) {
    assert.equal(replaceText('before target after', 'target', "$& $$ $'", all), "before $& $$ $' after");
    assert.throws(() => replaceText('abc', '', 'x', all), { code: 'tool_schema_invalid' });
  }
});

test('completed write preparation does not roll back after invalid executor receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-write-receipt-'));
  const path = join(root, 'new', 'file');
  try {
    await assert.rejects(withPreparedWriteTarget({ resolveWrite: async () => ({ path }) },
      { resolved: { path }, args: { path } }, new AbortController().signal, async () => null), { code: 'tool_result_invalid' });
    await access(join(root, 'new'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('zip validates payload types and input bounds before later work', () => {
  for (const content of [undefined, null, 42, {}, new Uint8Array([1])]) {
    assert.throws(() => createZip([{ name: 'test.txt', content }]), { code: 'zip_entry_invalid' });
  }
  assert.throws(() => createZip([{ name: 'large.txt', content: Buffer.alloc(16_777_217) }, null]),
    { code: 'zip_input_too_large' });
  assert.ok(createZip([{ name: 'empty.txt', content: '' }]).length > 0);
});

test('subagent normalization preserves repeated accounting input without circular markers', async () => {
  const shared = { attempts: 2, measured_total_tokens: 3 };
  const definition = subagentDefinition({ workspaceRoot: '.', run: async () => ({ session_id: 'child', outcome: 'completed',
    token_accounting: { attempts: 2, by_role: { primary: shared, reviewer: shared } } }) });
  const result = await definition.executor({ args: { type: 'general' } }, new AbortController().signal);
  const decoded = JSON.parse(result.content);
  assert.deepEqual(decoded.token_accounting.by_role.primary, decoded.token_accounting.by_role.reviewer);
  assert.equal(decoded.token_accounting.by_role.primary.attempts, 2);
  assert.equal(result.content.includes('[circular]'), false);
});
