// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { resolveConfiguration } from '../src/configuration-sources.js';
import { persistManifest, withRuntimeLimits, withRouteSetting, withUpdatedProvider } from '../src/provider/route-configuration.js';
import { configurationIntent, intentChanges, applyIntentChanges } from '../src/experience/configuration-intents.js';
import { prepareWorkspaceSource } from '../src/experience/configuration-source.js';
import { publishWorkspaceConfiguration } from '../src/experience/configuration-publication.js';

const provider = { endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };
async function fixture(t, raw = { provider }) {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), '.nna-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'manifest.json'), bytes = JSON.stringify(raw) + '\n';
  await writeFile(path, bytes);
  const source = { name: 'user', path, manifest: raw, revision: createHash('sha256').update(bytes).digest('hex') };
  return { root, path, source, config: resolveManifest({ provider, ...raw }), options: { configPath: path, persistedSource: source, sourceSnapshots: [source] } };
}

test('provider field intent preserves singular raw form and omits compiled defaults', () => {
  const raw = { provider, memory: { enabled: false } }, config = resolveManifest(raw);
  const next = withUpdatedProvider(config, 'manifest-primary', { model: 'updated' });
  const result = applyIntentChanges(raw, intentChanges(config, next.manifest, configurationIntent('provider')));
  assert.deepEqual(result.provider, { ...provider, model: 'updated' });
  assert.equal(result.providers, undefined);
  assert.equal(result.provider_timeout_ms, undefined);
  assert.deepEqual(result.memory, raw.memory);
});

test('source-less existing-file save fails before writing; custom writer has two arguments and no file read', async (t) => {
  const workspace = await fixture(t), original = await readFile(workspace.path, 'utf8');
  delete workspace.options.persistedSource; delete workspace.options.sourceSnapshots;
  const next = withRuntimeLimits(workspace.config, { providerMs: 30000 });
  assert.throws(() => prepareWorkspaceSource(workspace, next, configurationIntent('limits', { providerMs: 30000 })), { code: 'configuration_source_required' });
  assert.equal(await readFile(workspace.path, 'utf8'), original);
  workspace.options.initializeManifest = true;
  await assert.rejects(publishWorkspaceConfiguration(workspace, [], next, configurationIntent('limits', { providerMs: 30000 })), { code: 'manifest_revision_conflict' });
  assert.equal(await readFile(workspace.path, 'utf8'), original);
  let args;
  workspace.options = { configPath: '\u0000not-a-file', manifestWriter: async (...values) => { args = values; } };
  await publishWorkspaceConfiguration(workspace, [], next);
  assert.equal(args.length, 2); assert.equal(args[0], '\u0000not-a-file');
  assert.equal(args[1].provider_timeout_ms, 30000);
});

test('higher project and launch ownership reject only relevant persistent changes', async (t) => {
  const workspace = await fixture(t);
  workspace.options.sourceSnapshots.push({ name: 'project', manifest: { provider_timeout_ms: 50000 } });
  assert.throws(() => prepareWorkspaceSource(workspace, withRuntimeLimits(workspace.config, { providerMs: 30000 }), configurationIntent('limits', { providerMs: 30000 })), { code: 'configuration_source_shadowed' });
  workspace.options.configurationLaunchOverrides = { ephemeral: true };
  assert.doesNotThrow(() => prepareWorkspaceSource(workspace, withRuntimeLimits(workspace.config, { connectMs: 3000 }), configurationIntent('limits', { connectMs: 3000 })));
  assert.throws(() => prepareWorkspaceSource(workspace, withRouteSetting(workspace.config, 'primary', 'temperature', 0.3), configurationIntent('route', { role: 'primary', setting: 'temperature' })), { code: 'configuration_source_shadowed' });
});

test('explicit reset reveals lower source and saves only selected raw override', async (t) => {
  const workspace = await fixture(t, { provider_timeout_ms: 40000 });
  workspace.source.name = 'explicit';
  workspace.options.sourceSnapshots = [{ name: 'user', manifest: { provider, provider_timeout_ms: 50000 } }, workspace.source];
  workspace.config = resolveConfiguration(workspace.options.sourceSnapshots).config;
  const next = withRuntimeLimits(workspace.config, { providerMs: null });
  const session = { engine: { config: workspace.config, state: { state: 'running' }, async output() {} } };
  await publishWorkspaceConfiguration(workspace, [{ session, manifest: next.manifest }], next, configurationIntent('limits', { providerMs: null }));
  assert.deepEqual(JSON.parse(await readFile(workspace.path, 'utf8')), {});
  assert.equal(workspace.config.limits.providerMs, 50000);
  assert.equal(session.engine.pendingConfig.limits.providerMs, 50000);
  assert.equal(workspace.options.persistedSource.manifest.provider, undefined);
});

