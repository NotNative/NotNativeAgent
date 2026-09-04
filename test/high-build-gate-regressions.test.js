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
