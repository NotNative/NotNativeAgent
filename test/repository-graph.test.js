// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildRepositoryGraph, classify, renderDocument } from '../scripts/repository-graph.js';

const root = resolve(import.meta.dirname, '..');

test('repository graph classifies authoritative engine ownership before fallback modules', () => {
  assert.equal(classify('engine/active.js'), 'agentic-engine');
  assert.equal(classify('governance/reviewer.js'), 'governance-engine');
  assert.equal(classify('experience/tool-lifecycle.js'), 'experience-engine');
  assert.equal(classify('reliability/context-budget.js'), 'reliability-engine');
  assert.equal(classify('config.js'), 'foundation');
});

test('committed repository graph is deterministic, relative, and current', async () => {
  const graph = await buildRepositoryGraph(root);
  const committed = JSON.parse(await readFile(join(root, 'docs', 'architecture', 'repository-graph.json'), 'utf8'));
  const document = await readFile(join(root, 'docs', 'architecture', 'repository-graph.md'), 'utf8');
  assert.deepEqual(committed, graph);
  assert.equal(document, renderDocument(graph));
  assert.ok(graph.counts.modules > 0);
  assert.ok(graph.component_edges.length > 0);
  assert.ok(graph.modules.every((item) => item.path.startsWith('src/') && !/^[A-Za-z]:|\\/u.test(item.path)));
  assert.ok(graph.modules.every((item) => item.imports.every((path) => path.startsWith('src/'))));
});
