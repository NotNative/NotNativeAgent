// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const source = (name) => readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');

async function fixture(name, content, spaced = false) {
  const root = await mkdtemp(join(tmpdir(), spaced ? 'nna gate % space-' : 'nna-gate-'));
  await mkdir(join(root, 'scripts')); await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'scripts', name), content);
  if (name === 'quality-gates.js') {
    await writeFile(join(root, 'scripts', 'quality-source-files.js'), await source('quality-source-files.js'));
  }
  return root;
}

test('quality gate resolves encoded paths and counts newline-terminated source accurately', async () => {
  for (const spaced of [false, true]) {
    const root = await fixture('quality-gates.js', await source('quality-gates.js'), spaced);
    try {
      await writeFile(join(root, 'src', 'file.js'), '// SPDX-License-Identifier: Apache-2.0\n' + '// line\n'.repeat(499));
      for (const name of ['repository-graph.js', 'controlled-language-gates.js']) await writeFile(join(root, 'scripts', name), '');
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'quality-gates.js')], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('quality function scanner does not identify control statements as functions', async () => {
  const text = await source('quality-gates.js');
  const scanner = vm.runInNewContext(`${text.slice(text.indexOf('function functionSpans('))}\nfunctionSpans`);
  for (const header of ['if (true) {', 'for (;;) {', 'while (true) {', 'switch (1) {', 'catch (error) {']) {
    assert.equal(scanner([header, ...Array(65).fill(''), '}']).length, 0);
  }
  assert.equal(scanner(['function actual() {', ...Array(65).fill(''), '}'])[0].length, 67);
});

test('benchmark uses its own entry point and actually exercises record eviction', async () => {
  const root = await fixture('benchmark.js', await source('benchmark.js'));
  try {
    await mkdir(join(root, 'src', 'experience'));
    await writeFile(join(root, 'src', 'cli.js'), '');
    const projection = new URL('../src/experience/projection.js', import.meta.url).href;
    await writeFile(join(root, 'src', 'experience', 'projection.js'), `export { TuiProjection } from ${JSON.stringify(projection)};`);
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'benchmark.js')], { cwd: tmpdir(), encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).projection_retained_records, 512);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('build subprocess failures expose spawn error and signal rather than null diagnostics', async () => {
  for (const script of ['benchmark.js', 'quality-gates.js']) {
    for (const failure of [{ error: { code: 'EACCES', message: 'denied fixture' } }, { signal: 'SIGTERM' }]) {
      const root = await fixture(script, await source(script));
      try {
        await mkdir(join(root, 'src', 'experience'));
        await writeFile(join(root, 'src', 'experience', 'projection.js'), 'export class TuiProjection {}');
        await writeFile(join(root, 'src', 'file.js'), '// SPDX-License-Identifier: Apache-2.0\n');
        const preload = join(root, 'preload.mjs');
        await writeFile(preload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module'; cp.spawnSync = () => (${JSON.stringify({ status: null, stderr: null, ...failure })}); syncBuiltinESMExports();`);
        const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(root, 'scripts', script)], { encoding: 'utf8' });
        assert.equal(result.status, 1); assert.match(result.stderr, failure.signal ? /SIGTERM/u : /EACCES|denied fixture/u);
        assert.doesNotMatch(result.stderr, /reading 'trim'/u);
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
});

test('release scan failure cannot return a partial file list for sealing', async () => {
  const text = await source('release-gates.js');
  const collect = vm.runInNewContext(`${text.slice(text.indexOf('async function collect('), text.indexOf('function releaseEligible('))}\ncollect`, {
    readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    errors: [], relative: (_root, directory) => directory, root: '/root',
  });
  await assert.rejects(collect('/denied'), /release file scan failed.*EACCES/u);
});

test('a conflicting release seal blocks hash rewriting even when other gates fail', async () => {
  const text = await source('release-gates.js');
  const errors = [];
  const verifySource = text.slice(text.indexOf('async function verifyVersionLedger('), text.indexOf('async function candidateDigest('));
  const verify = vm.runInNewContext(`${verifySource}\nverifyVersionLedger`, {
    versionLedger: { schema_version: 1, releases: [{ version: '20261022-17', content_sha256: 'a'.repeat(64) }] },
    candidateDigest: async () => 'b'.repeat(64), releaseVersion: '20261022-17', errors,
    writeFile: async () => assert.fail('conflicting seal must not be replaced'), join: () => 'ledger', root: '/',
  });
  assert.equal(await verify(false), false);
  assert.match(errors.join(' '), /already sealed with different content/u);

  const orchestration = text.slice(text.indexOf('async function finishReleaseHashes('), text.indexOf('function verifyDependencies()'));
  const writes = [];
  const finish = vm.runInNewContext(`${orchestration}\nfinishReleaseHashes`, {
    verifyVersionLedger: async () => false, writeHashes: async () => writes.push('hashes'),
    verifyReleaseHashes: async () => writes.push('verify'),
  });
  await finish(true, 1);
  assert.deepEqual(writes, []);
});

test('duplicate historical seals cannot hide a conflicting current-version seal', async () => {
  const text = await source('release-gates.js');
  const verifySource = text.slice(text.indexOf('async function verifyVersionLedger('), text.indexOf('async function candidateDigest('));
  const errors = [];
  const verify = vm.runInNewContext(`${verifySource}\nverifyVersionLedger`, {
    versionLedger: { schema_version: 1, releases: [
      { version: '20261022-17', content_sha256: 'a'.repeat(64) },
      { version: '20261022-17', content_sha256: 'b'.repeat(64) },
    ] },
    candidateDigest: async () => 'a'.repeat(64), releaseVersion: '20261022-17', errors,
    writeFile: async () => assert.fail('duplicate seal must not be recorded'), join: () => 'ledger', root: '/',
  });
  assert.equal(await verify(false, false), false);
  assert.match(errors.join(' '), /duplicate seal/u);
});

test('release hash refresh remains possible with unrelated gate errors and stable path order', async () => {
  const text = await source('release-gates.js');
  const orchestration = text.slice(text.indexOf('async function finishReleaseHashes('), text.indexOf('function verifyDependencies()'));
  const calls = [];
  const finish = vm.runInNewContext(`${orchestration}\nfinishReleaseHashes`, {
    verifyVersionLedger: async (...args) => { calls.push(args); return true; },
    writeHashes: async () => calls.push('hashes'), verifyReleaseHashes: async () => assert.fail('write mode'),
  });
  await finish(true, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [[false, false], 'hashes']);

  const digestSource = text.slice(text.indexOf('async function candidateDigest('), text.indexOf('async function collect('));
  const order = [];
  const candidateDigest = vm.runInNewContext(`${digestSource}\ncandidateDigest`, {
    collect: async () => ['a', 'A'], root: '/', relative: (_root, path) => path,
    releaseEligible: () => true, readFile: async () => 'bytes',
    createHash: () => ({ update(value) { if (value === 'a' || value === 'A') order.push(value); return this; }, digest: () => 'digest' }),
  });
  assert.equal(await candidateDigest(), 'digest');
  assert.deepEqual(order, ['A', 'a']);
});
