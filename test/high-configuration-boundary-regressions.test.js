// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadStartupManifestDocument } from '../src/onboarding.js';
import { PathPolicy } from '../src/path-policy.js';
import { ProjectMemoryReconciler, MANAGED_START, MANAGED_END } from '../src/project-memory-reconciler.js';
import { SkillRegistry, validateHostedSkills } from '../src/skill-registry.js';
import { resolveManifest } from '../src/config.js';
import { availableWorkspaceModels, qualifyWorkspaceModel } from '../src/experience/models.js';
import { handleModelCommand } from '../src/tui/provider-command.js';

test('migration I/O failure must not quarantine a valid startup manifest', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'nna-onboarding-regression-'));
  const path = join(root, 'manifest.json');
  const content = JSON.stringify({ provider: { endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture', trust_zone: 'loopback' } });
  await fs.writeFile(path, content); const original = fs.rename;
  fs.rename = async (from, to) => { if (to === path) throw Object.assign(new Error('disk'), { code: 'EIO' }); return original(from, to); }; syncBuiltinESMExports();
  try { await assert.rejects(loadStartupManifestDocument({ paths: { config: root } }), { code: 'EIO' }); }
  finally { fs.rename = original; syncBuiltinESMExports(); }
  assert.equal(await fs.readFile(path, 'utf8'), content);
});
test('path resolution before initialization fails explicitly without guessing a root', async () => {
  const policy = new PathPolicy(process.cwd());
  await assert.rejects(policy.resolveRead('file.txt'), { code: 'workspace_path_invalid' });
  await assert.rejects(policy.resolveRead(join(process.cwd(), 'VERSION')), { code: 'workspace_path_invalid' });
});
test('project memory cannot emit its own structural markers inside items', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'nna-memory-marker-'));
  for (const marker of [MANAGED_START, MANAGED_END]) {
    await assert.rejects(new ProjectMemoryReconciler(root).propose({ sections: { 'Working conventions': [`Document ${marker}`] }, evidenceRefs: ['evidence:one'] }), { code: 'project_memory_item_invalid' });
  }
});
const skill = { id: 'fixture', version: '1', description: 'Fixture', invocation: 'user', body: 'Test guidance', requires_tools: [] };
test('hosted registry validates raw descriptors and preserves validated descriptors', async () => {
  await assert.rejects(new SkillRegistry({ hosted: true, hostSkills: [null] }).initialize(), { code: 'skill_invalid' });
  for (const descriptors of [[skill], validateHostedSkills([skill])]) {
    const registry = new SkillRegistry({ hosted: true, hostSkills: descriptors });
    await registry.initialize(); registry.queueUser('fixture');
    assert.deepEqual(registry.beginTurn().map((item) => item.id), ['fixture']);
  }
});
test('queued skills cannot disappear through registry reinitialization', async () => {
  const registry = new SkillRegistry({ hosted: true, hostSkills: validateHostedSkills([skill]) });
  await registry.initialize(); registry.queueUser('fixture');
  registry.hostSkills = []; await registry.initialize();
  assert.deepEqual(registry.beginTurn().map((item) => item.id), ['fixture']);
});
function workspace(provider) {
  const config = resolveManifest({ provider: { endpoint: 'http://127.0.0.1:1234/v1', model: 'fixture', trust_zone: 'loopback' } });
  const events = []; let observations = 0;
  const engine = { providerFactory: () => provider, telemetry: { record: (...args) => events.push(args) }, reliability: { observe() { observations += 1; } } };
  return { activeEngine: () => engine, activeConfig: () => config, options: {}, events, observations: () => observations };
}
test('model discovery already falls back at its UI boundary and reports the failure', async () => {
  const value = workspace({ capabilities: async () => { throw Object.assign(new Error('offline'), { code: 'provider_offline' }); } });
  let overlay;
  value.availableModels = () => availableWorkspaceModels(value);
  value.projection = { active: () => ({ role: 'primary' }), openOverlay: (item) => { overlay = item; } };
  await handleModelCommand('', value, {});
  assert.match(JSON.stringify(overlay), /fixture/); assert.match(JSON.stringify(overlay), /provider_offline/);
});
test('qualification transport failure is observed without poisoning model dialect evidence', async () => {
  const value = workspace({ async *stream() { throw new Error('private provider detail'); } });
  await assert.rejects(qualifyWorkspaceModel(value), { code: 'qualification_unavailable', message: 'Model qualification could not complete.' });
  assert.equal(value.observations(), 0); assert.equal(value.events.length, 1);
  assert.equal(JSON.stringify(value.events).includes('private provider detail'), false);
});
