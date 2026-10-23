// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanIdentifiers } from './controlled-language-gates.js';
import { collectProductionSources } from './source-catalog.js';
import { buildRepositoryGraph } from './repository-graph.js';

test('identifier audit follows code through regexes, templates, and comments', () => {
  const source = [
    `const pattern = /["']/u; expose(pattern);`,
    String.raw`const slash = /[//]/u; expose(slash);`,
    'const template = `text ${expose(value)}`;',
    '// a path ends with a slash\\',
    'expose(value);',
    'const literal = "expose in a string";',
  ].join('\n');
  assert.equal(scanIdentifiers(source, 'fixture.ts').filter((value) => value === 'expose').length, 4);
});

test('identifier audit excludes JSX text while retaining JSX expression code', () => {
  const source = 'const view = <div>expose<span onClick={expose}>expose</span></div>;';
  assert.equal(scanIdentifiers(source, 'fixture.tsx').filter((value) => value === 'expose').length, 1);
});

test('identifier audit rejects malformed production source', () => {
  assert.throws(() => scanIdentifiers('const value = /*/', 'broken.ts'), /broken\.ts/u);
});

test('source catalog and graph exclude script tests but retain JSX production source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nnd-language-sources-'));
  try {
    for (const directory of ['packages/ui/src', 'packages/web/src', 'scripts']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    const scripts = join(root, 'scripts');
    const ui = join(root, 'packages/ui/src');
    await writeFile(join(scripts, 'gate.mjs'), 'export const gate = true;\n');
    await writeFile(join(scripts, 'gate.test.mjs'), 'export const shouldNotScan = true;\n');
    await writeFile(join(ui, 'widget.jsx'), 'export const widget = <div />;\n');
    await writeFile(join(ui, 'widget.test.jsx'), 'export const shouldNotScan = <div />;\n');

    const sources = await collectProductionSources(root);
    assert.deepEqual(sources.map((path) => path.slice(root.length + 1).replaceAll('\\', '/')),
      ['packages/ui/src/widget.jsx', 'scripts/gate.mjs']);
    const graph = await buildRepositoryGraph(root);
    assert.deepEqual(graph.modules.map((item) => item.path),
      ['packages/ui/src/widget.jsx', 'scripts/gate.mjs']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