test('stale TUI revision cannot overwrite another durable writer', async (t) => {
  const workspace = await fixture(t);
  await writeFile(workspace.path, JSON.stringify({ provider, provider_timeout_ms: 60000 }));
  const next = withRuntimeLimits(workspace.config, { providerMs: 30000 });
  await assert.rejects(publishWorkspaceConfiguration(workspace, [], next, configurationIntent('limits', { providerMs: 30000 })), { code: 'manifest_revision_conflict' });
  assert.equal(JSON.parse(await readFile(workspace.path, 'utf8')).provider_timeout_ms, 60000);
});

test('explicit selection of the user file edits and resets every snapshot of that same source', async (t) => {
  const workspace = await fixture(t, { provider, provider_timeout_ms: 40000 });
  const explicit = { ...workspace.source, name: 'explicit' };
  workspace.options.persistedSource = explicit;
  workspace.options.sourceSnapshots = [workspace.source, { name: 'project', manifest: { provider_timeout_ms: 50000 } }, explicit];
  workspace.config = resolveConfiguration(workspace.options.sourceSnapshots).config;
  const intent = configurationIntent('limits', { providerMs: 30000 });
  await publishWorkspaceConfiguration(workspace, [], withRuntimeLimits(workspace.config, { providerMs: 30000 }), intent);
  assert.equal(workspace.config.limits.providerMs, 30000);
  const reset = configurationIntent('limits', { providerMs: null });
  await publishWorkspaceConfiguration(workspace, [], withRuntimeLimits(workspace.config, { providerMs: null }), reset);
  assert.deepEqual(JSON.parse(await readFile(workspace.path, 'utf8')), { provider });
  assert.equal(workspace.config.limits.providerMs, 50000);
  for (const source of workspace.options.sourceSnapshots.filter((item) => item.path === workspace.path)) {
    assert.deepEqual(source.manifest, { provider });
    assert.equal(source.revision, workspace.options.persistedSource.revision);
  }
});

test('saved runtime failure advances revision and next edit preserves saved data', async (t) => {
  const workspace = await fixture(t);
  const old = workspace.options.persistedSource.revision;
  const bad = { engine: { config: workspace.config, state: { state: 'running' }, async output() { throw new Error('output unavailable'); } } };
  const good = { engine: { config: workspace.config, state: { state: 'running' }, async output() {} } };
  const next = withRuntimeLimits(workspace.config, { providerMs: 30000 });
  await assert.rejects(publishWorkspaceConfiguration(workspace, [bad, good].map((session) => ({ session, manifest: next.manifest })), next,
    configurationIntent('limits', { providerMs: 30000 })), { code: 'configuration_saved_not_applied' });
  assert.notEqual(workspace.options.persistedSource.revision, old);
  assert.equal(good.engine.pendingConfig.limits.providerMs, 30000);
  await publishWorkspaceConfiguration(workspace, [], withRuntimeLimits(workspace.config, { connectMs: 3000 }), configurationIntent('limits', { connectMs: 3000 }));
  const saved = JSON.parse(await readFile(workspace.path, 'utf8'));
  assert.equal(saved.provider_timeout_ms, 30000); assert.equal(saved.provider_connect_timeout_ms, 3000);
  assert.deepEqual(Object.keys(saved).sort(), ['provider', 'provider_connect_timeout_ms', 'provider_timeout_ms']);
});

test('unrelated save preserves an ephemeral launch provider without persisting it', async (t) => {
  const { applyLaunchProviderOverrides } = await import('../src/provider/launch-overrides.js');
  const workspace = await fixture(t);
  workspace.config = applyLaunchProviderOverrides(workspace.config, { providerEndpoint: 'http://127.0.0.1:99/v1', model: 'temporary' });
  workspace.options.configurationLaunchOverrides = workspace.config.launchOverrides;
  await publishWorkspaceConfiguration(workspace, [], withRuntimeLimits(workspace.config, { connectMs: 3000 }), configurationIntent('limits', { connectMs: 3000 }));
  assert.equal(workspace.config.routes.primary.model, 'temporary');
  assert.equal(workspace.config.launchOverrides.ephemeral, true);
  const saved = JSON.parse(await readFile(workspace.path, 'utf8'));
  assert.deepEqual(saved, { provider, provider_connect_timeout_ms: 3000 });
});

test('compatibility backup refuses a hardlink without overwriting its external target', async (t) => {
  const workspace = await fixture(t);
  const sentinel = join(workspace.root, 'sentinel.txt');
  await writeFile(sentinel, 'keep exact sentinel');
  await link(sentinel, `${workspace.path}.bak`);
  const original = await readFile(workspace.path, 'utf8');
  await assert.rejects(persistManifest(workspace.path, { provider, provider_timeout_ms: 30000 }, { expectedRevision: workspace.source.revision }));
  assert.equal(await readFile(sentinel, 'utf8'), 'keep exact sentinel');
  assert.equal(await readFile(workspace.path, 'utf8'), original);
});
