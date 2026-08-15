// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { discoverHookBundles } from '../src/hook-manifest.js';
import { parseCommand } from '../src/hook-runner.js';
import { redactExtensionData } from '../src/redaction.js';

function config(workspaceRoot) {
  return resolveManifest({
    persistence: 'ephemeral', workspace_root: workspaceRoot,
    provider: {
      id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1',
      model: 'fixture-model', trust_zone: 'loopback',
    },
  });
}

async function createBundle(root, subscriptions, source, name = 'fixture-hook') {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    name, version: '1.0.0', subscriptions,
  }), 'utf8');
  await writeFile(join(directory, 'hook.mjs'), source, 'utf8');
  return directory;
}

test('trusted project and user hook roots are bounded, scoped, and collision-safe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hook-scopes-'));
  const user = join(root, 'user'); const project = join(root, 'project');
  const subscription = [{ event: 'turn', phase: 'pre', command: nodeCommand() }];
  await createBundle(user, subscription, '', 'shared');
  await createBundle(project, subscription, '', 'shared');
  await createBundle(project, subscription, '', 'project-only');
  const engine = new SessionEngine({
    config: config(root), hookRoots: [{ scope: 'user', path: user }, { scope: 'project', path: project }],
    providerFactory: () => new ScriptlessProvider(),
  });
  await engine.initialize();
  const statuses = engine.hooks.health().bundles;
  assert.ok(statuses.some((item) => item.bundle === 'shared' && item.scope === 'user' && item.status === 'loaded'));
  assert.ok(statuses.some((item) => item.bundle === 'shared' && item.scope === 'project' && item.code === 'hook_identity_conflict'));
  assert.ok(statuses.some((item) => item.bundle === 'project-only' && item.scope === 'project' && item.status === 'loaded'));
  await engine.shutdown({ request_id: 'scope-stop' });
});

class ScriptlessProvider {
  async *stream() { yield { type: 'terminal' }; }
}

function nodeCommand() {
  return `"${process.execPath}" hook.mjs`;
}

test('hook discovery validates immediate bundle manifests and skips malformed peers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hooks-discovery-'));
  await createBundle(root, [{ event: 'turn', phase: 'pre', command: nodeCommand() }], '');
  await mkdir(join(root, 'malformed'));
  await writeFile(join(root, 'malformed', 'manifest.json'), '{bad', 'utf8');
  const result = await discoverHookBundles(root);
  assert.equal(result.bundles.length, 1);
  assert.equal(result.bundles[0].name, 'fixture-hook');
  assert.deepEqual(result.diagnostics.map((item) => item.bundle), ['malformed']);
});

test('hook discovery rejects advertised phase combinations the runtime cannot register', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hooks-phases-'));
  await createBundle(root, [{ event: 'turn', phase: 'post_failure', command: nodeCommand() }], '');
  const result = await discoverHookBundles(root);
  assert.equal(result.bundles.length, 0);
  assert.equal(result.diagnostics[0].code, 'invalid_hook_subscription');
});

test('hook discovery accepts bounded subscription concurrency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hook-concurrency-'));
  await createBundle(root, [{
    event: 'tool.call', phase: 'post', command: nodeCommand(),
    blocking: false, max_concurrent: 8,
  }], '');
  const result = await discoverHookBundles(root);
  assert.equal(result.bundles.length, 1);
  assert.equal(result.bundles[0].subscriptions[0].maxConcurrent, 8);
});

test('hook discovery accepts the governed idle-maintenance event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hook-maintenance-'));
  await createBundle(root, [{
    event: 'maintenance', phase: 'idle', command: nodeCommand(), blocking: true,
  }], '');
  const result = await discoverHookBundles(root);
  assert.equal(result.bundles.length, 1);
  assert.equal(result.bundles[0].subscriptions[0].event, 'maintenance');
});

test('hook discovery rejects excessive subscription concurrency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hook-concurrency-invalid-'));
  await createBundle(root, [{
    event: 'tool.call', phase: 'post', command: nodeCommand(), max_concurrent: 17,
  }], '');
  const result = await discoverHookBundles(root);
  assert.equal(result.bundles.length, 0);
  assert.equal(result.diagnostics[0].code, 'invalid_hook_limit');
});

