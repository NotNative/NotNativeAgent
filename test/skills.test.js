// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveManifest } from '../src/config.js';
import { SkillRegistry, skillToolDefinitions } from '../src/skill-registry.js';
import { runtimeSkillRoots } from '../src/startup-configuration.js';

const provider = { endpoint: 'http://127.0.0.1:1234/v1', model: 'test', trust_zone: 'loopback' };

test('bundled operational skills are available to standalone NNA', async () => {
  const registry = new SkillRegistry({ roots: runtimeSkillRoots({}, null) });
  await registry.initialize();
  const catalog = registry.catalog();
  assert.deepEqual(catalog.map((item) => item.id).sort(), ['devteam', 'research', 'troubleshoot', 'webdesign']);
  const devteam = registry.queueUser('devteam').body;
  assert.match(devteam, /type `planner`[\s\S]+type `coder`[\s\S]+type `tester`[\s\S]+type `reviewer`/u);
  assert.match(devteam, /general Power of Ten[\s\S]+UI Power of Ten[\s\S]+accessibility/u);
  assert.match(registry.queueUser('research').body, /evidence ledger[\s\S]+contradictions[\s\S]+fresh `reviewer`/u);
  assert.match(registry.queueUser('troubleshoot').body, /nna\.diagnose_turn[^]*selector/u);
  const webdesign = registry.queueUser('webdesign').body;
  assert.match(webdesign, /Swiss-informed baseline/u);
  assert.match(webdesign, /target product's established visual language is authoritative/u);
  assert.match(webdesign, /Validate with rendered evidence/u);
  assert.match(webdesign, /Do not claim visual validation from source inspection alone/u);
  assert.match(webdesign, /not a separate[\s\S]+pipeline/u);
});

test('discovers bounded local skills and enforces invocation direction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-skills-'));
  try {
    const folder = join(root, 'review');
    await mkdir(folder);
    await writeFile(join(folder, 'SKILL.md'), [
      '---', 'id: code-review', 'version: 1', 'description: Review changed code',
      'invocation: both', 'requires_tools: [fs.read_text]', '---', 'Read the relevant files and report defects.',
    ].join('\n'));
    const registry = new SkillRegistry({ roots: [{ scope: 'user', path: root }] });
    await registry.initialize();
    assert.equal(registry.catalog()[0].id, 'code-review');
    assert.equal(registry.search('review code')[0].id, 'code-review');
    registry.queueUser('code-review');
    assert.deepEqual(registry.beginTurn().map((item) => item.id), ['code-review']);
    assert.deepEqual(registry.loadedIds(), ['code-review']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('malformed external skills are quarantined without preventing startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-skills-invalid-'));
  try {
    const malformed = join(root, 'broken');
    const valid = join(root, 'valid');
    await mkdir(malformed); await mkdir(valid);
    await writeFile(join(malformed, 'SKILL.md'), ['---', 'name: broken', 'unsupported yaml list', '---', 'Broken.'].join('\n'));
    await writeFile(join(valid, 'SKILL.md'), [
      '---', 'id: valid-skill', 'version: 1', 'description: A valid external skill',
      'invocation: both', '---', 'Remain available when a peer manifest is malformed.',
    ].join('\n'));
    const registry = new SkillRegistry({ roots: [{ scope: 'user', path: root }] });
    await registry.initialize();
    assert.deepEqual(registry.catalog().map((item) => item.id), ['valid-skill']);
    assert.equal(registry.diagnostics().length, 1);
    assert.equal(registry.diagnostics()[0].code, 'skill_frontmatter_invalid');
    assert.match(registry.diagnostics()[0].path, /broken[\\/]SKILL\.md/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('host skills require authenticated policy and exact skill tools', async () => {
  const skill = {
    id: 'module.customer', version: '1', description: 'Handle an allowed customer workflow',
    invocation: 'both', body: 'Use only the customer tools granted to this session.',
    source: 'nno:crm', requires_tools: ['mcp.nno.customer.read'],
  };
  assert.throws(() => resolveManifest({ provider, skills: [skill] }), { code: 'hosted_skills_forbidden' });
  const config = resolveManifest({
    provider, skills: [skill], allowed_capabilities: ['tools', 'skills'],
    allowed_tools: ['mcp.nno.customer.read', 'skill.load', 'skill.search'],
  }, { principal: 'authenticated-stdio-host', executionManifestId: 'exec_12345678' });
  assert.equal(config.executionManifest.skillGrant.count, 1);
  const registry = new SkillRegistry({
    hosted: true, hostSkills: config.skills, allowedTools: config.executionManifest.allowedTools,
  });
  await registry.initialize();
  const load = skillToolDefinitions(registry).find((item) => item.name === 'skill.load');
  const normalized = await load.validate({ id: skill.id });
  const result = await load.executor({ args: normalized.args }, new AbortController().signal);
  assert.match(result.content, /cannot grant tools, permissions, secrets, or broader scope/u);
});

test('host skills fail closed when required tools or loading tools are absent', async () => {
  const base = {
    id: 'module.audit', version: '1', description: 'Audit module state', invocation: 'agent',
    body: 'Inspect allowed module state.', source: 'nno:audit', requires_tools: ['mcp.nno.audit.read'],
  };
  const config = resolveManifest({
    provider, skills: [base], allowed_capabilities: ['tools', 'skills'], allowed_tools: ['mcp.nno.audit.read'],
  }, { principal: 'authenticated-stdio-host', executionManifestId: 'exec_abcdefgh' });
  const registry = new SkillRegistry({ hosted: true, hostSkills: config.skills, allowedTools: config.executionManifest.allowedTools });
  await assert.rejects(() => registry.initialize(), { code: 'skill_tools_not_granted' });
});
