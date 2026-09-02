// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveManifest } from '../src/config.js';
import { TypedSessionEngine as SessionEngine } from './typed-provider-fixture.js';
import { ExperienceEngine } from '../src/experience-engine.js';
import { tabPoolRecords } from '../src/experience/presentation.js';
import { FileChangeLedger } from '../src/persistence/file-change-ledger.js';
import { ToolRegistry } from '../src/tool-registry.js';

class WorkspaceProvider {
  constructor(target, inspect = () => undefined) {
    this.target = target;
    this.inspect = inspect;
    this.calls = 0;
  }

  async *stream(request) {
    this.calls += 1;
    if (this.calls === 1) {
      yield* toolFragments('workspace-call', 'workspace.change', { path: this.target });
      return;
    }
    this.inspect(request);
    yield { type: 'text', text: 'Working directory changed and project guidance reloaded.' };
    yield { type: 'terminal', finishReason: 'stop', usage: null };
  }
}

class ApprovingReviewer {
  constructor(inspect = () => undefined) { this.inspect = inspect; }
  async review(input) {
    this.inspect(input);
    return { outcome: 'approve', confidence: 1, reason_code: 'authenticated_workspace_change' };
  }
}

test('workspace.change uses semantic review, rebases the conversation, and reloads AGENTS guidance', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nna-workspace-transition-'));
  const initial = join(parent, 'initial'); const target = join(parent, 'target');
  await mkdir(initial); await mkdir(target);
  await writeFile(join(initial, 'AGENTS.md'), 'INITIAL_GUIDANCE_ONLY');
  await writeFile(join(target, 'AGENTS.md'), 'TARGET_GUIDANCE_ONLY');
  const canonicalTarget = await realpath(target);
  let changed = null;
  const outputs = [];
  let secondRequest = null;
  const provider = new WorkspaceProvider(target, (request) => { secondRequest = request; });
  const semanticReviewer = new ApprovingReviewer((input) => {
    assert.equal(input.request.toolName, 'workspace.change');
    assert.equal(input.intentRelation, 'uncertain');
    assert.match(JSON.stringify(input.authenticatedIntent), /Move this conversation/u);
  });
  const engine = new SessionEngine({
    config: config(initial), providerFactory: () => provider, semanticReviewer,
    workspaceChanged: (event) => { changed = event; },
    output: async (event) => outputs.push(event),
  });
  await engine.initialize();
  const result = await engine.submit({
    request_id: 'workspace-turn', content: `Move this conversation into ${target} and continue there.`,
  }, 'authenticated-interactive-operator');
  assert.equal(result.outcome, 'completed', JSON.stringify({ result, outputs }));
  assert.equal(engine.config.workspaceRoot, canonicalTarget);
  assert.equal(engine.tools.paths.root, canonicalTarget);
  assert.equal(changed.workspaceRoot, canonicalTarget);
  const system = secondRequest.messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n');
  assert.match(system, /TARGET_GUIDANCE_ONLY/u);
  assert.doesNotMatch(system, /INITIAL_GUIDANCE_ONLY/u);
  assert.match(secondRequest.messages.find((item) => item.role === 'tool')?.content ?? '', /reload_before_next_model_step/u);
  assert.equal(engine.tools.providerSurface().receipt.selectedToolNames.includes('workspace.change'), true);
  const subagent = engine.tools.definition('agent.run');
  assert.equal((await subagent.validate({ type: 'general', task: 'inspect the project' })).resolved.path, canonicalTarget);
  await engine.shutdown({ type: 'shutdown', request_id: 'workspace-shutdown' });
});

