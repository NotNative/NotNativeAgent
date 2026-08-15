// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolRegistry } from '../src/tool-registry.js';
import { ReferenceStore } from '../src/tools/reference-store.js';

const context = {
  policyVersion: 1, authority: { id: 'authority', version: 1, restrictionVersion: 0 },
  stepId: 'step', caller: 'primary', surface: 'test',
};

test('reference binding preserves untouched arguments and clear releases stored references', () => {
  const store = new ReferenceStore();
  const args = { path: 'ordinary.txt', nested: { value: true } };
  assert.equal(store.bindArguments(args).args, args);
  const entry = store.remember('draft', 'temporary');
  store.clear();
  assert.throws(() => store.resolve(entry.id), { code: 'reference_missing' });
});

test('filesystem observations expose typed path and snapshot references for exact reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reference-file-'));
  await writeFile(join(root, 'observed.txt'), 'observed value', 'utf8');
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const read = registry.definition('fs.read_text');
  const first = await read.executor(await read.validate({ path: 'observed.txt' }), new AbortController().signal);
  assert.match(first.metadata.path_ref, /^nna_ref_path_/u);
  assert.match(first.metadata.snapshot_ref, /^nna_ref_snapshot_/u);
  const rebound = await registry.seal({
    providerCallId: 'read-by-ref', name: 'fs.read_text', args: { path: first.metadata.path_ref },
  }, context);
  assert.equal(rebound.args.path, join(root, 'observed.txt'));
  assert.deepEqual(rebound.resolved.referenceBindings, [{
    field: 'path', reference: first.metadata.path_ref, kind: 'path', source: 'filesystem_observation',
  }]);
});

test('ephemeral drafts retain exact values while inspection exposes metadata only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reference-draft-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const store = registry.definition('ref.store');
  const stored = await store.executor(
    await store.validate({ kind: 'draft', value: 'exact multiline\ndraft' }),
    new AbortController().signal,
  );
  const reference = JSON.parse(stored.content).reference;
  assert.match(reference, /^nna_ref_draft_/u);
  const inspect = registry.definition('ref.inspect');
  const inspected = await inspect.executor(await inspect.validate({ reference }), new AbortController().signal);
  assert.equal(JSON.parse(inspected.content).kind, 'draft');
  assert.doesNotMatch(inspected.content, /exact multiline/u);
});

test('typed bindings fail clearly when a reference kind is used in the wrong field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-reference-kind-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const store = registry.definition('ref.store');
  const stored = await store.executor(
    await store.validate({ kind: 'url', value: 'https://example.com/docs' }),
    new AbortController().signal,
  );
  const reference = JSON.parse(stored.content).reference;
  await assert.rejects(registry.seal({
    providerCallId: 'wrong-kind', name: 'fs.read_text', args: { path: reference },
  }, context), {
    code: 'reference_kind_mismatch', message: 'reference must identify path; received url',
  });
  const fetched = await registry.seal({
    providerCallId: 'url-kind', name: 'web.fetch', args: { url: reference },
  }, context);
  assert.equal(fetched.args.url, 'https://example.com/docs');
  assert.equal(fetched.resolved.referenceBindings[0].reference, reference);
});
