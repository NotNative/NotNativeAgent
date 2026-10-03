// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createIntegrationNndEngineHost, integrationSecretRealm, runIntegrationCommand, runNndIntegrationCommand } from '../src/integration-cli.js';
import { assertNnoIntegrationActivation, createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { SecretBroker } from '../src/secret-broker.js';
import { LOCAL_SECRET_REALM } from '../src/secret-contracts.js';
import { trustWorkspace } from '../src/experience/trust.js';
import { ProviderProfileStore } from '../src/provider/profile-store.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { nativeNndPrincipal } from '../src/nnd-service-native.js';

test('NND and standalone browser catalogs stay separate even with NND installed', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-browser-surfaces-'));
  const callback = { url: 'http://127.0.0.1:4172/api/browser-control/request', token: 's'.repeat(43) };
  const standalone = new ToolRegistry(root, { nndBrowserCallback: callback });
  const desktop = new ToolRegistry(root, { browserSurface: 'nnd', nndBrowserCallback: callback });
  const desktopWithoutController = new ToolRegistry(root, { browserSurface: 'nnd' });
  await Promise.all([standalone.initialize(), desktop.initialize(), desktopWithoutController.initialize()]);
  try {
    assert.ok(standalone.definition('web_browse'));
    assert.equal(standalone.definition('nnd_browser'), undefined);
    assert.ok(desktop.definition('nnd_browser'));
    assert.equal(desktop.definition('web_browse'), undefined);
    assert.equal(desktopWithoutController.definition('nnd_browser'), undefined);
    assert.equal(desktopWithoutController.definition('web_browse'), undefined);
  } finally {
    await Promise.all([standalone.close(), desktop.close(), desktopWithoutController.close()]);
  }
});

