// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolRegistry } from '../src/tool-registry.js';

test('fs.glob and fs.search_text discover bounded files without a platform shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-discovery-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'src', 'alpha.js'), 'first\nNeedle here\n');
  await writeFile(join(root, 'src', 'beta.txt'), 'needle elsewhere\n');
  await writeFile(join(root, 'node_modules', 'hidden.js'), 'needle ignored\n');
  const registry = new ToolRegistry(root);
  await registry.initialize();

  const glob = registry.definition('fs.glob');
  const globRequest = await glob.validate({ pattern: '**/*.js' });
  const globResult = await glob.executor(globRequest, new AbortController().signal);
  assert.equal(globResult.content, 'src/alpha.js');
  assert.equal(globResult.metadata.matches, 1);

  const search = registry.definition('fs.search_text');
  const searchRequest = await search.validate({ query: 'needle', file_glob: '**/*', max_results: 10 });
  const searchResult = await search.executor(searchRequest, new AbortController().signal);
  assert.match(searchResult.content, /src\/alpha\.js:2:1: Needle here/u);
  assert.match(searchResult.content, /src\/beta\.txt:1:1: needle elsewhere/u);
  assert.doesNotMatch(searchResult.content, /hidden/u);

  const regexRequest = await search.validate({ query: 'Needle|elsewhere', match_mode: 'regex', file_glob: '**/*' });
  const regexResult = await search.executor(regexRequest, new AbortController().signal);
  assert.match(regexResult.content, /src\/alpha\.js:2:1: Needle here/u);
  assert.match(regexResult.content, /src\/beta\.txt:1:1: needle elsewhere/u);
});

test('root tools can inspect host paths while hosted tools retain the manifest workspace ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-root-scope-'));
  const sibling = await mkdtemp(join(tmpdir(), 'nna-sibling-scope-'));
  await writeFile(join(sibling, 'outside.txt'), 'host-visible');

  const rootRegistry = new ToolRegistry(root);
  await rootRegistry.initialize();
  const resolved = await rootRegistry.definition('fs.glob').validate({ path: sibling, pattern: '*.txt' });
  assert.equal(resolved.resolved.insideWorkspace, false);
  assert.equal((await rootRegistry.definition('fs.glob').executor(resolved, new AbortController().signal)).content, 'outside.txt');

  const hostedRegistry = new ToolRegistry(root, { boundedToWorkspace: true });
  await hostedRegistry.initialize();
  await assert.rejects(hostedRegistry.definition('fs.glob').validate({ path: sibling, pattern: '*.txt' }), { code: 'tool_scope_denied' });
});

test('file change ledger renders conversation-local changes for /diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-change-ledger-'));
  const path = join(root, 'note.txt');
  const before = 'one\ntwo\n';
  await writeFile(path, before);
  const registry = new ToolRegistry(root);
  await registry.initialize();

  const read = registry.definition('fs.read_text');
  const readRequest = await read.validate({ path: 'note.txt' });
  await read.executor(readRequest, new AbortController().signal);
  const write = registry.definition('fs.write_text');
  const writeRequest = await write.validate({
    path: 'note.txt', content: 'one\nthree\n', expected_sha256: createHash('sha256').update(before).digest('hex'),
  });
  await write.executor({ ...writeRequest, toolName: 'fs.write_text' }, new AbortController().signal);

  const diff = registry.diff();
  assert.match(diff, /--- a\/note\.txt/u);
  assert.match(diff, /-two/u);
  assert.match(diff, /\+three/u);
  assert.equal(registry.diff('note.txt'), diff);
});