test('maximum valid hook timeout remains registerable with runtime grace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hook-timeout-ceiling-'));
  const hooks = join(root, 'hooks');
  await createBundle(hooks, [{
    event: 'turn', phase: 'post', command: nodeCommand(), blocking: false, timeout_ms: 300_000,
  }], '');
  const engine = new SessionEngine({
    config: config(root), hookRoot: hooks, providerFactory: () => new ScriptlessProvider(),
  });
  await engine.initialize();
  assert.equal(engine.hooks.health().bundles[0].status, 'loaded');
  await engine.shutdown({ request_id: 'hook-timeout-stop' });
});

test('hook command parser permits argv but rejects shell composition', () => {
  assert.deepEqual(parseCommand('python "some script.py" --flag'), {
    command: 'python', args: ['some script.py', '--flag'],
  });
  assert.deepEqual(parseCommand('python "say \\"hello\\" now"'), {
    command: 'python', args: ['say "hello" now'],
  });
  assert.throws(() => parseCommand('python hook.py | more'), { code: 'unsafe_hook_command' });
  assert.throws(() => parseCommand('python hook.py && echo bad'), { code: 'unsafe_hook_command' });
  assert.throws(() => parseCommand('python "bad\0token" next'), { code: 'invalid_hook_command' });
});

test('extension payload redaction removes structured and free-form credentials', () => {
  const redacted = redactExtensionData({
    api_key: 'literal-value',
    output: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    nested: { password: 'do-not-store' },
  });
  assert.equal(redacted.api_key, '[redacted]');
  assert.equal(redacted.nested.password, '[redacted]');
  assert.doesNotMatch(redacted.output, /abcdefghijklmnopqrstuvwxyz/u);
});

test('blocking turn hook injects attributed untrusted context into provider request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hook-turn-'));
  const hooks = join(root, 'hooks');
  await createBundle(hooks, [{
    event: 'turn', phase: 'pre', command: nodeCommand(), blocking: true, timeout_ms: 5000,
  }], `
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
if (payload.prompt !== 'remember this' || payload.cwd !== ${JSON.stringify(root)}) process.exit(1);
console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: 'fixture memory' } }));
`);
  let request;
  const provider = { async *stream(value) {
    request = value;
    yield { type: 'text', text: 'Used context.' };
    yield { type: 'terminal', finishReason: 'stop' };
  } };
  const engine = new SessionEngine({
    config: config(root), hookRoot: hooks, providerFactory: () => provider,
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'hook-turn', content: 'remember this' }, 'operator');
  assert.equal(result.outcome, 'completed');
  assert.ok(request.messages.some((item) => /Untrusted context supplied by hook fixture-hook/u.test(item.content)));
  assert.ok(request.messages.some((item) => /fixture memory/u.test(item.content)));
  const runtime = engine.hooks.health().bundles[0].runtime;
  assert.equal(runtime.invocations, 1);
  assert.equal(runtime.failures, 0);
  assert.equal(runtime.last_code, 'hook_context');
  assert.equal(runtime.last_event, 'turn:pre');
  await engine.shutdown({ request_id: 'hook-stop' });
});

test('hook health reports invocation failures without exposing hook payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-hook-health-'));
  const hooks = join(root, 'hooks');
  await createBundle(hooks, [{
    event: 'turn', phase: 'pre', command: nodeCommand(), blocking: true, timeout_ms: 5000,
  }], 'process.exit(1);');
  const engine = new SessionEngine({
    config: config(root), hookRoot: hooks, providerFactory: () => new ScriptlessProvider(),
  });
  await engine.initialize();
  const result = await engine.submit({ request_id: 'hook-failure', content: 'private prompt' }, 'operator');
  assert.equal(result.outcome, 'incomplete');
  const health = engine.hooks.health();
  assert.equal(health.status, 'degraded');
  assert.equal(health.invocation_failures, 1);
  assert.equal(health.bundles[0].runtime.last_code, 'hook_failed');
  assert.doesNotMatch(JSON.stringify(health), /private prompt/u);
  await engine.shutdown({ request_id: 'hook-health-stop' });
});