test('NND local service starts without NNO activation and keeps its authenticated wire contract', async () => {
  assert.throws(() => assertNnoIntegrationActivation(createNndLocalIntegrationActivation()), {
    code: 'nno_integration_activation_required',
  });
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-nnd-cli-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'ephemeral', workspace_root: root,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
  const controller = new AbortController();
  const writes = [];
  await runNndIntegrationCommand(['serve'], {
    root, config: configRoot, sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks'),
    secretVault: join(root, 'secrets', 'vault.json'), secretKey: join(root, 'secrets', 'key.json'), secretAudit: join(root, 'secrets', 'audit.ndjson'),
  }, { environment: {}, output: { write(value) { writes.push(value); queueMicrotask(() => controller.abort()); return true; } }, signal: controller.signal });
  assert.equal(writes.length, 1);
  const frame = JSON.parse(writes[0]);
  assert.equal(frame.type, 'ready');
  assert.equal(frame.protocol, '1.0');
  assert.match(frame.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(frame.token, /^[A-Za-z0-9_-]{32,512}$/u);
  await assert.rejects(runNndIntegrationCommand(['extra'], {}, {}), { code: 'nnd_command_invalid' });
});

test('NND sessions resolve the existing local provider secret, including delegated engines', async () => {
  assert.equal(integrationSecretRealm('nnd', 'local'), LOCAL_SECRET_REALM);
  assert.equal(integrationSecretRealm('nno', 'deployment-a'), 'nno:deployment-a');
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-nnd-secret-route-'));
  const paths = {
    root, config: join(root, 'config'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks'),
    secretVault: join(root, 'secrets', 'vault.json'),
    secretKey: join(root, 'secrets', 'key.json'), secretAudit: join(root, 'secrets', 'audit.ndjson'),
  };
  await mkdir(paths.config, { recursive: true });
  const broker = new SecretBroker({ vaultPath: paths.secretVault, keyPath: paths.secretKey, auditPath: paths.secretAudit });
  const secret = await broker.create({ label: 'Configured provider', kind: 'api_key', fields: { api_key: 'test-only-provider-token' } });
  await writeFile(join(paths.config, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'ephemeral', workspace_root: root,
    providers: [{ id: 'primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'test', trust_zone: 'loopback',
      credential: { source: 'secret', secret_id: secret.id, field: 'api_key' } }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
  const host = await createIntegrationNndEngineHost(paths, { secretBroker: broker });
  const principal = { subjectId: 'operator', workspaceIds: nativeNndPrincipal(root).workspaceIds };
  try {
    const context = await host.create('session_secret', principal);
    const profile = context.engine.config.providerProfiles.primary;
    const token = await context.engine.credentialResolver.withCredential(profile.credential, {
      consumer: 'provider:primary', destination: profile.endpoint, purpose: 'test provider dispatch',
    }, (value) => value);
    assert.equal(token, 'test-only-provider-token');
    assert.equal(context.engine.subagentOptions.secretBroker, broker);
  } finally { await host.shutdown(); }
});

test('NND service uses the local secret realm for configured provider checks', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-nnd-secret-service-'));
  const paths = {
    root, config: join(root, 'config'), sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks'),
    secretVault: join(root, 'secrets', 'vault.json'),
    secretKey: join(root, 'secrets', 'key.json'), secretAudit: join(root, 'secrets', 'audit.ndjson'),
  };
  await mkdir(paths.config, { recursive: true });
  let receivedCredential = false;
  const provider = createServer((request, response) => {
    receivedCredential = request.headers.authorization === 'Bearer test-only-provider-token';
    response.writeHead(receivedCredential ? 200 : 401, { 'content-type': 'application/json' });
    response.end(JSON.stringify(receivedCredential ? { data: [{ id: 'test-model' }] } : { error: 'unauthorized' }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  let running;
  try {
    const broker = new SecretBroker({ vaultPath: paths.secretVault, keyPath: paths.secretKey, auditPath: paths.secretAudit });
    const secret = await broker.create({ label: 'Configured provider', kind: 'api_key', fields: { api_key: 'test-only-provider-token' } });
    await writeFile(join(paths.config, 'manifest.json'), JSON.stringify({
      format_version: 1, persistence: 'ephemeral', workspace_root: root,
      providers: [{ id: 'primary', endpoint: `http://127.0.0.1:${provider.address().port}/v1`, model: 'test-model', trust_zone: 'loopback',
        credential: { source: 'secret', secret_id: secret.id, field: 'api_key' } }],
      routes: { primary: { provider_id: 'primary', model: 'test-model' } },
    }));
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    running = runNndIntegrationCommand(['serve'], paths, {
      environment: {}, signal: controller.signal,
      output: { write(value) { resolveReady(JSON.parse(value)); return true; } },
    });
    const frame = await Promise.race([ready, running.then(() => { throw new Error('NND service exited before readiness'); })]);
    const principal = {
      subject_id: 'operator', platform_role: 'operator', permissions: ['provider.test'],
      workspace_ids: [], group_ids: [], trace_id: 'provider-check',
      issued_at: new Date().toISOString(), request_id: 'provider-check',
    };
    const healthPrincipal = { ...principal, permissions: ['integration.health'] };
    let readyHost = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const health = await fetch(`${frame.endpoint}/v1/health`, { headers: {
        authorization: `Bearer ${frame.token}`,
        'x-nna-principal': Buffer.from(JSON.stringify(healthPrincipal)).toString('base64url'),
      } });
      const state = await health.json();
      if (state.execution_state === 'ready') { readyHost = true; break; }
      assert.equal(state.status, 'starting');
    }
    assert.equal(readyHost, true, 'native execution host must become ready');
    const response = await fetch(`${frame.endpoint}/v1/provider-profiles/primary/test`, {
      method: 'POST', headers: {
        authorization: `Bearer ${frame.token}`,
        'x-nna-principal': Buffer.from(JSON.stringify(principal)).toString('base64url'),
      },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, 'ready');
    assert.equal(receivedCredential, true);
  } finally {
    controller.abort();
    if (running) await running;
    await new Promise((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  }
});

test('integration child emits one atomic protocol-only readiness frame', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-integration-cli-'));
  const installRoot = join(root, 'nno');
  const integrationRoot = join(installRoot, 'nna-integration', 'nno-hosted');
  const configRoot = join(root, 'config');
  await mkdir(integrationRoot, { recursive: true });
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(integrationRoot, 'integration.json'), JSON.stringify({
    id: 'nno-hosted', ownership: 'nno', scope: 'nno-child-only',
    nna_integration_protocol: '1.0', deployment_id: 'test-deployment',
  }));
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'durable', workspace_root: root,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
  const controller = new AbortController();
  const writes = [];
  const output = { write(value) { writes.push(value); queueMicrotask(() => controller.abort()); return true; } };
  await runIntegrationCommand(['serve'], {
    root, config: configRoot, sessions: join(root, 'sessions'),
    secretVault: join(root, 'secrets', 'vault.json'),
    secretKey: join(root, 'secrets', 'key.json'),
    secretAudit: join(root, 'secrets', 'audit.ndjson'),
  }, {
    environment: { NNA_NNO_INSTALL_ROOT: installRoot }, output, signal: controller.signal,
  });

  assert.equal(writes.length, 1);
  assert.match(writes[0], /\n$/u);
  const frame = JSON.parse(writes[0]);
  assert.deepEqual(Object.keys(frame).sort(), ['endpoint', 'instance_id', 'protocol', 'token', 'type']);
  assert.equal(frame.type, 'ready');
  assert.equal(frame.protocol, '1.0');
  assert.match(frame.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(frame.instance_id, /^nna_[0-9a-f-]+$/u);
  assert.ok(frame.token.length >= 43);
});

test('legacy broker-only activation cannot start the unified authority', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-integration-legacy-'));
  const installRoot = join(root, 'nno');
  const integrationRoot = join(installRoot, 'nna-integration', 'nno-hosted');
  await mkdir(integrationRoot, { recursive: true });
  await writeFile(join(integrationRoot, 'integration.json'), JSON.stringify({
    id: 'nno-hosted', ownership: 'nno', scope: 'nno-child-only', nna_secret_broker_protocol: '1.0',
  }));
  await assert.rejects(runIntegrationCommand(['serve'], {
    config: join(root, 'config'), secretVault: 'unused', secretKey: 'unused', secretAudit: 'unused',
  }, { environment: { NNA_NNO_INSTALL_ROOT: installRoot }, output: { write() { return true; } } }), {
    code: 'nno_integration_activation_incompatible',
  });
});

test('integration NND host builds governed engines from the trusted manifest', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-integration-nnd-host-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'ephemeral', workspace_root: root,
    providers: [{ id: 'primary', display_name: 'Primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
  const skillRoot = join(root, 'skills');
  await mkdir(join(skillRoot, 'review'), { recursive: true });
  await writeFile(join(skillRoot, 'review', 'SKILL.md'), [
    '---', 'id: nnd-review', 'version: 1', 'description: Review a change',
    'invocation: both', '---', 'Review the requested change.',
  ].join('\n'));
  const host = await createIntegrationNndEngineHost({ root, config: configRoot, sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks'), skills: skillRoot }, {
    nndBrowserCallback: { url: 'http://127.0.0.1:4172/api/browser-control/request', token: 's'.repeat(43) },
    nndAgentToolCallback: { url: 'http://127.0.0.1:4173/api/agent-tool/callback', token: 'a'.repeat(43) },
  });
  assert.equal(host.workspaceRoot, root);
  assert.deepEqual(host.nndModel, { providerID: 'primary', modelID: 'test' });
  const initialSkills = await host.readNndSkillsInventory();
  assert.ok(initialSkills.skills.some((skill) => skill.id === 'nnd-review'));
  assert.equal(JSON.stringify(initialSkills).includes('SKILL.md'), false);
  assert.equal(JSON.stringify(initialSkills).includes('Review the requested change.'), false);
  const principal = { subjectId: 'operator', workspaceIds: nativeNndPrincipal(root).workspaceIds };
  const context = await host.create('session_a', principal);
  assert.equal(context.engine.sessionId, 'session_a');
  assert.equal(context.engine.emitContextStatus, true);
  assert.equal(context.engine.surface, 'nnd');
  assert.equal(context.engine.tools.definition('nnd_browser')?.scope, 'browser');
  assert.equal(context.engine.tools.definition('openchamber_memory')?.scope, 'memory');
  assert.equal(context.engine.tools.definition('web_browse'), undefined);
  assert.ok(context.engine.skills.catalog().some((skill) => skill.id === 'nnd-review'));
  await writeFile(join(skillRoot, 'review', 'SKILL.md'), [
    '---', 'id: nnd-review', 'version: 2', 'description: Review a newer change',
    'invocation: both', '---', 'Review the newer requested change.',
  ].join('\n'));
  const refreshedSkills = await host.readNndSkillsInventory();
  assert.equal(refreshedSkills.skills.find((skill) => skill.id === 'nnd-review').version, '2');
  assert.equal(context.engine.skills.catalog().find((skill) => skill.id === 'nnd-review').version, '1');
  const failedSkillRoot = join(root, 'bad-bundled');
  await mkdir(join(failedSkillRoot, 'invalid'), { recursive: true });
  await writeFile(join(failedSkillRoot, 'invalid', 'SKILL.md'), 'invalid skill file');
  const failedHost = await createIntegrationNndEngineHost({
    root, config: configRoot, sessions: join(root, 'failed-sessions'), reviewerLedger: join(root, 'failed-reviewer'),
    hooks: join(root, 'hooks'), skills: skillRoot,
  }, { skillRoots: [{ scope: 'bundled', path: failedSkillRoot }] });
  await assert.rejects(failedHost.readNndSkillsInventory(), (error) => {
    assert.equal(error.code, 'nnd_skills_unavailable');
    assert.equal(error.message.includes('SKILL.md'), false);
    assert.equal(error.message.includes(root), false);
    return true;
  });
  await failedHost.shutdown();
  const events = [];
  host.eventBus = { publishSession: (event) => events.push(event) };
  let release;
  context.engine.submit = async () => new Promise((resolve) => { release = resolve; });
  assert.equal(host.submitAsync('session_a', { version: '1.0', type: 'submit', request_id: 'prompt_a', content: 'hello' }, principal).accepted, true);
  await context.engine.output({ type: 'stream_delta', session_id: 'session_a', turn_id: 'turn_a', text: 'Live answer' });
  assert.equal(events.find((event) => event.type === 'message.part.updated').properties.part.text, 'Live answer');
  release({ accepted: true });
  await new Promise((resolve) => setImmediate(resolve));
  await host.close('session_a', principal);
});

test('provider route activation changes future NND sessions without mutating existing engines', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-route-activation-'));
  const configRoot = join(root, 'config');
  await mkdir(configRoot, { recursive: true });
  const document = { format_version: 1, persistence: 'ephemeral', workspace_root: root,
    providers: [
      { id: 'old', endpoint: 'http://127.0.0.1:1234/v1', model: 'old-model', trust_zone: 'loopback' },
      { id: 'new', endpoint: 'http://127.0.0.1:2234/v1', model: 'new-model', trust_zone: 'loopback' },
    ], routes: { primary: { provider_id: 'old', model: 'old-model' } } };
  const manifestPath = join(configRoot, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(document));
  const host = await createIntegrationNndEngineHost({ root, config: configRoot, sessions: join(root, 'sessions'),
    reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks') });
  const profiles = new ProviderProfileStore({ configRoot });
  const principal = { subjectId: 'operator', workspaceIds: nativeNndPrincipal(root).workspaceIds };
  try {
    assert.equal((await profiles.inventory(host.providerRoutingPending)).provider_routing_pending, false);
    const before = await host.create('session_before', principal);
    document.routes.primary = { provider_id: 'new', model: 'new-model' };
    document.routes.subagent = { provider_id: 'new', model: 'new-model' };
    document.providers = [document.providers[1]];
    await writeFile(manifestPath, JSON.stringify(document));
    assert.equal((await profiles.inventory(host.providerRoutingPending)).provider_routing_pending, true);
    assert.deepEqual(await host.activateProviderRoute(), { providerID: 'new', modelID: 'new-model' });
    assert.equal((await profiles.inventory(host.providerRoutingPending)).provider_routing_pending, false);
    const after = await host.create('session_after', principal);
    assert.equal(before.engine.config.routes.primary.providerId, 'old');
    assert.equal(after.engine.config.routes.primary.providerId, 'new');
    assert.equal(after.engine.config.routes.subagent.providerId, 'new');
    assert.equal(after.engine.config.providerProfiles.old, undefined);
    assert.ok(before.engine.config.providerProfiles.old);
    assert.deepEqual(host.nndAgentInventory.route, { providerID: 'new', modelID: 'new-model' });
    document.providers.push({ id: 'third', endpoint: 'http://127.0.0.1:3234/v1', model: 'third-model', trust_zone: 'loopback' });
    document.routes.subagent = { provider_id: 'third', model: 'third-model' };
    await writeFile(manifestPath, JSON.stringify(document));
    assert.equal((await profiles.inventory(host.providerRoutingPending)).provider_routing_pending, true);
    assert.deepEqual((await profiles.inventory(host.providerRoutingPending)).configured_primary_route,
      { providerID: 'new', modelID: 'new-model' });
    await host.activateProviderRoute();
    assert.deepEqual(host.nndAgentInventory.route, { providerID: 'third', modelID: 'third-model' });
    assert.equal((await profiles.inventory(host.providerRoutingPending)).provider_routing_pending, false);
    assert.deepEqual(host.get('session_before', principal).metadata.nnd.configuredModel,
      { providerID: 'old', modelID: 'old-model' });
    assert.deepEqual(host.get('session_after', principal).metadata.nnd.configuredModel,
      { providerID: 'new', modelID: 'new-model' });
    document.workspace_root = join(root, 'other');
    await writeFile(manifestPath, JSON.stringify(document));
    await assert.rejects(host.activateProviderRoute(), { code: 'nnd_manifest_invalid' });
    assert.deepEqual(host.nndModel, { providerID: 'new', modelID: 'new-model' });
  } finally { await host.shutdown(); }
});

test('NND skills include project roots only after workspace trust', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-nnd-project-skills-'));
  const configRoot = join(root, 'config');
  const projectSkills = join(root, '.nna', 'skills', 'project-review');
  const trustPath = join(root, 'trust.json');
  await mkdir(configRoot, { recursive: true });
  await mkdir(projectSkills, { recursive: true });
  await writeFile(join(configRoot, 'manifest.json'), JSON.stringify({
    format_version: 1, persistence: 'ephemeral', workspace_root: root,
    providers: [{ id: 'primary', endpoint: 'http://127.0.0.1:1234/v1', model: 'test', trust_zone: 'loopback' }],
    routes: { primary: { provider_id: 'primary', model: 'test' } },
  }));
  await writeFile(join(projectSkills, 'SKILL.md'), [
    '---', 'id: project-review', 'version: 1', 'description: Review project code',
    'invocation: both', '---', 'Project instructions.',
  ].join('\n'));
  const paths = { root, config: configRoot, sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'),
    hooks: join(root, 'hooks'), trustedWorkspaces: trustPath };
  const before = await createIntegrationNndEngineHost(paths);
  assert.equal((await before.readNndSkillsInventory()).skills.some((skill) => skill.id === 'project-review'), false);
  await before.shutdown();
  await trustWorkspace(trustPath, root);
  const after = await createIntegrationNndEngineHost(paths);
  assert.equal((await after.readNndSkillsInventory()).skills.some((skill) => skill.id === 'project-review'), true);
  await after.shutdown();
});

test('integration activation rejects an invalid deployment identifier', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? homedir() : tmpdir(), 'nna-integration-invalid-deployment-'));
  const installRoot = join(root, 'nno');
  const integrationRoot = join(installRoot, 'nna-integration', 'nno-hosted');
  await mkdir(integrationRoot, { recursive: true });
  await writeFile(join(integrationRoot, 'integration.json'), JSON.stringify({
    id: 'nno-hosted', ownership: 'nno', scope: 'nno-child-only',
    nna_integration_protocol: '1.0', deployment_id: '../outside',
  }));
  await assert.rejects(runIntegrationCommand(['serve'], {
    config: join(root, 'config'), secretVault: 'unused', secretKey: 'unused', secretAudit: 'unused',
  }, { environment: { NNA_NNO_INSTALL_ROOT: installRoot }, output: { write() { return true; } } }), {
    code: 'nno_integration_activation_invalid',
  });
});
