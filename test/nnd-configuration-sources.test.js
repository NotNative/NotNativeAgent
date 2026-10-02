// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNndConfigurationSources, NND_CONFIGURATION_OPTIONS } from '../src/nnd-configuration-sources.js';
import { readNndSetupConfiguration } from '../src/nnd-setup-config.js';
import { resolveConfiguration } from '../src/configuration-sources.js';
import { resolveManifest } from '../src/config.js';
import { readWorkspaceTrustBytes, workspaceIsTrusted } from '../src/experience/trust.js';
import { createIntegrationNndEngineHost } from '../src/integration-cli.js';
import { ProviderProfileStore } from '../src/provider/profile-store.js';

const provider = { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'base', trust_zone: 'loopback' };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-native-config-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const paths = { root, config: join(root, 'config'), trustedWorkspaces: join(root, 'trust.json'),
    sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks') };
  await mkdir(paths.config); await mkdir(join(workspace, '.nna'), { recursive: true });
  const manifest = { provider, workspace_root: workspace, persistence: 'ephemeral' };
  const userPath = join(paths.config, 'manifest.json'), projectPath = join(workspace, '.nna', 'settings.json');
  await writeFile(userPath, JSON.stringify(manifest) + '\n');
  const trust = async (trusted) => writeFile(paths.trustedWorkspaces, JSON.stringify({ version: 1,
    workspaces: trusted ? [{ root: await realpath(workspace), trustedAt: '2026-10-02T00:00:00.000Z' }] : [] }));
  return { paths, workspace, userPath, projectPath, manifest, trust };
}

test('native source read is immutable, byte-revisioned and never writes or migrates legacy input', async (t) => {
  const f = await fixture(t), bytes = await readFile(f.userPath), before = await readdir(f.paths.config);
  const result = await readNndConfigurationSources(f.paths);
  assert.equal(result.persistedSource.revision, digest(bytes));
  assert.deepEqual(result.persistedSource.manifest, f.manifest);
  assert.deepEqual(result.sourceSnapshots.map(({ name }) => name), ['user', 'workspace']);
  assert.equal(result.config.workspaceRoot, f.workspace);
  assert.equal(result.provenance['providers.0.model'], 'user');
  assert.equal(result.project.trusted, false);
  assert.equal(result.project.present, false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.persistedSource.manifest.provider));
  assert.equal((await readNndConfigurationSources(f.paths)).resolutionRevision, result.resolutionRevision);
  assert.deepEqual(await readFile(f.userPath), bytes);
  assert.deepEqual(await readdir(f.paths.config), before);
});

test('trusted project resolution and setup use the same layers; revocation changes the observed result', async (t) => {
  const f = await fixture(t);
  await writeFile(f.projectPath, JSON.stringify({ memory: { enabled: false }, provider_timeout_ms: 2300 }));
  const untrusted = await readNndConfigurationSources(f.paths);
  assert.equal(untrusted.config.memory.enabled, true);
  await f.trust(true);
  const trusted = await readNndConfigurationSources(f.paths);
  assert.equal(trusted.config.memory.enabled, false);
  assert.equal(trusted.provenance['memory.enabled'], 'project');
  assert.equal(trusted.sourceSnapshots[2].revision, digest(await readFile(f.projectPath)));
  assert.deepEqual(await readNndSetupConfiguration(f.paths), trusted.config);
  await f.trust(false);
  const revoked = await readNndConfigurationSources(f.paths);
  assert.equal(revoked.config.memory.enabled, true);
  assert.notEqual(revoked.resolutionRevision, trusted.resolutionRevision);
});