test('a working directory transition invalidates sibling requests sealed under the prior directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nna-workspace-sibling-'));
  const initial = join(parent, 'initial'); const target = join(parent, 'target');
  await mkdir(initial); await mkdir(target);
  await writeFile(join(initial, 'prior.txt'), 'must not be read after the transition');
  let calls = 0;
  const provider = {
    async *stream() {
      calls += 1;
      if (calls === 1) {
        yield* toolBatchFragments([
          { id: 'workspace-change', name: 'workspace.change', args: { path: target } },
          { id: 'stale-read', name: 'fs.read', args: { path: 'prior.txt' } },
        ]);
        return;
      }
      yield { type: 'text', text: 'The directory changed; the stale sibling request was rejected.' };
      yield { type: 'terminal', finishReason: 'stop', usage: null };
    },
  };
  const engine = new SessionEngine({
    config: config(initial), providerFactory: () => provider,
    semanticReviewer: new ApprovingReviewer(),
  });
  await engine.initialize();
  const result = await engine.submit({
    request_id: 'workspace-sibling-turn',
    content: `Move this conversation into ${target}, then inspect the project there.`,
  }, 'authenticated-interactive-operator');
  assert.equal(result.outcome, 'blocked');
  assert.equal(engine.config.workspaceRoot, await realpath(target));
  const stale = engine.transcript.find((item) => item.type === 'tool_result'
    && item.providerCallId === 'stale-read');
  assert.equal(stale.toolLifecycleStatus, 'failed');
  assert.equal(stale.reasonCode, 'tool_revalidation_drift');
  assert.match(stale.content, /workspace/u);
  await engine.shutdown({ type: 'shutdown', request_id: 'workspace-sibling-shutdown' });
});

test('a queued runtime configuration remains ordered after a working directory transition', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nna-workspace-config-'));
  const initial = join(parent, 'initial'); const target = join(parent, 'target');
  await mkdir(initial); await mkdir(target);
  let releaseFirst; let signalFirst;
  const firstStarted = new Promise((resolve) => { signalFirst = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const profiles = [];
  let calls = 0;
  const providerFactory = (profile) => ({
    async *stream() {
      profiles.push(profile.model); calls += 1;
      if (calls === 1) {
        signalFirst(); await firstRelease;
        yield* toolFragments('workspace-config-change', 'workspace.change', { path: target });
        return;
      }
      yield { type: 'text', text: 'Both queued transitions were applied in order.' };
      yield { type: 'terminal', finishReason: 'stop', usage: null };
    },
  });
  const engine = new SessionEngine({
    config: config(initial), providerFactory, semanticReviewer: new ApprovingReviewer(),
  });
  await engine.initialize();
  const turn = engine.submit({
    request_id: 'workspace-config-turn', content: `Move this conversation into ${target}.`,
  }, 'authenticated-interactive-operator');
  await firstStarted;
  await engine.updateConfiguration({
    request_id: 'workspace-config-update',
    manifest: {
      persistence: 'ephemeral', workspace_root: initial,
      provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'updated', trust_zone: 'loopback' },
    },
  }, 'authenticated-interactive-operator');
  releaseFirst();
  assert.equal((await turn).outcome, 'completed');
  assert.deepEqual(profiles, ['fixture', 'updated']);
  assert.equal(engine.config.workspaceRoot, await realpath(target));
  assert.equal(engine.config.version, 3);
  await engine.shutdown({ type: 'shutdown', request_id: 'workspace-config-shutdown' });
});

test('workspace.change rejects missing directories without changing registry state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-workspace-invalid-'));
  const registry = new ToolRegistry(root, { workspaceControl: { change: async () => assert.fail('must not execute') } });
  await registry.initialize();
  const original = registry.paths.root;
  await assert.rejects(
    registry.definition('workspace.change').validate({ path: join(root, 'missing') }),
    { code: 'workspace_path_invalid' },
  );
  assert.equal(registry.paths.root, original);
  await registry.close();
});

test('change history remains attributable when the working directory changes', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nna-workspace-ledger-'));
  const initial = join(parent, 'initial'); const target = join(parent, 'target');
  await mkdir(initial); await mkdir(target);
  const priorPath = join(initial, 'prior.txt'); const targetPath = join(target, 'current.txt');
  const ledger = new FileChangeLedger(initial);
  ledger.record(priorPath, 'before', 'after', 'fs.write_text');
  ledger.rebase(target);
  ledger.record(targetPath, null, 'created', 'fs.write_text');
  const snapshot = ledger.snapshot();
  assert.equal(snapshot[0].path, priorPath.replaceAll('\\', '/'));
  assert.equal(snapshot[1].path, 'current.txt');
});

test('workspace.change is unavailable under an authenticated host capability ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-workspace-hosted-'));
  const registry = new ToolRegistry(root, {
    hosted: true, boundedToWorkspace: true, allowedTools: ['workspace.change'],
    workspaceControl: { change: async () => assert.fail('must not execute') },
  });
  await registry.initialize();
  assert.equal(registry.definition('workspace.change'), undefined);
  await registry.close();
});

