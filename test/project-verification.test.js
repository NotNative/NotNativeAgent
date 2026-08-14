// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PathPolicy } from '../src/path-policy.js';
import { discoverVerificationPlan, projectVerifyDefinition } from '../src/tools/project-verification.js';
import { toolStatus } from '../src/engine/records.js';

async function fixture(scripts, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nna-verify-'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'test', 'smoke.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('smoke',()=>assert.equal(1,1));\n");
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts, ...extra }));
  return root;
}

test('verification discovery prefers the canonical check script and records its exact command', async () => {
  const root = await fixture({ check: 'node --test', test: 'node --test' });
  const plan = await discoverVerificationPlan(root);
  assert.equal(plan.adapter, 'npm');
  assert.deepEqual(plan.requested_checks, ['quality']);
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0].script, 'check');
  assert.match(plan.commands[0].display, /npm(?:-cli\.js)?(?:"?\s+)run check/u);
  assert.match(plan.manifest.sha256, /^[0-9a-f]{64}$/u);
});

test('verification discovery honors Bun package metadata', async () => {
  const root = await fixture({ test: 'bun test' }, { packageManager: 'bun@1.3.0' });
  const plan = await discoverVerificationPlan(root, { checks: ['test'] });
  assert.equal(plan.adapter, 'bun');
  assert.match(plan.commands[0].display, /bun(?:\.exe)?(?:"?\s+)run test/u);
});

test('focused Node builtin tests resolve to exact test paths', async () => {
  const root = await fixture({ test: 'node --test' });
  const paths = new PathPolicy(root); await paths.initialize();
  const definition = projectVerifyDefinition(paths);
  const sealed = await definition.validate({ scope: 'focused', checks: ['test'], paths: ['test/smoke.test.js'] });
  assert.equal(sealed.resolved.commands[0].executable, process.execPath);
  assert.deepEqual(sealed.resolved.commands[0].argv, ['--test', join(root, 'test', 'smoke.test.js')]);
  assert.equal(sealed.resolved.reviewPurpose, 'project_verification');
});

test('project verification produces a passing durable receipt payload', async () => {
  const root = await fixture({ test: 'node --test' });
  const paths = new PathPolicy(root); await paths.initialize();
  const definition = projectVerifyDefinition(paths);
  const normalized = await definition.validate({ scope: 'focused', checks: ['test'], paths: ['test/smoke.test.js'] });
  const result = await definition.executor({ args: normalized.args, resolved: normalized.resolved }, new AbortController().signal);
  const receipt = JSON.parse(result.content);
  assert.equal(receipt.passed, true);
  assert.match(receipt.receipt_id, /^verify:[0-9a-f]{64}$/u);
  assert.equal(receipt.results[0].exit_code, 0);
  assert.equal(result.status, 'succeeded');
});

test('project verification reports a completed failing check as a failed tool result', async () => {
  const root = await fixture({ test: 'node -e "process.exit(3)"' });
  const paths = new PathPolicy(root); await paths.initialize();
  const definition = projectVerifyDefinition(paths);
  const normalized = await definition.validate({ checks: ['test'] });
  const result = await definition.executor({ args: normalized.args, resolved: normalized.resolved }, new AbortController().signal);
  const receipt = JSON.parse(result.content);
  assert.equal(result.status, 'failed');
  assert.equal(result.reasonCode, 'verification_failed');
  assert.equal(receipt.passed, false);
  assert.equal(receipt.results[0].exit_code, 3);
});

test('verification refuses to execute a command plan after manifest drift', async () => {
  const root = await fixture({ test: 'node --test' });
  const paths = new PathPolicy(root); await paths.initialize();
  const definition = projectVerifyDefinition(paths);
  const normalized = await definition.validate({ checks: ['test'] });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test --watch' } }));
  await assert.rejects(
    definition.executor({ args: normalized.args, resolved: normalized.resolved }, new AbortController().signal),
    (error) => error.code === 'verification_plan_drift',
  );
});

test('verification status presents the exact reviewed command compactly', () => {
  const record = toolStatus({
    sessionId: 'session-1', tools: { definition: () => ({ sideEffect: 'unknown', scope: 'workspace' }) },
  }, { turnId: 'turn-1' }, {
    request: {
      id: 'request-1', toolName: 'project.verify', definitionVersion: 1, args: { scope: 'full' },
      resolved: { commands: [{ display: 'C:/node.exe C:/npm-cli.js run check' }] },
    },
    call: { name: 'project.verify', providerCallId: 'provider-1', args: { scope: 'full' } },
    result: { elapsed_ms: 10, effect_certainty: 'completed' },
  }, 'succeeded');
  assert.equal(record.target, 'C:/node.exe C:/npm-cli.js run check');
});
