// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScratchSync } from './scratch.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { ExperienceEngine as InteractiveWorkspace } from '../src/experience-engine.js';
import { TuiProjection } from '../src/experience/projection.js';

function fixture(root) {
  return resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    providers: [
      { id: 'big', endpoint: 'http://127.0.0.1:1/v1', model: 'glm', trust_zone: 'loopback' },
      { id: 'fast', endpoint: 'http://127.0.0.1:2/v1', model: 'qwen', trust_zone: 'loopback' },
    ],
  });
}

async function workspace(t, name) {
  const root = createScratchSync(name);
  t.after(async () => { /* scratch roots are removed by the harness */ });
  const configPath = join(root, 'manifest.json');
  const projection = new TuiProjection();
  const engine = new InteractiveWorkspace({
    config: fixture(root), projection, configPath, initializeManifest: true,
    storeRoot: join(root, 'sessions'), reviewerRoot: join(root, 'reviewers'),
    providerFactory: () => ({ async *stream() { yield { type: 'terminal' }; } }),
  });
  const main = await engine.create('Main', 'main');
  const other = await engine.create('Other', 'other');
  return { root, configPath, projection, engine, main, other };
}

test('a model pick in Main becomes the workspace default', async (t) => {
  const f = await workspace(t, 'nna-model-default-');
  f.projection.activate(f.main);
  const result = await f.engine.selectRoute('fast', 'qwen-2');
  assert.equal(result.scope, 'workspace_default');
  assert.equal(f.engine.config.routes.primary.providerId, 'fast');
  assert.equal(f.engine.config.routes.primary.model, 'qwen-2');
  // Why: the default is stored, so a later conversation copies it.
  const saved = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(saved.routes.primary.model, 'qwen-2');
  await f.engine.shutdown();
});

test('a model pick outside Main stays conversation-scoped', async (t) => {
  const f = await workspace(t, 'nna-model-conversation-');
  f.projection.activate(f.other);
  const result = await f.engine.selectRoute('fast', 'qwen-2');
  assert.equal(result.scope, 'conversation');
  assert.equal(f.projection.sessions.get(f.other).metadata.model, 'qwen-2');
  // Why: the workspace default is unchanged, so a new conversation starts from glm.
  assert.equal(f.engine.config.routes.primary.model, 'glm');
  await f.engine.shutdown();
});

test('a pick names the connection and the model together', async (t) => {
  const f = await workspace(t, 'nna-model-pair-');
  f.projection.activate(f.main);
  await f.engine.selectRoute('fast', 'qwen-2');
  const route = f.engine.activeConfig().routes.primary;
  assert.equal(route.providerId, 'fast');
  assert.equal(route.model, 'qwen-2');
  // Why: the same model name on another connection resolves to that connection's endpoint.
  await f.engine.selectRoute('big', 'qwen-2');
  const moved = f.engine.activeConfig().connectionRecords[f.engine.activeConfig().routes.primary.providerId];
  assert.equal(moved.endpoint, 'http://127.0.0.1:1/v1');
  await assert.rejects(f.engine.selectRoute('missing', 'x'), { code: 'provider_missing' });
  await assert.rejects(f.engine.selectRoute('big', ''), { code: 'invalid_model' });
  await f.engine.shutdown();
});