test('missing, invalid and oversized user sources remain unchanged without onboarding', async (t) => {
  const f = await fixture(t);
  await rm(f.userPath);
  await assert.rejects(readNndConfigurationSources(f.paths), { code: 'ENOENT' });
  assert.deepEqual(await readdir(f.paths.config), []);
  for (const bytes of [Buffer.from('{bad'), Buffer.from([0xff]), Buffer.from('[]'), Buffer.from('{}')]) {
    await writeFile(f.userPath, bytes);
    await assert.rejects(readNndConfigurationSources(f.paths), { code: 'nnd_setup_configuration_invalid' });
    assert.deepEqual(await readFile(f.userPath), bytes);
    assert.deepEqual(await readdir(f.paths.config), ['manifest.json']);
  }
  const handle = await open(f.userPath, 'w');
  try { await handle.truncate(2 ** 32); } finally { await handle.close(); }
  await assert.rejects(readNndConfigurationSources(f.paths), { code: 'nnd_setup_configuration_invalid' });
});

test('background workspace is explicit and project overlays cannot select another scope', async (t) => {
  const f = await fixture(t);
  for (const root of [undefined, null, 'relative', f.workspace + '\u0000']) {
    await writeFile(f.userPath, JSON.stringify({ ...f.manifest, workspace_root: root }));
    await assert.rejects(readNndConfigurationSources(f.paths), { code: 'nnd_setup_configuration_invalid' });
  }
  await writeFile(f.userPath, JSON.stringify(f.manifest)); await f.trust(true);
  for (const root of [null, '', 'relative', f.paths.root]) {
    await writeFile(f.projectPath, JSON.stringify({ workspace_root: root }));
    await assert.rejects(readNndConfigurationSources(f.paths), { code: 'project_scope_mismatch' });
  }
});

test('native layered resolver never turns project or source data into hosted authority', async (t) => {
  const f = await fixture(t); await f.trust(true);
  await writeFile(f.projectPath, JSON.stringify({ allowed_capabilities: ['tools'] }));
  await assert.rejects(readNndConfigurationSources(f.paths), { code: 'execution_manifest_forbidden' });
  const sources = [{ name: 'host', manifest: { provider, allowed_capabilities: ['tools'] } }];
  assert.throws(() => resolveConfiguration(sources), { code: 'execution_manifest_forbidden' });
  const manifestOptions = { principal: 'authenticated-stdio-host', executionManifestId: 'fixture-host' };
  assert.deepEqual(resolveConfiguration(sources, { manifestOptions }).config,
    { ...resolveManifest(sources[0].manifest, manifestOptions), configurationProvenance: resolveConfiguration(sources, { manifestOptions }).provenance });
  assert.equal(NND_CONFIGURATION_OPTIONS.principal, 'authenticated-nnd-operator');
});

test('invalid project files are ignored before trust and preserved after trusted rejection', async (t) => {
  const f = await fixture(t); const bytes = '{broken project';
  await writeFile(f.projectPath, bytes);
  await readNndConfigurationSources(f.paths);
  await f.trust(true);
  await assert.rejects(readNndConfigurationSources(f.paths), { code: 'nnd_setup_configuration_invalid' });
  assert.equal(await readFile(f.projectPath, 'utf8'), bytes);
  assert.deepEqual(await readdir(join(f.workspace, '.nna')), ['settings.json']);
});

test('cancelled reads produce no initialization or source writes', async (t) => {
  const f = await fixture(t); const bytes = await readFile(f.userPath);
  const controller = new AbortController(); controller.abort(new Error('cancel native read'));
  await assert.rejects(readNndConfigurationSources(f.paths, { signal: controller.signal }), /cancel native read/u);
  assert.deepEqual(await readFile(f.userPath), bytes);
});

test('trust reader bounds growth after stat and closes its handle without read-side writes', async () => {
  let closed = false, calls = 0;
  const handle = { async stat() { return { size: 1, isFile: () => true }; },
    async read(buffer, offset, length) { calls++; assert.equal(buffer.length, 262145); return { bytesRead: length }; },
    async close() { closed = true; } };
  await assert.rejects(readWorkspaceTrustBytes('fake', async () => handle), { code: 'workspace_trust_invalid' });
  assert.equal(calls, 1); assert.equal(closed, true);
  let read = false;
  await assert.rejects(readWorkspaceTrustBytes('fake', async () => ({
    async stat() { return { size: 262145, isFile: () => true }; },
    async read() { read = true; }, async close() {} })), { code: 'workspace_trust_invalid' });
  assert.equal(read, false);
});

