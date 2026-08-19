// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
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
  assert.equal((await glob.validate({ path: '  ', pattern: '**/*.js' })).args.path, '.');

  const listRequest = await registry.definition('fs.list_directory').validate({ path: '', depth: 1 });
  assert.equal(listRequest.args.path, '.');
  assert.match((await registry.definition('fs.list_directory').executor(listRequest, new AbortController().signal)).content, /directory\tsrc/u);

  const search = registry.definition('fs.search_text');
  const searchRequest = await search.validate({ query: 'needle', file_glob: '**/*', max_results: 10 });
  const searchResult = await search.executor(searchRequest, new AbortController().signal);
  assert.match(searchResult.content, /src\/alpha\.js:2:1: Needle here/u);
  assert.match(searchResult.content, /src\/beta\.txt:1:1: needle elsewhere/u);
  assert.doesNotMatch(searchResult.content, /hidden/u);
  assert.equal((await search.validate({ path: '', query: 'needle' })).args.path, '.');

  const regexRequest = await search.validate({ query: 'Needle|elsewhere', match_mode: 'regex', file_glob: '**/*' });
  const regexResult = await search.executor(regexRequest, new AbortController().signal);
  assert.match(regexResult.content, /src\/alpha\.js:2:1: Needle here/u);
  assert.match(regexResult.content, /src\/beta\.txt:1:1: needle elsewhere/u);

  const exactFileRequest = await search.validate({ path: join(root, 'src', 'alpha.js'), query: 'Needle' });
  const exactFileResult = await search.executor(exactFileRequest, new AbortController().signal);
  assert.match(exactFileResult.content, /alpha\.js:2:1: Needle here/u);

  const exactFileWithBroadGlob = await search.validate({
    path: join(root, 'src', 'alpha.js'), query: 'Needle', file_glob: '**/*',
  });
  assert.match((await search.executor(exactFileWithBroadGlob, new AbortController().signal)).content, /Needle here/u);

  const filteredExactFile = await search.validate({
    path: join(root, 'src', 'alpha.js'), query: 'Needle', file_glob: '*.txt',
  });
  const filteredResult = await search.executor(filteredExactFile, new AbortController().signal);
  assert.equal(filteredResult.content, 'no text matches');
  assert.equal(filteredResult.metadata.files_examined, 0);
});

test('filesystem discovery schemas explain path and pattern roles with actionable repair errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-discovery-schema-'));
  const registry = new ToolRegistry(root);
  await registry.initialize();
  const glob = registry.definition('fs.glob');
  const search = registry.definition('fs.search_text');
  assert.match(glob.inputSchema.properties.path.description, /Do not put glob syntax here/u);
  assert.match(glob.inputSchema.properties.pattern.description, /Required glob/u);
  assert.match(search.inputSchema.properties.path.description, /Exact file or root directory/u);
  assert.match(search.inputSchema.properties.query.description, /Required literal text/u);
  assert.match(search.inputSchema.properties.file_glob.description, /exact file/u);
  assert.match(registry.definition('fs.list_directory').purpose, /not an existence probe/u);
  await assert.rejects(registry.definition('fs.list_directory').validate({ path: 'missing-directory' }), {
    code: 'tool_directory_not_found',
    message: /list its parent to discover available names/u,
  });
  await assert.rejects(glob.validate({ path: root }), {
    code: 'tool_schema_invalid', message: 'required argument "pattern" is missing',
  });
  await assert.rejects(search.validate({ path: 'missing.js', query: 'needle' }), {
    code: 'tool_target_not_found', message: 'search path does not exist: missing.js. Use fs.glob to locate it, or omit path to search the working directory',
  });
  await registry.close();
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
    path: 'note.txt', content: 'one\nthree\n',
  });
  await write.executor({ ...writeRequest, toolName: 'fs.write_text' }, new AbortController().signal);

  const diff = registry.diff();
  assert.match(diff, /--- a\/note\.txt/u);
  assert.match(diff, /-two/u);
  assert.match(diff, /\+three/u);
  assert.equal(registry.diff('note.txt'), diff);
});
