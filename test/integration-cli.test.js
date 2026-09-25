// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIntegrationNndEngineHost, runIntegrationCommand, runNndIntegrationCommand } from '../src/integration-cli.js';
import { assertNnoIntegrationActivation, createNndLocalIntegrationActivation } from '../src/nno-integration-activation.js';
import { trustWorkspace } from '../src/experience/trust.js';

test('NND local service starts without NNO activation and keeps its authenticated wire contract', async () => {
  assert.throws(() => assertNnoIntegrationActivation(createNndLocalIntegrationActivation()), {
    code: 'nno_integration_activation_required',
  });
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-cli-'));
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
    config: configRoot, sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks'),
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

test('integration child emits one atomic protocol-only readiness frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-integration-cli-'));
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
    config: configRoot, sessions: join(root, 'sessions'),
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
  const root = await mkdtemp(join(tmpdir(), 'nna-integration-legacy-'));
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
  const root = await mkdtemp(join(tmpdir(), 'nna-integration-nnd-host-'));
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
  const host = await createIntegrationNndEngineHost({ config: configRoot, sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'), hooks: join(root, 'hooks'), skills: skillRoot });
  assert.equal(host.workspaceRoot, root);
  assert.deepEqual(host.nndModel, { providerID: 'primary', modelID: 'test' });
  const initialSkills = await host.readNndSkillsInventory();
  assert.ok(initialSkills.skills.some((skill) => skill.id === 'nnd-review'));
  assert.equal(JSON.stringify(initialSkills).includes('SKILL.md'), false);
  assert.equal(JSON.stringify(initialSkills).includes('Review the requested change.'), false);
  const principal = { subjectId: 'operator', workspaceIds: ['workspace_a'] };
  const context = await host.create('session_a', principal);
  assert.equal(context.engine.sessionId, 'session_a');
  assert.equal(context.engine.emitContextStatus, true);
  assert.equal(context.engine.surface, 'nnd');
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
    config: configRoot, sessions: join(root, 'failed-sessions'), reviewerLedger: join(root, 'failed-reviewer'),
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

test('NND skills include project roots only after workspace trust', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-nnd-project-skills-'));
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
  const paths = { config: configRoot, sessions: join(root, 'sessions'), reviewerLedger: join(root, 'reviewer'),
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
  const root = await mkdtemp(join(tmpdir(), 'nna-integration-invalid-deployment-'));
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
