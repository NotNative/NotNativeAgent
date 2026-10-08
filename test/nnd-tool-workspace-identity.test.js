// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventHub } from '../src/events.js';
import { resolveManifest } from '../src/config.js';
import { SessionEngine } from '../src/engine.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { ToolGovernor, toolSettlementTerminal } from '../src/tools/governor.js';
import { requestDigest } from '../src/persistence/reviewer-ledger.js';
import { nndToolWorkspaceIdentityCheck, primaryNndWorkspaceBinding } from '../src/nnd-workspace-binding.js';

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'nna-nnd-tool-root-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, 'workspace'); await mkdir(root);
  const engine = { config: { workspaceRoot: root } };
  const binding = await primaryNndWorkspaceBinding(root);
  const resolver = () => primaryNndWorkspaceBinding(root);
  const registry = new ToolRegistry(root, {
    workspaceIdentityCheck: nndToolWorkspaceIdentityCheck(engine, binding, resolver),
  });
  await registry.initialize();
  t.after(() => registry.close());
  const replace = async () => { await rename(root, join(parent, 'original')); await mkdir(root); };
  return { parent, root, engine, binding, resolver, registry, replace };
}

const context = { policyVersion: 'test-policy', authority: { id: 'test-authority', version: 1,
  restrictionVersion: 0 }, stepId: 'test-step', caller: 'primary', surface: 'nnd' };
function approval(request) {
  return { id: `decision-${request.providerCallId}`, outcome: 'approve', requestId: request.id,
    requestDigest: requestDigest(request), authorityId: request.authorityId,
    authorityVersion: request.authorityVersion, authorityRestrictionVersion: 0,
    policyVersion: request.policyVersion, expiresAt: Date.now() + 60_000 };
}
function governor(registry) {
  const started = [], settled = [];
  const ledger = {
    async executionStarted(requestId, decisionId) { started.push({ requestId, decisionId }); },
    async settle(requestId, terminal) { settled.push({ requestId, terminal }); return terminal; },
    execution: requestId => ({ decisionId: started.find(item => item.requestId === requestId)?.decisionId }),
  };
  return { value: new ToolGovernor({ events: new EventHub(), reviewer: { ledger }, registry }), started, settled };
}

test('replaced native workspace blocks sealing before reviewer admission', async t => {
  const f = await fixture(t);
  await f.replace();
  await assert.rejects(f.registry.seal({ providerCallId: 'write-after-swap', name: 'fs_write_text',
    args: { path: 'new.txt', content: 'unsafe' } }, context), { code: 'tool_revalidation_drift' });
  await assert.rejects(readFile(join(f.root, 'new.txt')), { code: 'ENOENT' });
});

test('NND child engines inherit the same immutable native workspace check', async t => {
  const f = await fixture(t);
  const config = resolveManifest({ persistence: 'ephemeral', workspace_root: f.root,
    provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' } });
  const parent = new SessionEngine({ config, surface: 'nnd', workspaceBinding: f.binding,
    workspaceBindingResolver: f.resolver });
  const child = new SessionEngine({ ...parent.subagentOptions, config, surface: 'nnd_subagent', subagentDepth: 1 });
  const consoleEngine = new SessionEngine({ config, surface: 'interactive_tui' });
  assert.equal(parent.subagentOptions.workspaceBinding, f.binding);
  await f.replace();
  await assert.rejects(parent.tools.assertWorkspaceIdentity(), { code: 'tool_revalidation_drift' });
  await assert.rejects(child.tools.assertWorkspaceIdentity(), { code: 'tool_revalidation_drift' });
  await assert.doesNotReject(consoleEngine.tools.assertWorkspaceIdentity());
});

test('NND parent and child tools cannot read a sibling root while the TUI retains host scope', async t => {
  const f = await fixture(t);
  const sibling = join(f.parent, 'sibling.txt');
  await writeFile(sibling, 'sibling-secret');
  const config = resolveManifest({ persistence: 'ephemeral', workspace_root: f.root,
    provider: { id: 'fixture', endpoint: 'http://127.0.0.1:9999/v1', model: 'fixture', trust_zone: 'loopback' } });
  const parent = new SessionEngine({ config, surface: 'nnd', workspaceBinding: f.binding,
    workspaceBindingResolver: f.resolver });
  const child = new SessionEngine({ ...parent.subagentOptions, config, surface: 'nnd_subagent', subagentDepth: 1 });
  const consoleEngine = new SessionEngine({ config, surface: 'interactive_tui' });
  await Promise.all([parent.tools.initialize(), child.tools.initialize(), consoleEngine.tools.initialize()]);
  t.after(() => { parent.tools.close(); child.tools.close(); consoleEngine.tools.close(); });
  for (const engine of [parent, child]) {
    await assert.rejects(engine.tools.definition('fs_read').validate({ path: sibling }));
  }
  await assert.doesNotReject(consoleEngine.tools.definition('fs_read').validate({ path: sibling }));
});

test('replaced native workspace blocks execution before the reviewer ledger starts', async t => {
  const f = await fixture(t);
  const request = await f.registry.seal({ providerCallId: 'write-before-review', name: 'fs_write_text',
    args: { path: 'new.txt', content: 'unsafe' } }, context);
  const g = governor(f.registry);
  await f.replace();
  await assert.rejects(g.value.beginExecution(request, approval(request), {
    authority: context.authority, policyVersion: context.policyVersion, workspaceRoot: f.root,
  }), { code: 'tool_revalidation_drift' });
  assert.deepEqual(g.started, []);
  await assert.rejects(readFile(join(f.root, 'new.txt')), { code: 'ENOENT' });
});

test('a swap after reviewed execution starts stops file, process, and shell executors with no effect',
  { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const file = join(f.root, 'file-effect.txt');
    const processMarker = join(f.root, 'process-effect.txt');
    const shellMarker = join(f.root, 'shell-effect.txt');
    const calls = [
      { name: 'fs_write_text', args: { path: file, content: 'unsafe' } },
      { name: 'process_run', args: { executable: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(processMarker)},'unsafe')`], cwd: f.root } },
      { name: 'shell_run', args: { script: `Set-Content -LiteralPath '${shellMarker.replaceAll("'", "''")}' -Value unsafe`,
        shell: 'powershell', cwd: f.root } },
    ];
    const g = governor(f.registry);
    const requests = [];
    for (const [index, call] of calls.entries()) {
      const request = await f.registry.seal({ providerCallId: `approved-${index}`, ...call }, context);
      requests.push(request);
      await g.value.beginExecution(request, approval(request), {
        authority: context.authority, policyVersion: context.policyVersion, workspaceRoot: f.root,
      });
    }
    assert.equal(g.started.length, 3);
    await f.replace();
    for (const request of requests) {
      const result = await g.value.executePrepared(request, approval(request), new AbortController().signal);
      assert.equal(result.status, 'failed');
      assert.equal(result.reason_code, 'tool_revalidation_drift');
      assert.equal(result.effect_certainty, 'none');
      await g.value.reconcile(request.id, toolSettlementTerminal(result));
    }
    assert.equal(g.settled.length, 3);
    for (const path of [file, processMarker, shellMarker]) {
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    }
  });
