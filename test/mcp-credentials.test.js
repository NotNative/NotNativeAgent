// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteManagedMcpCredential, loadManagedMcpCredentials, managedMcpCredentialReference,
  saveManagedMcpCredential,
} from '../src/mcp-credentials.js';

test('managed MCP credentials persist outside configuration and load into a runtime environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-credentials-'));
  const paths = { mcpCredentials: join(root, 'config', 'mcp-credentials.json') };
  const environment = {};
  const reference = await saveManagedMcpCredential(paths, 'NotNative Memory', 'secret-token', environment);
  assert.equal(reference, managedMcpCredentialReference('NotNative Memory'));
  assert.equal(environment[reference], 'secret-token');
  assert.match(await readFile(paths.mcpCredentials, 'utf8'), /secret-token/u);
  const restored = {};
  assert.equal(await loadManagedMcpCredentials(paths, restored), 1);
  assert.equal(restored[reference], 'secret-token');
  assert.equal(await deleteManagedMcpCredential(paths, reference, restored), true);
  assert.equal(restored[reference], undefined);
  assert.doesNotMatch(await readFile(paths.mcpCredentials, 'utf8'), /secret-token/u);
});

test('managed MCP credential storage rejects multiline secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-credentials-invalid-'));
  const paths = { mcpCredentials: join(root, 'credentials.json') };
  await assert.rejects(saveManagedMcpCredential(paths, 'memory', 'first\nsecond', {}), { code: 'mcp_token_invalid' });
});

test('concurrent managed MCP credential saves preserve both updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nna-mcp-credentials-concurrent-'));
  const paths = { mcpCredentials: join(root, 'credentials.json') };
  await Promise.all([
    saveManagedMcpCredential(paths, 'one', 'first-secret', {}),
    saveManagedMcpCredential(paths, 'two', 'second-secret', {}),
  ]);
  const restored = {};
  assert.equal(await loadManagedMcpCredentials(paths, restored), 2);
  assert.equal(Object.keys(restored).length, 2);
});