test('durable session recovery restores the last reviewed working directory', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nna-workspace-restore-'));
  const initial = join(parent, 'initial'); const target = join(parent, 'target');
  await mkdir(initial); await mkdir(target);
  await writeFile(join(target, 'AGENTS.md'), 'RESTORED_TARGET_GUIDANCE');
  const sessionId = 'workspace-restore-session';
  const options = {
    config: config(initial, 'durable'), sessionId,
    storeRoot: join(parent, 'sessions'), reviewerRoot: join(parent, 'reviewers'),
    governanceRoot: join(parent, 'governance'), telemetryRoot: join(parent, 'telemetry'),
  };
  const provider = new WorkspaceProvider(target);
  const first = new SessionEngine({
    ...options, providerFactory: () => provider, semanticReviewer: new ApprovingReviewer(),
  });
  await first.initialize();
  assert.equal((await first.submit({
    request_id: 'durable-workspace-turn', content: `Move this conversation into ${target}.`,
  }, 'authenticated-interactive-operator')).outcome, 'completed');
  await first.shutdown({ type: 'shutdown', request_id: 'first-shutdown' });

  const recovered = new SessionEngine({
    ...options, providerFactory: () => ({ async *stream() { yield { type: 'terminal', finishReason: 'stop' }; } }),
  });
  await recovered.initialize();
  assert.equal(recovered.config.workspaceRoot, await realpath(target));
  assert.equal(recovered.tools.paths.root, await realpath(target));
  assert.match((await recovered.projectGuidance.resolve()).map((item) => item.content).join('\n'), /RESTORED_TARGET_GUIDANCE/u);
  await recovered.shutdown({ type: 'shutdown', request_id: 'recovered-shutdown' });
});

test('a reviewed working directory transition changes only the active Console tab', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nna-workspace-tabs-'));
  const initial = join(parent, 'initial'); const target = join(parent, 'target');
  await mkdir(initial); await mkdir(target);
  const provider = {
    async *stream(request) {
      const hasResult = request.messages.some((item) => item.role === 'tool');
      if (!hasResult) { yield* toolFragments('tab-workspace-call', 'workspace.change', { path: target }); return; }
      yield { type: 'text', text: 'Tab working directory changed.' };
      yield { type: 'terminal', finishReason: 'stop' };
    },
  };
  const workspace = new ExperienceEngine({
    config: config(initial), providerFactory: () => provider, semanticReviewer: new ApprovingReviewer(),
    storeRoot: join(parent, 'sessions'), reviewerRoot: join(parent, 'reviewers'),
    dataPaths: { root: join(parent, 'data'), sessions: join(parent, 'sessions'), projects: join(parent, 'telemetry') },
  });
  const mainId = await workspace.create('Main', 'main', { main: true });
  const otherId = await workspace.create('Other', 'other');
  workspace.switch(otherId);
  await workspace.submitActive(`Move this conversation into ${target}.`);
  assert.equal(workspace.sessions.get(mainId).engine.config.workspaceRoot, await realpath(initial));
  assert.equal(workspace.sessions.get(otherId).engine.config.workspaceRoot, await realpath(target));
  assert.equal(workspace.projection.sessions.get(otherId).metadata.workspace, await realpath(target));
  const records = tabPoolRecords(workspace.sessions, workspace.projection);
  assert.equal(records.find((item) => item.sessionId === mainId).manifest.workspace_root, await realpath(initial));
  assert.equal(records.find((item) => item.sessionId === otherId).manifest.workspace_root, await realpath(target));
  await workspace.shutdown();
});

function config(workspaceRoot, persistence = 'ephemeral') {
  return resolveManifest({
    persistence, workspace_root: workspaceRoot,
    provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' },
  });
}

function toolFragments(id, name, args) {
  const json = JSON.stringify(args);
  return [
    { type: 'tool_fragment', fragments: [{ index: 0, id, function: { name, arguments: json } }] },
    { type: 'terminal', finishReason: 'tool_calls', usage: null },
  ];
}

function toolBatchFragments(calls) {
  return [
    {
      type: 'tool_fragment',
      fragments: calls.map((call, index) => ({
        index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    },
    { type: 'terminal', finishReason: 'tool_calls', usage: null },
  ];
}
