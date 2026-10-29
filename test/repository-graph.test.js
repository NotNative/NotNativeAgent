// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildRepositoryGraph, classify, graphFreshness, renderDocument } from '../scripts/repository-graph.js';

const root = resolve(import.meta.dirname, '..');

test('repository graph classifies authoritative engine ownership before fallback modules', () => {
  assert.equal(classify('engine/active.js'), 'agentic-engine');
  assert.equal(classify('governance/reviewer.js'), 'governance-engine');
  assert.equal(classify('experience/tool-lifecycle.js'), 'experience-engine');
  assert.equal(classify('reliability/context-budget.js'), 'reliability-engine');
  assert.equal(classify('desktop-engine-host.js'), 'integrations');
  assert.equal(classify('desktop-configuration-routes.js'), 'integrations');
  assert.equal(classify('secret-broker.js'), 'integrations');
  assert.equal(classify('secret-broker-server.js'), 'integrations');
  assert.equal(classify('subagent-runtime.js'), 'integrations');
  assert.equal(classify('subagent-tool.js'), 'tools');
  assert.equal(classify('config.js'), 'foundation');
});

test('graph check bootstraps only a wholly absent artifact pair', () => {
  assert.equal(graphFreshness(null, null, 'json', 'document'), 'bootstrap');
  assert.equal(graphFreshness('json', 'document', 'json', 'document'), 'current');
  for (const [currentJson, currentDocument] of [
    [null, 'document'], ['json', null], [null, 'stale'], ['stale', null],
    ['stale', 'document'], ['json', 'stale'],
  ]) {
    assert.equal(graphFreshness(currentJson, currentDocument, 'json', 'document'), 'stale');
  }
});

test('repository graph is deterministic and relative; generated artifact drift is checked', async () => {
  const graph = await buildRepositoryGraph(root);
  assert.ok(graph.counts.modules > 0);
  assert.ok(graph.component_edges.length > 0);
  assert.ok(graph.modules.every((item) => item.path.startsWith('src/') && !/^[A-Za-z]:|\\/u.test(item.path)));
  assert.ok(graph.modules.every((item) => item.imports.every((path) => path.startsWith('src/'))));
  // Invariant: a partial local-only artifact pair is stale, not a fresh checkout.
  let committed; let document;
  try {
    committed = JSON.parse(await readFile(join(root, 'docs', 'architecture', 'repository-graph.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') committed = null;
    else throw error;
  }
  try {
    document = await readFile(join(root, 'docs', 'architecture', 'repository-graph.md'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') document = null;
    else throw error;
  }
  if (committed === null && document === null) return; // fresh checkout; graph:check bootstraps
  assert.notEqual(committed, null, 'repository-graph.json is missing');
  assert.notEqual(document, null, 'repository-graph.md is missing');
  assert.deepEqual(committed, graph);
  assert.equal(document, renderDocument(graph));
});
