// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUserDataPaths, userDataPaths } from '../src/product.js';
import { loadEffectiveStartupConfiguration, runtimeHookRoots } from '../src/startup-configuration.js';
import { trustWorkspace, workspaceIsTrusted } from '../src/experience/trust.js';

const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'nna-effective-config-'));
  const workspace = join(home, 'project'); await mkdir(join(workspace, '.nna'), { recursive: true });
  const paths = userDataPaths({ home, environment: {} }); await ensureUserDataPaths(paths);
  await writeFile(join(paths.config, 'manifest.json'), `${JSON.stringify({ persistence: 'durable', provider })}\n`);
  await writeFile(join(workspace, '.nna', 'settings.json'), `${JSON.stringify({ memory: { enabled: false } })}\n`);
  return { paths, workspace, home };
}

test('project configuration is ignored until the exact resolved workspace is trusted', async () => {
  const { paths, workspace } = await fixture();
  const before = await loadEffectiveStartupConfiguration({ paths, workspaceRoot: workspace });
  assert.equal(before.config.memory.enabled, true);
  assert.equal(before.project.trusted, false);
  assert.equal(before.provenance['providers.0.endpoint'], 'user');
  assert.equal(before.provenance.provider_connect_timeout_ms, 'compiled_default');
  assert.equal(before.provenance['routes.primary.temperature'], 'compiled_default');
  assert.deepEqual(runtimeHookRoots(paths, before.project).map((item) => item.scope), ['user']);
  await trustWorkspace(paths.trustedWorkspaces, workspace);
  assert.equal(await workspaceIsTrusted(paths.trustedWorkspaces, workspace), true);
  const trustDocument = JSON.parse(await readFile(paths.trustedWorkspaces, 'utf8'));
  assert.equal(trustDocument.workspaces[0].root, await realpath(workspace));
  const after = await loadEffectiveStartupConfiguration({ paths, workspaceRoot: workspace });
  assert.equal(after.config.memory.enabled, false);
  assert.equal(after.config.workspaceRoot, workspace);
  assert.equal(after.provenance['memory.enabled'], 'project');
  assert.deepEqual(runtimeHookRoots(paths, after.project).map((item) => item.scope), ['user', 'project']);
  assert.equal(runtimeHookRoots(paths, after.project)[1].path, join(workspace, '.nna', 'hooks'));
});

test('workspace trust cannot be granted to a path that does not exist', async () => {
  const { paths, home } = await fixture();
  const missing = join(home, 'not-created');
  await assert.rejects(trustWorkspace(paths.trustedWorkspaces, missing), {
    code: 'workspace_trust_target_missing',
  });
  assert.equal(await workspaceIsTrusted(paths.trustedWorkspaces, missing), false);
});

test('explicit configuration has deterministic precedence above trusted project configuration', async () => {
  const { paths, workspace, home } = await fixture();
  await trustWorkspace(paths.trustedWorkspaces, workspace);
  const explicitPath = join(home, 'run.json');
  await writeFile(explicitPath, `${JSON.stringify({ memory: { enabled: false }, context_limit_bytes: 524288 })}\n`);
  const effective = await loadEffectiveStartupConfiguration({ paths, workspaceRoot: workspace, explicitPath });
  assert.equal(effective.config.memory.enabled, false);
  assert.equal(effective.config.limits.maxContextBytes, 524288);
  assert.equal(effective.provenance['memory.enabled'], 'explicit');
});
