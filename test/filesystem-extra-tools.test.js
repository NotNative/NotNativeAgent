// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesystemExtraDefinitions } from '../src/filesystem-extra-tools.js';
import { PathPolicy } from '../src/path-policy.js';

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-fs-extra-'));
  await writeFile(join(root, 'source.txt'), 'original');
  const paths = new PathPolicy(root, options); await paths.initialize();
  return { root, definitions: new Map(filesystemExtraDefinitions(paths).map((item) => [item.name, item])) };
}

test('root metadata and directory tools may target host paths while hosted tools remain bounded', async () => {
  const { root, definitions } = await fixture();
  const metadata = definitions.get('fs.metadata');
  const inspected = await metadata.validate({ path: 'source.txt' });
  const result = await metadata.executor(inspected, new AbortController().signal);
  assert.match(result.content, /"kind":"file"/u);
  const directory = definitions.get('fs.create_directory');
  const request = await directory.validate({ path: 'generated' });
  await directory.executor(request, new AbortController().signal);
  assert.equal((await stat(join(root, 'generated'))).isDirectory(), true);
  const outside = await mkdtemp(join(tmpdir(), 'nna-fs-directory-outside-'));
  const outsideRequest = await directory.validate({ path: join(outside, 'generated') });
  assert.equal(outsideRequest.resolved.insideWorkspace, false);
  await directory.executor(outsideRequest, new AbortController().signal);
  const hosted = await fixture({ boundedToWorkspace: true });
  await assert.rejects(hosted.definitions.get('fs.create_directory').validate({ path: join(outside, 'hosted-denied') }), { code: 'tool_scope_denied' });
});

test('copy and move require exact source state and a new destination', async () => {
  const { root, definitions } = await fixture();
  const hash = createHash('sha256').update('original').digest('hex');
  const copy = definitions.get('fs.copy_file');
  const copyRequest = await copy.validate({ source: 'source.txt', destination: 'copy.txt', expected_sha256: hash });
  await copy.executor(copyRequest, new AbortController().signal);
  assert.equal(await readFile(join(root, 'copy.txt'), 'utf8'), 'original');
  await assert.rejects(copy.validate({ source: 'source.txt', destination: 'copy.txt', expected_sha256: hash }), { code: 'tool_target_exists' });
  const move = definitions.get('fs.move_file');
  const moveRequest = await move.validate({ source: 'source.txt', destination: 'moved.txt', expected_sha256: hash });
  await writeFile(join(root, 'source.txt'), 'changed');
  await assert.rejects(move.executor(moveRequest, new AbortController().signal), { code: 'tool_revalidation_drift' });
});

test('device paths remain forbidden while symlinks use their resolved host target and hosted ceiling', async (t) => {
  const { root, definitions } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'nna-fs-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'outside');
  const metadata = definitions.get('fs.metadata');
  const external = await metadata.validate({ path: join(outside, 'secret.txt') });
  assert.equal(external.resolved.insideWorkspace, false);
  for (const path of ['CON', 'aux.txt', 'folder/NUL.log', 'trailing.']) {
    await assert.rejects(metadata.validate({ path }), { code: 'tool_path_reserved' });
  }
  try {
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    const escaped = await metadata.validate({ path: 'escape.txt' });
    assert.equal(escaped.resolved.insideWorkspace, false);
    const hosted = await fixture({ boundedToWorkspace: true });
    await symlink(join(outside, 'secret.txt'), join(hosted.root, 'escape.txt'));
    await assert.rejects(hosted.definitions.get('fs.metadata').validate({ path: 'escape.txt' }), { code: 'tool_scope_denied' });
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.diagnostic('native symlink assertion unavailable without Windows create-symbolic-link privilege');
  }
});