test('oversized and malformed trust files fail closed and retain exact bytes', async (t) => {
  const f = await fixture(t);
  for (const bytes of ['{bad trust', ' '.repeat(262145)]) {
    await writeFile(f.paths.trustedWorkspaces, bytes);
    await assert.rejects(workspaceIsTrusted(f.paths.trustedWorkspaces, f.workspace), { code: 'workspace_trust_invalid' });
    assert.equal(await readFile(f.paths.trustedWorkspaces, 'utf8'), bytes);
  }
});

test('supervised provider reload retains trusted native layers while legacy hosts remain user-only', async (t) => {
  const f = await fixture(t); await f.trust(true);
  await writeFile(f.projectPath, JSON.stringify({ routes: { primary: { model: 'project-initial' } } }));
  const hostOptions = { providerFactory: () => ({ async *stream() {} }) };
  const preparedConfig = await readNndSetupConfiguration(f.paths);
  const supervised = await createIntegrationNndEngineHost(f.paths, { ...hostOptions, preparedConfig });
  const legacy = await createIntegrationNndEngineHost(f.paths, hostOptions);
  const store = new ProviderProfileStore({ configRoot: f.paths.config,
    readEffectiveConfiguration: () => readNndSetupConfiguration(f.paths) });
  t.after(async () => { await supervised.shutdown(); await legacy.shutdown(); });
  assert.equal(supervised.nndModel.modelID, 'project-initial');
  assert.equal(legacy.nndModel.modelID, 'base');
  const initialInventory = await store.inventory(supervised.providerRoutingPending);
  assert.deepEqual(initialInventory.configured_primary_route, supervised.nndModel);
  assert.equal(initialInventory.provider_routing_pending, false);
  await writeFile(f.projectPath, JSON.stringify({ routes: { primary: { model: 'project-updated' } } }));
  assert.equal((await store.inventory(supervised.providerRoutingPending)).provider_routing_pending, true);
  assert.equal((await supervised.activateProviderRoute()).modelID, 'project-updated');
  const appliedInventory = await store.inventory(supervised.providerRoutingPending);
  assert.deepEqual(appliedInventory.configured_primary_route, supervised.nndModel);
  assert.equal(appliedInventory.provider_routing_pending, false);
  assert.equal((await legacy.activateProviderRoute()).modelID, 'base');
  await writeFile(f.projectPath, JSON.stringify({ allowed_capabilities: ['tools'] }));
  await assert.rejects(supervised.activateProviderRoute(), { code: 'execution_manifest_forbidden' });
  assert.equal(supervised.nndModel.modelID, 'project-updated');
  assert.equal((await legacy.activateProviderRoute()).modelID, 'base');
});

test('effective provider reads include project profiles but mutations preserve the raw user document', async (t) => {
  const f = await fixture(t); await f.trust(true);
  const projectProvider = { ...provider, id: 'project', model: 'project-model' };
  const project = { providers: [projectProvider], provider_timeout_ms: 3300 };
  await writeFile(f.projectPath, JSON.stringify(project));
  const store = new ProviderProfileStore({ configRoot: f.paths.config,
    readEffectiveConfiguration: () => readNndSetupConfiguration(f.paths) });
  assert.equal((await store.get('project')).model, 'project-model');
  assert.equal((await store.list())[0].profile_id, 'project');
  assert.equal((await store.subagentRoute()).providerID, 'project');
  await store.update('local', { display_name: 'User profile' });
  const saved = JSON.parse(await readFile(f.userPath, 'utf8'));
  assert.deepEqual(saved, { ...f.manifest, provider: { ...provider, display_name: 'User profile' } });
  assert.equal(saved.provider_timeout_ms, undefined);
  assert.deepEqual(JSON.parse(await readFile(f.projectPath, 'utf8')), project);
  const legacy = new ProviderProfileStore({ configRoot: f.paths.config });
  assert.equal((await legacy.inventory()).configured_primary_route.providerID, 'local');
});
