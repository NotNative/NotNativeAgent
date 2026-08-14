// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '../src/config.js';
import { ExperienceEngine as InteractiveWorkspace } from '../src/experience-engine.js';
import { handleMemoryCommand } from '../src/tui-memory-command.js';

function configuration(root, enabled = true) {
  return resolveManifest({
    persistence: 'ephemeral', workspace_root: root,
    provider: { id: 'local', endpoint: 'http://127.0.0.1:9/v1', model: 'test', trust_zone: 'loopback' },
    memory: { enabled, timeout_ms: 1000 },
  });
}

test('AC-MEM-03 memory Console inspects, explicitly saves, and version-deletes without model mediation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-memory-console-'));
  const calls = [];
  const memoryAdapter = {
    async health() { return { status: 'ready', adapter: 'test' }; },
    async inspect(scope) { calls.push(['inspect', scope]); return [{ id: 'm1', content: 'preference', version: '2' }]; },
    async save(record) { calls.push(['save', record]); return { id: record.id, version: '1' }; },
    async delete(record) { calls.push(['delete', record]); return { deleted: record.id }; },
  };
  const workspace = new InteractiveWorkspace({ config: configuration(root), memoryAdapter });
  await workspace.create('Main', 'main');

  await handleMemoryCommand('', workspace);
  assert.equal(workspace.projection.overlay.kind, 'memory');
  assert.match(workspace.projection.overlay.lines.join('\n'), /status: ready/u);
  await handleMemoryCommand('save Always run focused tests first.', workspace);
  assert.equal(calls.find((item) => item[0] === 'save')[1].content, 'Always run focused tests first.');
  await handleMemoryCommand('delete m1 2', workspace);
  assert.equal(calls.find((item) => item[0] === 'delete')[1].expectedVersion, '2');
  await workspace.shutdown();
});

test('memory Console surface reports configured integration without an adapter truthfully', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-memory-unavailable-'));
  const workspace = new InteractiveWorkspace({ config: configuration(root) });
  await workspace.create('Main', 'main');
  await handleMemoryCommand('inspect', workspace);
  assert.match(workspace.projection.overlay.lines.join('\n'), /adapter_unavailable/u);
  await assert.rejects(handleMemoryCommand('save value', workspace), { code: 'memory_disabled' });
  await workspace.shutdown();
});

test('memory Console surface rejects secret-like explicit memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-memory-secret-'));
  const memoryAdapter = { async save() { throw new Error('must not be called'); } };
  const workspace = new InteractiveWorkspace({ config: configuration(root), memoryAdapter });
  await workspace.create('Main', 'main');
  await assert.rejects(handleMemoryCommand('save api_key=super-secret-value', workspace), { code: 'memory_secret_rejected' });
  await workspace.shutdown();
});
